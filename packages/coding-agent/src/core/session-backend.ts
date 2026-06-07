/**
 * Storage backend abstraction for session persistence.
 *
 * SessionManager delegates all session I/O to a SessionBackend implementation.
 * The default implementation is FsBackend (JSONL files on disk). Alternative
 * backends (Postgres, NATS, etc.) can be plugged in for distributed deployments
 * without changing SessionManager logic.
 *
 * The interface is currently synchronous to preserve SessionManager's existing
 * sync semantics and avoid touching ~50 call sites. Backends that are async by
 * nature (Postgres, NATS) will need an internal write queue or a follow-up
 * change that promotes select call sites to async.
 */

import type { FileEntry, SessionEntry, SessionHeader } from "./session-manager.ts";

/**
 * Per-session storage backend.
 *
 * All methods key off `sessionId`. Backends are expected to maintain their
 * own mapping from sessionId to underlying storage (file path, database
 * key, JetStream subject, etc.).
 */
export interface SessionBackend {
	/**
	 * Create a new session and write its header. Implementations are
	 * responsible for ensuring the underlying storage location exists.
	 *
	 * For FsBackend, the caller must first call {@link FsBackend.registerSessionPath}
	 * (or pass the path via session options) so the backend knows where to
	 * write. This keeps the cross-backend interface clean while letting
	 * FsBackend honour explicit file paths chosen by SessionManager
	 * (e.g. from `--session` flag or `createBranchedSession`).
	 */
	createSession(header: SessionHeader): void;

	/**
	 * Append a single entry to an existing session.
	 *
	 * For FsBackend this is an append-only `appendFileSync` to the JSONL
	 * file. Other backends may use insert/append semantics native to their
	 * storage.
	 */
	appendEntry(sessionId: string, entry: SessionEntry): void;

	/**
	 * Read all entries (header + body) for a session, in stored order.
	 *
	 * Returns an empty array if the session does not exist or the storage
	 * location is empty.
	 */
	readAll(sessionId: string): FileEntry[];

	/**
	 * Atomically rewrite a session from scratch.
	 *
	 * Used for migrations and for session-branch creation. Replaces any
	 * existing content with the provided header + entries.
	 */
	rewrite(sessionId: string, header: SessionHeader, entries: SessionEntry[]): void;

	/**
	 * Delete a session's storage entirely. No-op if the session does not
	 * exist.
	 */
	delete(sessionId: string): void;
}
