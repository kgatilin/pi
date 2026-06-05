import type { Buffer } from "node:buffer";
import {
	PI_DEV_ACTIVITY_SYNC_SCOPE,
	PI_DEV_DEFAULT_BASE_URL,
	PI_DEV_OAUTH_CLIENT_ID,
	PI_DEV_OFFLINE_ACCESS_SCOPE,
} from "../pi-dev/config.ts";
import {
	getPiDevApiUrl,
	getPiDevFetch,
	isRecord,
	PiDevApiError,
	type PiDevApiOptions,
	type PiDevFetch,
	readJson,
	requireNumber,
	requireString,
	throwIfPiDevNotOk,
} from "../pi-dev/http.ts";
import {
	type PiDevDeviceFlowResponse,
	type PiDevTokenResponse,
	pollPiDevDeviceToken,
	refreshPiDevAccessToken,
	startPiDevDeviceFlow,
} from "../pi-dev/oauth.ts";

export const ACTIVITY_SYNC_CLIENT_ID = PI_DEV_OAUTH_CLIENT_ID;
export const ACTIVITY_SYNC_SCOPE = `${PI_DEV_ACTIVITY_SYNC_SCOPE} ${PI_DEV_OFFLINE_ACCESS_SCOPE}`;
export const DEFAULT_PI_DEV_URL = PI_DEV_DEFAULT_BASE_URL;

export type ActivitySyncDeviceFlowResponse = PiDevDeviceFlowResponse;
export type ActivitySyncTokenResponse = PiDevTokenResponse;

export interface ActivitySyncWatermarkResponse {
	ok: true;
	watermark: string | null;
}

export interface ActivitySyncUploadResponse {
	ok: true;
	accepted: true;
	received_bytes: number;
	watermark: string;
}

export type ActivitySyncFetch = PiDevFetch;

export interface ActivitySyncApiOptions extends PiDevApiOptions {}

export interface UploadSessionAnalyticsOptions extends ActivitySyncApiOptions {
	accessToken: string;
	deviceId: string;
	watermark: string;
	idempotencyKey: string;
	body: Buffer;
	contentEncoding: "zstd";
}

export class ActivitySyncApiError extends PiDevApiError {
	constructor(status: number, errorCode: string | undefined, description: string | undefined, operation?: string) {
		super(status, errorCode, description, operation);
		this.name = "ActivitySyncApiError";
	}
}

function parseWatermarkResponse(json: unknown): ActivitySyncWatermarkResponse {
	if (!isRecord(json) || json.ok !== true || (json.watermark !== null && typeof json.watermark !== "string")) {
		throw new Error("Invalid activity sync watermark response");
	}
	return { ok: true, watermark: json.watermark };
}

function parseUploadResponse(json: unknown): ActivitySyncUploadResponse {
	if (!isRecord(json) || json.ok !== true || json.accepted !== true) {
		throw new Error("Invalid activity sync upload response");
	}
	return {
		ok: true,
		accepted: true,
		received_bytes: requireNumber(json, "received_bytes", "activity sync upload response"),
		watermark: requireString(json, "watermark", "activity sync upload response"),
	};
}

export async function startActivitySyncDeviceFlow(
	deviceId: string,
	options: ActivitySyncApiOptions = {},
): Promise<ActivitySyncDeviceFlowResponse> {
	return startPiDevDeviceFlow({
		...options,
		deviceId,
		scopes: [PI_DEV_ACTIVITY_SYNC_SCOPE],
		errorClass: ActivitySyncApiError,
	});
}

export async function pollActivitySyncDeviceToken(
	deviceCode: string,
	options: ActivitySyncApiOptions = {},
): Promise<ActivitySyncTokenResponse> {
	return pollPiDevDeviceToken(deviceCode, {
		...options,
		errorClass: ActivitySyncApiError,
	});
}

export async function refreshActivitySyncAccessToken(
	refreshToken: string,
	options: ActivitySyncApiOptions = {},
): Promise<ActivitySyncTokenResponse> {
	return refreshPiDevAccessToken(refreshToken, {
		...options,
		errorClass: ActivitySyncApiError,
	});
}

export async function getActivitySyncWatermark(
	accessToken: string,
	deviceId: string,
	options: ActivitySyncApiOptions = {},
): Promise<ActivitySyncWatermarkResponse> {
	const response = await getPiDevFetch(options.fetch)(
		getPiDevApiUrl(`/analytics/activity/${deviceId}`, options.baseUrl),
		{
			headers: { Authorization: `Bearer ${accessToken}` },
		},
	);
	await throwIfPiDevNotOk(response, "GET /analytics/activity/:deviceId", ActivitySyncApiError);
	return parseWatermarkResponse(await readJson(response));
}

export async function uploadSessionAnalytics(
	options: UploadSessionAnalyticsOptions,
): Promise<ActivitySyncUploadResponse> {
	const response = await getPiDevFetch(options.fetch)(
		getPiDevApiUrl(`/analytics/activity/${options.deviceId}`, options.baseUrl),
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.accessToken}`,
				"Content-Type": "application/x-ndjson",
				"Content-Encoding": options.contentEncoding,
				"Pi-Sync-Watermark": options.watermark,
				"Idempotency-Key": options.idempotencyKey,
			},
			body: options.body,
		},
	);
	await throwIfPiDevNotOk(response, "POST /analytics/activity/:deviceId", ActivitySyncApiError);
	return parseUploadResponse(await readJson(response));
}
