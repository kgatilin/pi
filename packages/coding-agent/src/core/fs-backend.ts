/**
 * Filesystem-backed {@link SessionBackend} implementation.
 *
 * Stores each session as an append-only JSONL file. Preserves the persistence
 * semantics previously inlined in SessionManager: append-only writes, full-file
 * rewrite on migration/branching, exclusive-create on first flush.
 *
 * # Async + per-session ordering
 *
 * All write methods return Promises that resolve after the underlying
 * `fs/promises` operation completes. To preserve append-order guarantees
 * under concurrent callers, FsBackend maintains a chained promise per session
 * — every new write is `await`-ed against the previous write for the same
 * sessionId. Different sessions write concurrently.
 *
 * This implementation is the default backend and is what self-hosted Pi
 * users get out of the box. Alternative backends ({@link NatsBackend} for
 * distributed deployments, future Postgres) can replace it without changing
 * SessionManager.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizePath } from "../utils/paths.ts";
import type { SessionBackend } from "./session-backend.ts";
import { type FileEntry, loadEntriesFromFile, type SessionEntry, type SessionHeader } from "./session-manager.ts";

/**
 * Filesystem session backend.
 *
 * Maintains an in-memory map from sessionId -> file path. SessionManager
 * registers the path for a session via {@link registerSessionPath} before
 * calling any other method. This keeps the {@link SessionBackend} interface
 * uniform across implementations while letting FsBackend honour explicit
 * file paths (e.g. from `--session` flag or branched sessions).
 */
export class FsBackend implements SessionBackend {
	private pathsBySessionId: Map<string, string> = new Map();
	/** Per-session write queue: each write awaits the prior one for the same id. */
	private writeQueues: Map<string, Promise<unknown>> = new Map();

	/**
	 * Register the filesystem path for a session. Must be called before any
	 * other backend method for that session. Subsequent calls with the same
	 * sessionId replace the registered path (used when SessionManager
	 * switches files via setSessionFile or createBranchedSession).
	 */
	registerSessionPath(sessionId: string, filePath: string): void {
		this.pathsBySessionId.set(sessionId, normalizePath(filePath));
	}

	/** Get the registered path for a session, throwing if unknown. */
	private getPath(sessionId: string): string {
		const path = this.pathsBySessionId.get(sessionId);
		if (!path) {
			throw new Error(`FsBackend: no path registered for session ${sessionId}`);
		}
		return path;
	}

	/** Look up the path for a session if registered; return undefined otherwise. */
	tryGetPath(sessionId: string): string | undefined {
		return this.pathsBySessionId.get(sessionId);
	}

	/**
	 * Serialize a write operation against the per-session queue, so that
	 * concurrent callers see their writes appended in submission order even
	 * though the underlying `fs/promises` calls are async.
	 *
	 * The returned promise resolves with the operation's result and rejects
	 * if the operation throws. The internal queue stores a never-rejecting
	 * tail so one failure does not poison subsequent writes.
	 */
	private enqueue<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
		const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
		const next = prev.then(op, op); // run op after prev whether prev resolved or rejected
		// Park a never-rejecting tail so one failed write doesn't kill the queue.
		this.writeQueues.set(
			sessionId,
			next.catch(() => undefined),
		);
		return next;
	}

	async createSession(header: SessionHeader): Promise<void> {
		const path = this.getPath(header.id);
		return this.enqueue(header.id, async () => {
			const dir = dirname(path);
			if (dir) {
				await mkdir(dir, { recursive: true });
			}
			// Exclusive create so we never silently clobber an existing file.
			await writeFile(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
		});
	}

	async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
		const path = this.getPath(sessionId);
		return this.enqueue(sessionId, async () => {
			await appendFile(path, `${JSON.stringify(entry)}\n`);
		});
	}

	async readAll(sessionId: string): Promise<FileEntry[]> {
		const path = this.pathsBySessionId.get(sessionId);
		if (!path) return [];
		// Drain pending writes for this session first so readAll observes them.
		await (this.writeQueues.get(sessionId) ?? Promise.resolve());
		return loadEntriesFromFile(path);
	}

	async rewrite(sessionId: string, header: SessionHeader, entries: SessionEntry[]): Promise<void> {
		const path = this.getPath(sessionId);
		return this.enqueue(sessionId, async () => {
			const dir = dirname(path);
			if (dir) {
				await mkdir(dir, { recursive: true });
			}
			const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n");
			await writeFile(path, `${lines}\n`);
		});
	}

	async delete(sessionId: string): Promise<void> {
		const path = this.pathsBySessionId.get(sessionId);
		if (!path) return;
		await this.enqueue(sessionId, async () => {
			try {
				await unlink(path);
			} catch (err) {
				// Tolerate missing files; surface other errors.
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					throw err;
				}
			}
		});
		this.pathsBySessionId.delete(sessionId);
		this.writeQueues.delete(sessionId);
	}

	async flush(): Promise<void> {
		// Snapshot to avoid mutation during iteration.
		const pending = Array.from(this.writeQueues.values());
		await Promise.all(pending.map((p) => p.catch(() => undefined)));
	}

	async close(): Promise<void> {
		await this.flush();
		this.pathsBySessionId.clear();
		this.writeQueues.clear();
	}

	/**
	 * Synchronously rewrite a session file (header + entries).
	 *
	 * Exists as an escape hatch for SessionManager's recovery/migration paths
	 * (corrupted-file truncation, v1→v3 migration, branched-session seed)
	 * where the existing Pi test contract observes the file on disk *immediately*
	 * after the SessionManager constructor returns. Those callers cannot await
	 * the async rewrite without changing the public sync surface, so we use
	 * sync fs here. Normal append/createSession traffic still goes through the
	 * async path.
	 *
	 * No-op for sessionIds whose path is not registered.
	 */
	rewriteSync(sessionId: string, header: SessionHeader, entries: SessionEntry[]): void {
		const path = this.pathsBySessionId.get(sessionId);
		if (!path) return;
		const dir = dirname(path);
		if (dir) {
			mkdirSync(dir, { recursive: true });
		}
		const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n");
		writeFileSync(path, `${lines}\n`);
	}

	/**
	 * Synchronously append a single entry to a session file.
	 *
	 * Pairs with {@link rewriteSync} as the sync escape hatch SessionManager
	 * uses on FsBackend to preserve the existing Pi test contract: tests
	 * observe the file on disk immediately after the call that appended,
	 * without awaiting any flush. No-op if no path is registered.
	 */
	appendEntrySync(sessionId: string, entry: SessionEntry): void {
		const path = this.pathsBySessionId.get(sessionId);
		if (!path) return;
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	}
}
