/**
 * FsBackend test suite: contract + filesystem-specific behaviour.
 *
 * Shared cross-backend behaviour lives in {@link runSessionBackendContract}.
 * This file adds FS-only assertions (file-on-disk content, parent-directory
 * creation, path relocation via `registerSessionPath`).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FsBackend } from "../../src/core/fs-backend.ts";
import type { SessionHeader, SessionMessageEntry } from "../../src/core/session-manager.ts";
import { type BackendFactory, runSessionBackendContract } from "./backend-contract.ts";

// One tmpdir per test run, cleaned up at end. Per-session paths live under it.
let sharedTempDir: string;

beforeAll(() => {
	sharedTempDir = mkdtempSync(join(tmpdir(), "fs-backend-contract-"));
});
afterAll(() => {
	rmSync(sharedTempDir, { recursive: true, force: true });
});

const fsFactory: BackendFactory = {
	async create() {
		return new FsBackend();
	},
	prepareSession(backend, sessionId) {
		(backend as FsBackend).registerSessionPath(sessionId, join(sharedTempDir, `${sessionId}.jsonl`));
	},
};

runSessionBackendContract("FsBackend", fsFactory);

// ----- FS-specific tests below: cover concerns that don't apply to NATS. -----

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

describe("FsBackend (filesystem-specific)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "fs-backend-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("createSession writes the header as the first JSONL line", async () => {
		const backend = new FsBackend();
		const sessionId = "sess-create";
		const sessionFile = join(tempDir, `${sessionId}.jsonl`);
		backend.registerSessionPath(sessionId, sessionFile);

		const header = makeHeader(sessionId);
		await backend.createSession(header);
		await backend.flush();

		const content = readFileSync(sessionFile, "utf8");
		const firstLine = content.split("\n")[0];
		expect(JSON.parse(firstLine)).toEqual(header);
	});

	it("createSession creates the parent directory if missing", async () => {
		const backend = new FsBackend();
		const sessionId = "sess-mkdir";
		const sessionFile = join(tempDir, "nested", "sub", `${sessionId}.jsonl`);
		backend.registerSessionPath(sessionId, sessionFile);

		await backend.createSession(makeHeader(sessionId));
		await backend.flush();

		expect(readFileSync(sessionFile, "utf8").length).toBeGreaterThan(0);
	});

	it("createSession throws when no path is registered", async () => {
		const backend = new FsBackend();
		await expect(backend.createSession(makeHeader("no-path"))).rejects.toThrow(/no path registered/);
	});

	it("registerSessionPath can switch a session to a new path", async () => {
		const backend = new FsBackend();
		const sessionId = "sess-relocate";
		const firstPath = join(tempDir, "first.jsonl");
		const secondPath = join(tempDir, "second.jsonl");

		backend.registerSessionPath(sessionId, firstPath);
		await backend.createSession(makeHeader(sessionId));
		await backend.flush();

		backend.registerSessionPath(sessionId, secondPath);
		await backend.createSession(makeHeader(sessionId));
		await backend.flush();

		expect(readFileSync(firstPath, "utf8").length).toBeGreaterThan(0);
		expect(readFileSync(secondPath, "utf8").length).toBeGreaterThan(0);
	});

	it("delete forgets the registered path and tolerates missing files", async () => {
		const backend = new FsBackend();
		const sessionId = "sess-delete-missing";
		backend.registerSessionPath(sessionId, join(tempDir, "never-existed.jsonl"));
		await expect(backend.delete(sessionId)).resolves.toBeUndefined();
		expect(backend.tryGetPath(sessionId)).toBeUndefined();
	});

	it("readAll returns empty array when the registered file does not exist", async () => {
		const backend = new FsBackend();
		const sessionId = "sess-missing";
		backend.registerSessionPath(sessionId, join(tempDir, "does-not-exist.jsonl"));
		expect(await backend.readAll(sessionId)).toEqual([]);
	});

	it("appendEntry round-trip writes JSONL lines after the header", async () => {
		const backend = new FsBackend();
		const sessionId = "sess-rt-fs";
		const sessionFile = join(tempDir, `${sessionId}.jsonl`);
		backend.registerSessionPath(sessionId, sessionFile);

		await backend.createSession(makeHeader(sessionId));
		await backend.appendEntry(sessionId, makeMessageEntry("aaaaaaaa", null, "first"));
		await backend.flush();

		const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).type).toBe("session");
		expect(JSON.parse(lines[1]).type).toBe("message");
	});
});
