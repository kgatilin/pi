import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	buildActivitySyncPayloads,
	serializeSessionAnalyticsNdjson,
	sortSessionAnalyticsRecords,
} from "../src/core/activity-sync/payload.ts";
import type { SessionAnalyticsRecord } from "../src/core/activity-sync/session-analytics.ts";

const zstdDecompressAsync = promisify(zstdDecompress);

function session(id: string, createdAt: string): SessionAnalyticsRecord {
	return { recordType: "session", schemaVersion: 1, sessionId: id, createdAt };
}

function entry(id: string, timestamp: string): SessionAnalyticsRecord {
	return {
		recordType: "entry",
		schemaVersion: 1,
		sessionId: "session-1",
		entryId: id,
		parentEntryId: null,
		entryType: "model_change",
		timestamp,
	};
}

describe("activity sync payloads", () => {
	it("sorts records oldest-first with sessions before entries at the same timestamp", () => {
		const records = [
			entry("entry-b", "2026-01-02T00:00:00.000Z"),
			session("session-1", "2026-01-01T00:00:00.000Z"),
			entry("entry-a", "2026-01-01T00:00:00.000Z"),
		];

		expect(sortSessionAnalyticsRecords(records)).toEqual([
			session("session-1", "2026-01-01T00:00:00.000Z"),
			entry("entry-a", "2026-01-01T00:00:00.000Z"),
			entry("entry-b", "2026-01-02T00:00:00.000Z"),
		]);
	});

	it("globally sorts, serializes, and zstd-compresses NDJSON", async () => {
		const records = [entry("entry-1", "2026-01-01T00:00:01.000Z"), session("session-1", "2026-01-01T00:00:00.000Z")];
		const [payload] = await buildActivitySyncPayloads({
			records,
			scanCutoff: "2026-01-02T00:00:00.000Z",
			serverWatermark: null,
		});

		expect(payload.contentEncoding).toBe("zstd");
		expect(payload.watermark).toBe("2026-01-02T00:00:00.000Z");
		expect((await zstdDecompressAsync(payload.body)).toString("utf8")).toBe(
			serializeSessionAnalyticsNdjson(sortSessionAnalyticsRecords(records)).toString("utf8"),
		);
	});

	it("globally sorts split payloads and uses scanCutoff only for the final batch watermark", async () => {
		const records = [
			entry("new", "2026-01-03T00:00:00.000Z"),
			entry("same-b", "2026-01-02T00:00:00.000Z"),
			entry("old", "2026-01-01T00:00:00.000Z"),
			entry("same-a", "2026-01-02T00:00:00.000Z"),
		];
		const payloads = await buildActivitySyncPayloads({
			records,
			scanCutoff: "2026-01-04T00:00:00.000Z",
			serverWatermark: "2026-01-01T12:00:00.000Z",
			maxCompressedBytes: 400,
			maxDecompressedBytes: 400,
			compress: async (input) => input,
		});

		expect(
			payloads.map((payload) =>
				payload.records.map((record) => (record.recordType === "entry" ? record.entryId : record.sessionId)),
			),
		).toEqual([["old"], ["same-a", "same-b"], ["new"]]);
		expect(payloads.map((payload) => payload.watermark)).toEqual([
			"2026-01-01T12:00:00.000Z",
			"2026-01-02T00:00:00.000Z",
			"2026-01-04T00:00:00.000Z",
		]);
	});
});
