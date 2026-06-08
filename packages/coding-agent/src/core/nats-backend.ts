/**
 * NATS JetStream-backed {@link SessionBackend} implementation.
 *
 * Each session is persisted as an ordered sequence of JetStream messages
 * under the subject `<subjectPrefix>.<sessionId>`. All sessions share a
 * single stream (default name `pi-sessions`) configured for limits-based
 * retention with file storage — this gives us:
 *
 * - Strict per-session ordering (JetStream preserves publish order per subject).
 * - Replay-from-zero via an ordered consumer scoped to the session's subject.
 * - Durability across agent restarts (state lives on the NATS server, not the agent).
 * - Cross-host visibility for distributed deployments (multiple agents
 *   replaying the same session).
 *
 * # Wire format
 *
 * Each {@link SessionHeader} or {@link SessionEntry} is JSON-encoded and
 * published as the message payload. The first message in a session subject
 * MUST be a header (the {@link createSession} method enforces this via the
 * `Nats-Expected-Last-Subject-Sequence: 0` constraint), so any subsequent
 * read can reliably distinguish header from body without inspecting payload
 * shape.
 *
 * # Why JetStream stream + ordered consumer (not KV)
 *
 * NATS KV gives last-value semantics per key — fine for the header but
 * lossy for append-only entries (we'd lose history). JetStream KV «history»
 * caps at 64 entries, far below what a real coding session needs. The raw
 * stream model with a per-subject ordered consumer is what we want:
 * unbounded ordered append + cheap full replay.
 */

import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { jetstream, jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import type { SessionBackend } from "./session-backend.ts";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-manager.ts";

/** Connection + stream configuration for {@link NatsBackend}. */
export interface NatsBackendOptions {
	/** NATS server URL (e.g. `nats://localhost:4222`). */
	url: string;
	/** Stream name. Defaults to `pi-sessions`. */
	streamName?: string;
	/**
	 * Subject prefix used to derive per-session subjects.
	 * Session N is stored under `<subjectPrefix>.<N>`.
	 * Defaults to `pi.session`.
	 */
	subjectPrefix?: string;
	/**
	 * If true (default), create the stream on first use if missing. Set to
	 * false for production deployments where ops provisions streams out of
	 * band.
	 */
	createStreamIfMissing?: boolean;
}

const DEFAULT_STREAM_NAME = "pi-sessions";
const DEFAULT_SUBJECT_PREFIX = "pi.session";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Build the JetStream subject for a session.
 *
 * Session IDs are alphanumeric per Pi's {@link assertValidSessionId} (no
 * dots or wildcards), so no escaping is required.
 */
function sessionSubject(prefix: string, sessionId: string): string {
	return `${prefix}.${sessionId}`;
}

/**
 * Open a {@link NatsBackend} against a NATS server.
 *
 * Performs the connection handshake, ensures the JetStream stream exists
 * (when `createStreamIfMissing` is true), and returns a ready-to-use
 * backend. Caller MUST eventually call {@link NatsBackend#close} to
 * release the underlying connection.
 */
export async function openNatsBackend(options: NatsBackendOptions): Promise<NatsBackend> {
	const streamName = options.streamName ?? DEFAULT_STREAM_NAME;
	const subjectPrefix = options.subjectPrefix ?? DEFAULT_SUBJECT_PREFIX;
	const createIfMissing = options.createStreamIfMissing ?? true;

	const nc = await connect({ servers: options.url });
	const jsm = await jetstreamManager(nc);
	const js = jetstream(nc);

	if (createIfMissing) {
		const subjectWildcard = `${subjectPrefix}.>`;
		try {
			await jsm.streams.info(streamName);
		} catch {
			await jsm.streams.add({
				name: streamName,
				subjects: [subjectWildcard],
				retention: RetentionPolicy.Limits,
				storage: StorageType.File,
				max_msgs_per_subject: -1,
				max_msgs: -1,
				max_bytes: -1,
				max_age: 0,
				allow_direct: true,
			});
		}
	}

	return new NatsBackend(nc, jsm, js, streamName, subjectPrefix);
}

/**
 * JetStream-backed session backend.
 *
 * Instantiate via {@link openNatsBackend} — direct construction requires
 * pre-wired NATS handles and is only used by the open() helper and tests.
 */
export class NatsBackend implements SessionBackend {
	/** Per-session write queue: each write awaits the prior one for the same id. */
	private writeQueues: Map<string, Promise<unknown>> = new Map();
	/** Latched once close() begins so flush/close become idempotent no-ops. */
	private closed = false;
	private readonly nc: NatsConnection;
	private readonly jsm: JetStreamManager;
	private readonly js: JetStreamClient;
	private readonly streamName: string;
	private readonly subjectPrefix: string;

	constructor(
		nc: NatsConnection,
		jsm: JetStreamManager,
		js: JetStreamClient,
		streamName: string,
		subjectPrefix: string,
	) {
		this.nc = nc;
		this.jsm = jsm;
		this.js = js;
		this.streamName = streamName;
		this.subjectPrefix = subjectPrefix;
	}

	/**
	 * Serialize a write op against the per-session queue. Same shape as
	 * {@link FsBackend#enqueue} — see that doc for rationale.
	 */
	private enqueue<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
		const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
		const next = prev.then(op, op);
		this.writeQueues.set(
			sessionId,
			next.catch(() => undefined),
		);
		return next;
	}

	private subject(sessionId: string): string {
		return sessionSubject(this.subjectPrefix, sessionId);
	}

	private encode(value: unknown): Uint8Array {
		return textEncoder.encode(JSON.stringify(value));
	}

	private decode(data: Uint8Array): unknown {
		return JSON.parse(textDecoder.decode(data));
	}

	async createSession(header: SessionHeader): Promise<void> {
		return this.enqueue(header.id, async () => {
			const subject = this.subject(header.id);
			// Refuse to clobber an existing session: publish with the
			// «expect prior subject sequence = 0» constraint so the server
			// rejects if any message already exists under this subject.
			try {
				await this.js.publish(subject, this.encode(header), {
					expect: { lastSubjectSequence: 0 },
				});
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (
					msg.includes("wrong last sequence") ||
					msg.includes("expected last sequence") ||
					msg.includes("10071")
				) {
					throw new Error(`NatsBackend: session ${header.id} already exists`);
				}
				throw err;
			}
		});
	}

	async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
		return this.enqueue(sessionId, async () => {
			await this.js.publish(this.subject(sessionId), this.encode(entry));
		});
	}

	async readAll(sessionId: string): Promise<FileEntry[]> {
		// Drain pending writes for this session first so readAll observes them.
		await (this.writeQueues.get(sessionId) ?? Promise.resolve());
		const subject = this.subject(sessionId);

		// Use stream info with subjects_filter to learn how many messages
		// the session has — also tells us if the session exists at all.
		let subjectMsgCount = 0;
		try {
			const info = await this.jsm.streams.info(this.streamName, { subjects_filter: subject });
			const subjectState = info.state.subjects ?? {};
			subjectMsgCount = subjectState[subject] ?? 0;
		} catch {
			return [];
		}
		if (subjectMsgCount === 0) return [];

		// Create an ephemeral ordered consumer scoped to this subject and
		// fetch all messages.
		const consumer = await this.js.consumers.get(this.streamName, {
			filter_subjects: subject,
		});
		const entries: FileEntry[] = [];
		const iter = await consumer.fetch({ max_messages: subjectMsgCount, expires: 5_000 });
		try {
			for await (const msg of iter) {
				entries.push(this.decode(msg.data) as FileEntry);
				if (entries.length >= subjectMsgCount) break;
			}
		} finally {
			// Best-effort: stop iter to release resources promptly.
			try {
				await (iter as unknown as { close?: () => Promise<void> }).close?.();
			} catch {
				// Ignore — ordered consumers are ephemeral and auto-clean.
			}
		}
		return entries;
	}

	async rewrite(sessionId: string, header: SessionHeader, entries: SessionEntry[]): Promise<void> {
		return this.enqueue(sessionId, async () => {
			const subject = this.subject(sessionId);
			try {
				await this.jsm.streams.purge(this.streamName, { filter: subject });
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!msg.includes("no messages")) throw err;
			}
			await this.js.publish(subject, this.encode(header));
			for (const entry of entries) {
				await this.js.publish(subject, this.encode(entry));
			}
		});
	}

	async delete(sessionId: string): Promise<void> {
		await this.enqueue(sessionId, async () => {
			const subject = this.subject(sessionId);
			try {
				await this.jsm.streams.purge(this.streamName, { filter: subject });
			} catch (err) {
				const msg = (err as Error).message ?? "";
				// Tolerate «no messages match» — purging a never-existed subject is a no-op.
				if (!msg.includes("no messages")) throw err;
			}
		});
		this.writeQueues.delete(sessionId);
	}

	async flush(): Promise<void> {
		const pending = Array.from(this.writeQueues.values());
		await Promise.all(pending.map((p) => p.catch(() => undefined)));
		// Skip the connection-level flush once we've started shutting down;
		// the NATS client rejects flush() on a closed/draining connection.
		if (this.closed) return;
		await this.nc.flush();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		// Drain in-flight per-session work first, then latch so the
		// subsequent flush()/drain() short-circuit on idempotent re-entry.
		const pending = Array.from(this.writeQueues.values());
		await Promise.all(pending.map((p) => p.catch(() => undefined)));
		try {
			await this.nc.flush();
		} catch {
			// Tolerate flush-on-already-closing connections — drain() below
			// handles the actual teardown.
		}
		this.closed = true;
		this.writeQueues.clear();
		await this.nc.drain();
	}
}
