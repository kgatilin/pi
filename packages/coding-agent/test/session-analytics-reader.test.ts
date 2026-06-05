import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionAnalyticsUpload } from "../src/core/activity-sync/session-analytics-reader.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-analytics-reader-"));
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

function sessionHeader(id: string, timestamp: string): unknown {
	return { type: "session", version: 3, id, timestamp, cwd: `/work/${id}` };
}

function entry(id: string, timestamp: string): unknown {
	return { type: "model_change", id, parentId: null, timestamp, provider: "anthropic", modelId: "model" };
}

describe("buildSessionAnalyticsUpload", () => {
	it("selects files by mtime and includes old records before the scan cutoff", async () => {
		const root = createTempDir();
		const project = join(root, "--project--");
		mkdirSync(project, { recursive: true });
		const oldFile = join(project, "old.jsonl");
		const changedFile = join(project, "changed.jsonl");
		writeJsonl(oldFile, [
			sessionHeader("old", "2026-01-01T00:00:00.000Z"),
			entry("old-entry", "2026-01-01T00:00:01.000Z"),
		]);
		writeJsonl(changedFile, [
			sessionHeader("changed", "2026-01-01T00:00:00.000Z"),
			entry("included-old-entry", "2026-01-01T00:00:01.000Z"),
			entry("future-entry", "2026-01-03T00:00:00.000Z"),
		]);
		utimesSync(oldFile, new Date("2026-01-01T00:10:00.000Z"), new Date("2026-01-01T00:10:00.000Z"));
		utimesSync(changedFile, new Date("2026-01-02T00:10:00.000Z"), new Date("2026-01-02T00:10:00.000Z"));

		const result = await buildSessionAnalyticsUpload({
			sessionsRoot: root,
			serverWatermark: "2026-01-02T00:00:00.000Z",
			scanCutoff: new Date("2026-01-02T12:00:00.000Z"),
		});

		expect(result.filesScanned).toBe(1);
		expect(result.malformedFiles).toBe(0);
		expect(result.scanCutoff).toBe("2026-01-02T12:00:00.000Z");
		expect(
			result.records.map((record) => (record.recordType === "entry" ? record.entryId : record.sessionId)),
		).toEqual(["changed", "included-old-entry"]);
	});

	it("skips malformed selected files", async () => {
		const root = createTempDir();
		const project = join(root, "--project--");
		mkdirSync(project, { recursive: true });
		const malformed = join(project, "malformed.jsonl");
		writeFileSync(malformed, `${JSON.stringify(sessionHeader("bad", "2026-01-01T00:00:00.000Z"))}\nnot json\n`);

		const result = await buildSessionAnalyticsUpload({
			sessionsRoot: root,
			serverWatermark: null,
			scanCutoff: new Date("2026-01-02T00:00:00.000Z"),
		});

		expect(result.records).toEqual([]);
		expect(result.filesScanned).toBe(1);
		expect(result.malformedFiles).toBe(1);
	});
});
