import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, relative } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoverSessionFiles,
	discoverSessions,
	type SessionDiscoveryProgress,
} from "../src/core/activity-sync/session-discovery.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-discovery-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeJsonl(path: string, lines: unknown[]): void {
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("session discovery", () => {
	it("finds session jsonl files recursively", async () => {
		const root = createTempDir();
		const projectA = join(root, "--project-a--");
		const projectB = join(root, "--project-b--", "nested");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		writeJsonl(join(projectA, "a.jsonl"), [
			{ type: "session", version: 3, id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/a" },
		]);
		writeJsonl(join(projectB, "b.jsonl"), [
			{ type: "session", version: 3, id: "b", timestamp: "2026-01-02T00:00:00.000Z", cwd: "/b" },
		]);
		writeFileSync(join(projectA, "notes.txt"), "not a session");

		const files = await discoverSessionFiles({ sessionsRoot: root });

		expect(files.map((file) => relative(root, file))).toEqual([
			join("--project-a--", "a.jsonl"),
			join("--project-b--", "nested", "b.jsonl"),
		]);
	});

	it("returns metadata for valid sessions and skips invalid jsonl files", async () => {
		const root = createTempDir();
		const projectA = join(root, "--project-a--");
		const projectB = join(root, "--project-b--");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		writeJsonl(join(projectA, "a.jsonl"), [
			{
				type: "session",
				version: 3,
				id: "session-a",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/work/a",
				parentSession: "/parent/session.jsonl",
			},
		]);
		writeJsonl(join(projectB, "b.jsonl"), [
			{ type: "session", version: 3, id: "session-b", timestamp: "2026-01-02T00:00:00.000Z", cwd: "/work/b" },
		]);
		writeFileSync(join(projectB, "invalid.jsonl"), "not json\n");

		const progress: SessionDiscoveryProgress[] = [];
		const sessions = await discoverSessions({ sessionsRoot: root, onProgress: (update) => progress.push(update) });

		expect(sessions.map((session) => session.sessionId)).toEqual(["session-a", "session-b"]);
		expect(sessions[0]).toMatchObject({
			path: join(projectA, "a.jsonl"),
			relativePath: join("--project-a--", "a.jsonl"),
			sessionDir: projectA,
			sessionDirName: basename(projectA),
			sessionId: "session-a",
			cwd: "/work/a",
			header: {
				type: "session",
				version: 3,
				id: "session-a",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/work/a",
				parentSession: "/parent/session.jsonl",
			},
		});
		expect(sessions[0].createdAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
		expect(sessions[0].modifiedAt).toBeInstanceOf(Date);
		expect(sessions[0].sizeBytes).toBeGreaterThan(0);
		expect(progress.at(-1)).toMatchObject({ phase: "read", foundFiles: 3, processedFiles: 3, sessions: 2 });
	});
});
