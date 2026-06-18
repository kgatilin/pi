/**
 * Storage backend abstraction for session persistence.
 *
 * SessionManager delegates all session I/O to a SessionBackend implementation.
 * The default implementation is {@link FsBackend} (JSONL files on disk). Alternative
 * backends ({@link NatsBackend}, future Postgres, etc.) can be plugged in for
 * distributed deployments without changing SessionManager logic.
 *
 * # Async-first interface
 *
 * All write/read methods return Promises. This is required because the primary
 * distributed backend — NATS JetStream — is fundamentally async (every publish
 * is a network round-trip awaiting a PubAck), and the previous sync interface
 * could not express that without blocking the event loop or losing delivery
 * guarantees.
 *
 * SessionManager keeps its sync surface by treating writes as fire-and-forget:
 * it kicks off the Promise and lets the backend serialize writes internally
 * (the FsBackend uses a per-session chained-promise queue). A {@link SessionBackend#flush}
 * method is exposed for tests and shutdown paths that need durable-on-disk
 * (or durable-on-server) guarantees before continuing.
 */

import type { FileEntry, SessionEntry, SessionHeader } from "./session-manager.ts";

/**
 * Per-session storage backend.
 *
 * All methods key off `sessionId`. Backends are expected to maintain their
 * own mapping from sessionId to underlying storage (file path, JetStream
 * stream name, database key, etc.).
 *
 * Implementations MUST serialize concurrent writes for the same sessionId so
 * that {@link SessionBackend#readAll} reflects writes in submission order. The
 * easiest way is a per-session promise chain (see {@link FsBackend}).
 */
export interface SessionBackend {
	/**
	 * Create a new session and write its header. Implementations are
	 * responsible for ensuring the underlying storage location exists.
	 *
	 * For {@link FsBackend}, the caller must first call
	 * {@link FsBackend#registerSessionPath} so the backend knows where to
	 * write. This keeps the cross-backend interface clean while letting
	 * FsBackend honour explicit file paths chosen by SessionManager
	 * (e.g. from `--session` flag or `createBranchedSession`).
	 *
	 * For NATS-backed implementations, the stream is created lazily on
	 * first publish; no pre-registration is needed.
	 *
	 * MUST reject if a session with the same id already exists (no silent
	 * clobber).
	 */
	createSession(header: SessionHeader): Promise<void>;

	/**
	 * Append a single entry to an existing session.
	 *
	 * For {@link FsBackend} this is an append to the JSONL file. For NATS
	 * backends this is a publish to the session's JetStream subject.
	 *
	 * Order is preserved per session: concurrent calls for the same
	 * sessionId resolve in submission order.
	 */
	appendEntry(sessionId: string, entry: SessionEntry): Promise<void>;

	/**
	 * Read all entries (header + body) for a session, in stored order.
	 *
	 * Returns an empty array if the session does not exist or the storage
	 * location is empty.
	 */
	readAll(sessionId: string): Promise<FileEntry[]>;

	/**
	 * Atomically rewrite a session from scratch.
	 *
	 * Used for migrations and for session-branch creation. Replaces any
	 * existing content with the provided header + entries.
	 */
	rewrite(sessionId: string, header: SessionHeader, entries: SessionEntry[]): Promise<void>;

	/**
	 * Delete a session's storage entirely. No-op if the session does not
	 * exist.
	 */
	delete(sessionId: string): Promise<void>;

	/**
	 * Await all pending writes for all sessions managed by this backend.
	 *
	 * Used by SessionManager.close() and by tests that need a happens-before
	 * fence between writes and a subsequent {@link SessionBackend#readAll}
	 * (or a process-level «I've durably persisted everything» signal).
	 */
	flush(): Promise<void>;

	/**
	 * Release backend resources (open file descriptors, NATS connections,
	 * etc.). After close, the backend MUST NOT be used again.
	 */
	close(): Promise<void>;
}
