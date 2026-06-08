/**
 * Shared contract test suite for {@link SessionBackend} implementations.
 *
 * Both {@link FsBackend} and {@link NatsBackend} must satisfy these
 * behavioural contracts. Each backend's test file invokes
 * {@link runSessionBackendContract} with a factory that returns a fresh
 * backend instance plus an opaque handle (used for cleanup or for backend-
 * specific path/subject hooks the contract needs to call into).
 *
 * Keeping the suite parameterized is the only way to guarantee both
 * backends actually behave identically — duplicated test code drifts.
 */

import { describe, expect, it } from "vitest";
import type { SessionBackend } from "../../src/core/session-backend.ts";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "../../src/core/session-manager.ts";

/**
 * Hook called once per test with a fresh sessionId. Backends that need
 * out-of-band setup before the first call (e.g. FsBackend's
 * `registerSessionPath`) wire that here. NATS-style backends that route by
 * sessionId alone return undefined and do nothing.
 */
export type PrepareSession = (backend: SessionBackend, sessionId: string) => void | Promise<void>;

export interface BackendFactory {
	/** Construct a fresh backend instance for a single test. */
	create(): Promise<SessionBackend>;
	/** Release any out-of-process resources (containers, tmpdirs, etc.) — runs once per backend. */
	teardown?(): Promise<void>;
	/** Per-test session prep hook. See {@link PrepareSession}. */
	prepareSession: PrepareSession;
}

function makeHeader(id: string): SessionHeader {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd: "/tmp",
	};
}

function makeMessageEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

let counter = 0;
function uniqueSessionId(prefix: string): string {
	counter += 1;
	return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * Register the shared contract suite under `describe(name, ...)`.
 *
 * Tests are written against the public {@link SessionBackend} interface
 * only — no backend-specific assertions. Backend-specific behaviour (file
 * paths, stream subjects) is tested separately in each backend's test file.
 */
export function runSessionBackendContract(name: string, factory: BackendFactory): void {
	describe(`SessionBackend contract: ${name}`, () => {
		it("createSession + readAll round-trip returns the header as the first entry", async () => {
			const backend = await factory.create();
			const id = uniqueSessionId("hdr");
			await factory.prepareSession(backend, id);
			const header = makeHeader(id);
			await backend.createSession(header);
			const loaded = await backend.readAll(id);
			expect(loaded).toHaveLength(1);
			expect(loaded[0]).toEqual(header);
			await backend.close();
		});

		it("appendEntry preserves submission order", async () => {
			const backend = await factory.create();
			const id = uniqueSessionId("ord");
			await factory.prepareSession(backend, id);
			const header = makeHeader(id);
			await backend.createSession(header);

			const e1 = makeMessageEntry("aaaaaaaa", null, "first");
			const e2 = makeMessageEntry("bbbbbbbb", "aaaaaaaa", "second");
			const e3 = makeMessageEntry("cccccccc", "bbbbbbbb", "third");
			// Kick off concurrently; backend MUST serialize per session.
			await Promise.all([backend.appendEntry(id, e1), backend.appendEntry(id, e2), backend.appendEntry(id, e3)]);

			const loaded = await backend.readAll(id);
			expect(loaded).toHaveLength(4);
			expect(loaded[0]).toEqual(header);
			expect(loaded[1]).toEqual(e1);
			expect(loaded[2]).toEqual(e2);
			expect(loaded[3]).toEqual(e3);
			await backend.close();
		});

		it("readAll returns empty for unknown session", async () => {
			const backend = await factory.create();
			const id = uniqueSessionId("unknown");
			await factory.prepareSession(backend, id);
			expect(await backend.readAll(id)).toEqual([]);
			await backend.close();
		});

		it("createSession refuses to clobber an existing session", async () => {
			const backend = await factory.create();
			const id = uniqueSessionId("dup");
			await factory.prepareSession(backend, id);
			await backend.createSession(makeHeader(id));
			await expect(backend.createSession(makeHeader(id))).rejects.toThrow();
			await backend.close();
		});

		it("rewrite replaces existing content atomically", async () => {
			const backend = await factory.create();
			const id = uniqueSessionId("rw");
			await factory.prepareSession(backend, id);

			const originalHeader = makeHeader(id);
			await backend.createSession(originalHeader);
			await backend.appendEntry(id, makeMessageEntry("11111111", null, "old"));
			await backend.appendEntry(id, makeMessageEntry("22222222", "11111111", "older"));

			const newHeader: SessionHeader = { ...originalHeader, timestamp: "2030-01-01T00:00:00.000Z" };
			const newEntries: SessionEntry[] = [
				makeMessageEntry("ffffffff", null, "fresh-first"),
				makeMessageEntry("eeeeeeee", "ffffffff", "fresh-second"),
			];
			await backend.rewrite(id, newHeader, newEntries);

			const loaded = await backend.readAll(id);
			expect(loaded).toHaveLength(3);
			expect(loaded[0]).toEqual(newHeader);
			expect(loaded[1]).toEqual(newEntries[0]);
			expect(loaded[2]).toEqual(newEntries[1]);
			await backend.close();
		});

		it("delete removes the session and is a no-op on a second call", async () => {
			const backend = await factory.create();
			const id = uniqueSessionId("del");
			await factory.prepareSession(backend, id);
			await backend.createSession(makeHeader(id));
			await backend.appendEntry(id, makeMessageEntry("aaaaaaaa", null, "to-be-deleted"));

			await backend.delete(id);
			expect(await backend.readAll(id)).toEqual([]);
			// Second delete is a no-op.
			await backend.delete(id);
			await backend.close();
		});

		it("delete tolerates a never-created session", async () => {
			const backend = await factory.create();
			const id = uniqueSessionId("delmiss");
			await factory.prepareSession(backend, id);
			await expect(backend.delete(id)).resolves.toBeUndefined();
			await backend.close();
		});

		it("flush awaits all pending writes so a subsequent readAll observes them", async () => {
			const backend = await factory.create();
			const id = uniqueSessionId("flush");
			await factory.prepareSession(backend, id);
			await backend.createSession(makeHeader(id));
			// Fire-and-forget a burst of writes; the test must NOT await each.
			void backend.appendEntry(id, makeMessageEntry("aaaaaaaa", null, "1"));
			void backend.appendEntry(id, makeMessageEntry("bbbbbbbb", "aaaaaaaa", "2"));
			void backend.appendEntry(id, makeMessageEntry("cccccccc", "bbbbbbbb", "3"));
			await backend.flush();
			const loaded = await backend.readAll(id);
			expect(loaded).toHaveLength(4);
			await backend.close();
		});

		it("close is idempotent against double-call", async () => {
			const backend = await factory.create();
			const id = uniqueSessionId("close");
			await factory.prepareSession(backend, id);
			await backend.createSession(makeHeader(id));
			await backend.close();
			// Some backends throw on use-after-close — we only require close()
			// itself to be safe to call twice, not for I/O to keep working.
			await expect(backend.close()).resolves.toBeUndefined();
		});

		it("two sessions are isolated from each other", async () => {
			const backend = await factory.create();
			const idA = uniqueSessionId("a");
			const idB = uniqueSessionId("b");
			await factory.prepareSession(backend, idA);
			await factory.prepareSession(backend, idB);
			await backend.createSession(makeHeader(idA));
			await backend.createSession(makeHeader(idB));
			await backend.appendEntry(idA, makeMessageEntry("aaaaaaaa", null, "in-a"));
			await backend.appendEntry(idB, makeMessageEntry("bbbbbbbb", null, "in-b"));

			const loadedA = await backend.readAll(idA);
			const loadedB = await backend.readAll(idB);
			expect(loadedA).toHaveLength(2);
			expect(loadedB).toHaveLength(2);
			expect(loadedA[1]).toMatchObject({ id: "aaaaaaaa" });
			expect(loadedB[1]).toMatchObject({ id: "bbbbbbbb" });
			await backend.close();
		});
	});
}
