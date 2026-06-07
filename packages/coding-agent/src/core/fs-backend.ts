/**
 * Filesystem-backed SessionBackend implementation.
 *
 * Stores each session as an append-only JSONL file. Preserves the exact
 * persistence behavior previously inlined in SessionManager: append-only
 * writes, full-file rewrite on migration/branching, exclusive-create on
 * first flush, etc.
 *
 * This implementation is the default backend and is what self-hosted Pi
 * users get out of the box. Alternative backends (Postgres for n8n EE,
 * NATS for distributed deployments) can replace it without changing
 * SessionManager.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizePath } from "../utils/paths.ts";
import type { SessionBackend } from "./session-backend.ts";
import { type FileEntry, loadEntriesFromFile, type SessionEntry, type SessionHeader } from "./session-manager.ts";

/**
 * Filesystem session backend.
 *
 * Maintains an in-memory map from sessionId -> file path. SessionManager
 * registers the path for a session via {@link registerSessionPath} before
 * calling any other method. This keeps the SessionBackend interface
 * uniform across implementations while letting FsBackend honour explicit
 * file paths (e.g. from `--session` flag or branched sessions).
 */
export class FsBackend implements SessionBackend {
	private pathsBySessionId: Map<string, string> = new Map();

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

	createSession(header: SessionHeader): void {
		const path = this.getPath(header.id);
		const dir = dirname(path);
		if (dir && !existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		// Exclusive create so we never silently clobber an existing file.
		writeFileSync(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
	}

	appendEntry(sessionId: string, entry: SessionEntry): void {
		const path = this.getPath(sessionId);
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	}

	readAll(sessionId: string): FileEntry[] {
		const path = this.pathsBySessionId.get(sessionId);
		if (!path) return [];
		return loadEntriesFromFile(path);
	}

	rewrite(sessionId: string, header: SessionHeader, entries: SessionEntry[]): void {
		const path = this.getPath(sessionId);
		const dir = dirname(path);
		if (dir && !existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const fd = openSync(path, "w");
		try {
			writeFileSync(fd, `${JSON.stringify(header)}\n`);
			for (const entry of entries) {
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			}
		} finally {
			closeSync(fd);
		}
	}

	delete(sessionId: string): void {
		const path = this.pathsBySessionId.get(sessionId);
		if (!path) return;
		try {
			unlinkSync(path);
		} catch (err) {
			// Tolerate missing files; surface other errors.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				throw err;
			}
		}
		this.pathsBySessionId.delete(sessionId);
	}
}
