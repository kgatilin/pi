import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AuthStorage } from "../auth-storage.ts";
import { getPiDevAuth, PI_DEV_ACTIVITY_SYNC_SCOPE } from "../pi-dev/index.ts";
import { SettingsManager } from "../settings-manager.ts";
import {
	ActivitySyncApiError,
	type ActivitySyncFetch,
	getActivitySyncWatermark,
	uploadSessionAnalytics,
} from "./api.ts";
import { type ActivitySyncPayload, buildActivitySyncPayloads } from "./payload.ts";
import { buildSessionAnalyticsUpload } from "./session-analytics-reader.ts";
import {
	getActivitySyncStatePaths,
	getStableActivitySyncDeviceId,
	loadActivitySyncState,
	saveActivitySyncState,
	withActivitySyncLock,
} from "./state.ts";

export type ActivitySyncStatus = "uploaded" | "no_changes" | "not_authenticated" | "already_running" | "failed";

export interface ActivitySyncResult {
	status: ActivitySyncStatus;
	recordsSent?: number;
	compressedBytes?: number;
	decompressedBytes?: number;
	/** Server watermark returned by GET /analytics/activity/:deviceId before building the upload. */
	serverWatermark?: string | null;
	/** Watermark returned by the upload response, or the current server watermark when there are no changes. */
	watermark?: string;
	filesScanned?: number;
	error?: string;
}

export interface SyncSessionAnalyticsOptions {
	agentDir?: string;
	sessionsRoot?: string;
	settingsManager?: SettingsManager;
	authStorage?: AuthStorage;
	baseUrl?: string;
	fetch?: ActivitySyncFetch;
	signal?: AbortSignal;
	now?: Date;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getActivitySyncAuthStorage(options: SyncSessionAnalyticsOptions): AuthStorage {
	if (options.authStorage) return options.authStorage;
	const { agentDir } = getActivitySyncStatePaths(options.agentDir);
	return AuthStorage.create(join(agentDir, "auth.json"));
}

async function getActivitySyncAccessToken(
	authStorage: AuthStorage,
	options: SyncSessionAnalyticsOptions,
	forceRefresh = false,
): Promise<string | undefined> {
	const auth = await getPiDevAuth(authStorage, [PI_DEV_ACTIVITY_SYNC_SCOPE], {
		baseUrl: options.baseUrl,
		fetch: options.fetch,
		forceRefresh,
	});
	return auth.available ? auth.accessToken : undefined;
}

async function uploadWithRefreshRetry(
	authStorage: AuthStorage,
	accessToken: string,
	payload: Pick<ActivitySyncPayload, "watermark" | "contentEncoding" | "body">,
	metadata: { deviceId: string; idempotencyKey: string },
	options: SyncSessionAnalyticsOptions,
): Promise<{ watermark: string; accessToken: string }> {
	try {
		const response = await uploadSessionAnalytics({
			baseUrl: options.baseUrl,
			fetch: options.fetch,
			accessToken,
			deviceId: metadata.deviceId,
			watermark: payload.watermark,
			idempotencyKey: metadata.idempotencyKey,
			body: payload.body,
			contentEncoding: payload.contentEncoding,
		});
		return { watermark: response.watermark, accessToken };
	} catch (error) {
		if (!(error instanceof ActivitySyncApiError) || error.status !== 401) throw error;
		const refreshedAccessToken = await getActivitySyncAccessToken(authStorage, options, true);
		if (!refreshedAccessToken) throw error;
		const response = await uploadSessionAnalytics({
			baseUrl: options.baseUrl,
			fetch: options.fetch,
			accessToken: refreshedAccessToken,
			deviceId: metadata.deviceId,
			watermark: payload.watermark,
			idempotencyKey: metadata.idempotencyKey,
			body: payload.body,
			contentEncoding: payload.contentEncoding,
		});
		return { watermark: response.watermark, accessToken: refreshedAccessToken };
	}
}

async function getWatermarkWithRefreshRetry(
	authStorage: AuthStorage,
	accessToken: string,
	deviceId: string,
	options: SyncSessionAnalyticsOptions,
): Promise<{ watermark: string | null; accessToken: string }> {
	try {
		const response = await getActivitySyncWatermark(accessToken, deviceId, {
			baseUrl: options.baseUrl,
			fetch: options.fetch,
		});
		return { watermark: response.watermark, accessToken };
	} catch (error) {
		if (!(error instanceof ActivitySyncApiError) || error.status !== 401) throw error;
		const refreshedAccessToken = await getActivitySyncAccessToken(authStorage, options, true);
		if (!refreshedAccessToken) throw error;
		const response = await getActivitySyncWatermark(refreshedAccessToken, deviceId, {
			baseUrl: options.baseUrl,
			fetch: options.fetch,
		});
		return { watermark: response.watermark, accessToken: refreshedAccessToken };
	}
}

async function syncSessionAnalyticsUnlocked(options: SyncSessionAnalyticsOptions): Promise<ActivitySyncResult> {
	const settingsManager = options.settingsManager ?? SettingsManager.create(process.cwd(), options.agentDir);
	const deviceId = getStableActivitySyncDeviceId(settingsManager);
	await settingsManager.flush();
	const state = await loadActivitySyncState(options.agentDir);
	state.lastAttemptAt = (options.now ?? new Date()).toISOString();
	await saveActivitySyncState(state, options.agentDir);

	const authStorage = getActivitySyncAuthStorage(options);
	let accessToken = await getActivitySyncAccessToken(authStorage, options);
	if (!accessToken) return { status: "not_authenticated" };

	const watermarkResponse = await getWatermarkWithRefreshRetry(authStorage, accessToken, deviceId, options);
	accessToken = watermarkResponse.accessToken;
	const serverWatermark = watermarkResponse.watermark;

	try {
		// The server watermark means: the server has accepted everything this client had fully scanned/prepared through this local time.
		const upload = await buildSessionAnalyticsUpload({
			serverWatermark,
			sessionsRoot: options.sessionsRoot,
			signal: options.signal,
		});

		if (upload.records.length === 0) {
			await saveActivitySyncState(state, options.agentDir);
			return {
				status: "no_changes",
				filesScanned: upload.filesScanned,
				serverWatermark,
				watermark: serverWatermark ?? undefined,
			};
		}

		const payloads = await buildActivitySyncPayloads({
			records: upload.records,
			scanCutoff: upload.scanCutoff,
			serverWatermark,
		});
		let recordsSent = 0;
		let compressedBytes = 0;
		let decompressedBytes = 0;
		let watermark = serverWatermark ?? undefined;

		for (const payload of payloads) {
			const uploaded = await uploadWithRefreshRetry(
				authStorage,
				accessToken,
				payload,
				{ deviceId, idempotencyKey: randomUUID() },
				options,
			);
			accessToken = uploaded.accessToken;
			watermark = uploaded.watermark;
			recordsSent += payload.recordCount;
			compressedBytes += payload.compressedBytes;
			decompressedBytes += payload.decompressedBytes;
			state.lastSuccessAt = (options.now ?? new Date()).toISOString();
			await saveActivitySyncState(state, options.agentDir);
		}

		return {
			status: "uploaded",
			recordsSent,
			compressedBytes,
			decompressedBytes,
			serverWatermark,
			watermark,
			filesScanned: upload.filesScanned,
		};
	} catch (error) {
		return { status: "failed", error: errorMessage(error), serverWatermark };
	}
}

export async function syncSessionAnalytics(options: SyncSessionAnalyticsOptions = {}): Promise<ActivitySyncResult> {
	const locked = await withActivitySyncLock(async () => {
		try {
			return await syncSessionAnalyticsUnlocked(options);
		} catch (error) {
			return {
				status: "failed",
				error: errorMessage(error),
			} satisfies ActivitySyncResult;
		}
	}, options.agentDir);
	if (locked.status === "already_running") return { status: "already_running" };
	return locked.result;
}
