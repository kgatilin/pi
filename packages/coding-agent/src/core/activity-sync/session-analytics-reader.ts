import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { FileEntry, SessionEntry, SessionHeader } from "../session-manager.ts";
import { projectSessionForAnalytics, type SessionAnalyticsRecord } from "./session-analytics.ts";
import { discoverSessions, type SessionDiscoveryProgressCallback } from "./session-discovery.ts";

export interface BuildSessionAnalyticsUploadOptions {
	/** Server watermark from GET /analytics/activity/:deviceId. */
	serverWatermark: string | null;
	/** Root sessions directory. Defaults to ~/.pi/agent/sessions. */
	sessionsRoot?: string;
	scanCutoff?: Date;
	signal?: AbortSignal;
	onDiscoveryProgress?: SessionDiscoveryProgressCallback;
}

export interface BuildSessionAnalyticsUploadResult {
	records: SessionAnalyticsRecord[];
	scanCutoff: string;
	filesScanned: number;
	malformedFiles: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSessionHeader(value: unknown): value is SessionHeader {
	if (!isRecord(value)) return false;
	return (
		value.type === "session" &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.timestamp === "string" &&
		value.timestamp.length > 0 &&
		typeof value.cwd === "string" &&
		(value.version === undefined || typeof value.version === "number") &&
		(value.parentSession === undefined || typeof value.parentSession === "string")
	);
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.type === "string" &&
		value.type !== "session" &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		(value.parentId === null || typeof value.parentId === "string") &&
		typeof value.timestamp === "string" &&
		value.timestamp.length > 0
	);
}

function parseIsoTime(value: string): number | undefined {
	const time = new Date(value).getTime();
	return Number.isNaN(time) ? undefined : time;
}

function getRecordTimestamp(record: SessionAnalyticsRecord): string | undefined {
	if (record.recordType === "entry") return record.timestamp;
	return record.createdAt ?? record.modifiedAt;
}

function recordIsBeforeScanCutoff(record: SessionAnalyticsRecord, scanCutoffTime: number): boolean {
	const timestamp = getRecordTimestamp(record);
	if (!timestamp) return false;
	const recordTime = parseIsoTime(timestamp);
	return recordTime !== undefined && recordTime < scanCutoffTime;
}

async function readSessionFile(path: string): Promise<{ header: SessionHeader; entries: SessionEntry[] } | undefined> {
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let header: SessionHeader | undefined;
	const entries: SessionEntry[] = [];

	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as FileEntry;
			} catch {
				return undefined;
			}

			if (!header) {
				if (!isSessionHeader(parsed)) return undefined;
				header = parsed;
				continue;
			}

			if (!isSessionEntry(parsed)) return undefined;
			entries.push(parsed);
		}
	} finally {
		lines.close();
		stream.destroy();
	}

	return header ? { header, entries } : undefined;
}

export async function buildSessionAnalyticsUpload(
	options: BuildSessionAnalyticsUploadOptions,
): Promise<BuildSessionAnalyticsUploadResult> {
	const scanCutoff = options.scanCutoff ?? new Date();
	const scanCutoffTime = scanCutoff.getTime();
	const serverWatermarkTime = options.serverWatermark ? parseIsoTime(options.serverWatermark) : undefined;
	const sessions = await discoverSessions({
		sessionsRoot: options.sessionsRoot,
		signal: options.signal,
		onProgress: options.onDiscoveryProgress,
	});
	const records: SessionAnalyticsRecord[] = [];
	let filesScanned = 0;
	let malformedFiles = 0;

	for (const session of sessions) {
		if (options.signal?.aborted) break;
		if (serverWatermarkTime !== undefined && session.modifiedAt.getTime() <= serverWatermarkTime) continue;
		filesScanned++;
		const parsed = await readSessionFile(session.path).catch(() => undefined);
		if (!parsed) {
			malformedFiles++;
			continue;
		}
		const projectedRecords = projectSessionForAnalytics(parsed.header, parsed.entries, {
			modifiedAt: session.modifiedAt,
		});
		records.push(...projectedRecords.filter((record) => recordIsBeforeScanCutoff(record, scanCutoffTime)));
	}

	return {
		records,
		scanCutoff: scanCutoff.toISOString(),
		filesScanned,
		malformedFiles,
	};
}
