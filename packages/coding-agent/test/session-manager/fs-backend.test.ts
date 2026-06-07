import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBackend } from "../../src/core/fs-backend.ts";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "../../src/core/session-manager.ts";

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

describe("FsBackend", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "fs-backend-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("createSession writes the header as the first JSONL line", () => {
		const backend = new FsBackend();
		const sessionId = "sess-create";
		const sessionFile = join(tempDir, `${sessionId}.jsonl`);
		backend.registerSessionPath(sessionId, sessionFile);

		const header = makeHeader(sessionId);
		backend.createSession(header);

		const content = readFileSync(sessionFile, "utf8");
		const firstLine = content.split("\n")[0];
		expect(JSON.parse(firstLine)).toEqual(header);
	});

	it("createSession creates the parent directory if missing", () => {
		const backend = new FsBackend();
		const sessionId = "sess-mkdir";
		const sessionFile = join(tempDir, "nested", "sub", `${sessionId}.jsonl`);
		backend.registerSessionPath(sessionId, sessionFile);

		backend.createSession(makeHeader(sessionId));

		expect(readFileSync(sessionFile, "utf8").length).toBeGreaterThan(0);
	});

	it("createSession refuses to clobber an existing file (wx semantics)", () => {
		const backend = new FsBackend();
		const sessionId = "sess-wx";
		const sessionFile = join(tempDir, `${sessionId}.jsonl`);
		backend.registerSessionPath(sessionId, sessionFile);

		backend.createSession(makeHeader(sessionId));
		expect(() => backend.createSession(makeHeader(sessionId))).toThrow();
	});

	it("appendEntry round-trips with readAll (header + entries in order)", () => {
		const backend = new FsBackend();
		const sessionId = "sess-rt";
		const sessionFile = join(tempDir, `${sessionId}.jsonl`);
		backend.registerSessionPath(sessionId, sessionFile);

		const header = makeHeader(sessionId);
		backend.createSession(header);

		const e1 = makeMessageEntry("aaaaaaaa", null, "first");
		const e2 = makeMessageEntry("bbbbbbbb", "aaaaaaaa", "second");
		const e3 = makeMessageEntry("cccccccc", "bbbbbbbb", "third");
		backend.appendEntry(sessionId, e1);
		backend.appendEntry(sessionId, e2);
		backend.appendEntry(sessionId, e3);

		const loaded = backend.readAll(sessionId);
		expect(loaded).toHaveLength(4);
		expect(loaded[0]).toEqual(header);
		expect(loaded[1]).toEqual(e1);
		expect(loaded[2]).toEqual(e2);
		expect(loaded[3]).toEqual(e3);
	});

	it("readAll returns empty array for unknown session", () => {
		const backend = new FsBackend();
		expect(backend.readAll("unknown")).toEqual([]);
	});

	it("readAll returns empty array when the registered file does not exist", () => {
		const backend = new FsBackend();
		const sessionId = "sess-missing";
		backend.registerSessionPath(sessionId, join(tempDir, "does-not-exist.jsonl"));
		expect(backend.readAll(sessionId)).toEqual([]);
	});

	it("rewrite replaces existing content atomically", () => {
		const backend = new FsBackend();
		const sessionId = "sess-rewrite";
		const sessionFile = join(tempDir, `${sessionId}.jsonl`);
		backend.registerSessionPath(sessionId, sessionFile);

		const originalHeader = makeHeader(sessionId);
		backend.createSession(originalHeader);
		backend.appendEntry(sessionId, makeMessageEntry("11111111", null, "old"));
		backend.appendEntry(sessionId, makeMessageEntry("22222222", "11111111", "older"));

		const newHeader: SessionHeader = { ...originalHeader, timestamp: "2030-01-01T00:00:00.000Z" };
		const newEntries: SessionEntry[] = [
			makeMessageEntry("ffffffff", null, "fresh-first"),
			makeMessageEntry("eeeeeeee", "ffffffff", "fresh-second"),
		];
		backend.rewrite(sessionId, newHeader, newEntries);

		const loaded = backend.readAll(sessionId);
		expect(loaded).toHaveLength(3);
		expect(loaded[0]).toEqual(newHeader);
		expect(loaded[1]).toEqual(newEntries[0]);
		expect(loaded[2]).toEqual(newEntries[1]);
	});

	it("delete removes the session file and forgets the path", () => {
		const backend = new FsBackend();
		const sessionId = "sess-delete";
		const sessionFile = join(tempDir, `${sessionId}.jsonl`);
		backend.registerSessionPath(sessionId, sessionFile);

		backend.createSession(makeHeader(sessionId));
		backend.appendEntry(sessionId, makeMessageEntry("aaaaaaaa", null, "to-be-deleted"));

		backend.delete(sessionId);

		expect(backend.tryGetPath(sessionId)).toBeUndefined();
		expect(() => readFileSync(sessionFile, "utf8")).toThrow();
		// Subsequent readAll on a deleted session returns empty.
		expect(backend.readAll(sessionId)).toEqual([]);
	});

	it("delete tolerates a missing underlying file", () => {
		const backend = new FsBackend();
		const sessionId = "sess-delete-missing";
		backend.registerSessionPath(sessionId, join(tempDir, "never-existed.jsonl"));
		expect(() => backend.delete(sessionId)).not.toThrow();
		expect(backend.tryGetPath(sessionId)).toBeUndefined();
	});

	it("delete on unknown session is a no-op", () => {
		const backend = new FsBackend();
		expect(() => backend.delete("never-registered")).not.toThrow();
	});

	it("createSession throws when no path is registered", () => {
		const backend = new FsBackend();
		expect(() => backend.createSession(makeHeader("no-path"))).toThrow(/no path registered/);
	});

	it("registerSessionPath can switch a session to a new path", () => {
		const backend = new FsBackend();
		const sessionId = "sess-relocate";
		const firstPath = join(tempDir, "first.jsonl");
		const secondPath = join(tempDir, "second.jsonl");

		backend.registerSessionPath(sessionId, firstPath);
		backend.createSession(makeHeader(sessionId));

		backend.registerSessionPath(sessionId, secondPath);
		backend.createSession(makeHeader(sessionId));

		expect(readFileSync(firstPath, "utf8").length).toBeGreaterThan(0);
		expect(readFileSync(secondPath, "utf8").length).toBeGreaterThan(0);
	});
});
