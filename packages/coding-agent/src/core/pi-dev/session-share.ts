import type { AuthStorage, OAuthCredential } from "../auth-storage.ts";
import { getPiDevBaseUrl, normalizePiDevBaseUrl, PI_DEV_SESSION_SHARE_SCOPE } from "./config.ts";
import { getPiDevFetch, numberField, type PiDevFetch, readJsonObject, stringField } from "./http.ts";
import { getPiDevAuth, loginPiDev, type PiDevAuthResult, type PiDevLoginOptions } from "./oauth.ts";

export type ShareCommandMode = "auto" | "pi.dev" | "github";

export type ShareCommandParseResult = { ok: true; mode: ShareCommandMode } | { ok: false; message: string };

export type PiDevShareAuthResult = PiDevAuthResult;

export interface PiDevShareUploadResult {
	id: string;
	url: string;
}

export interface PiDevShareDeviceAuthInfo {
	userCode: string;
	verificationUri: string;
	displayVerificationUri?: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

export interface PiDevShareDeviceAuthOptions {
	signal?: AbortSignal;
	onDeviceCode?: (info: PiDevShareDeviceAuthInfo) => void;
}

export interface PiDevShareUploadOptions {
	accessToken: string;
	bytes: Uint8Array;
	byteSize: number;
	baseUrl?: string;
	signal?: AbortSignal;
	fetchFn?: PiDevFetch;
}

export function parseShareCommand(text: string): ShareCommandParseResult {
	if (text === "/share") {
		return { ok: true, mode: "auto" };
	}
	if (!text.startsWith("/share ")) {
		return { ok: false, message: "Usage: /share [pi.dev|github]" };
	}

	const args = text.slice("/share".length).trim().split(/\s+/).filter(Boolean);
	if (args.length === 0) {
		return { ok: true, mode: "auto" };
	}
	if (args.length === 1 && (args[0] === "pi.dev" || args[0] === "github")) {
		return { ok: true, mode: args[0] };
	}
	return { ok: false, message: "Usage: /share [pi.dev|github]" };
}

export async function loginPiDevShare(
	authStorage: AuthStorage,
	options: PiDevShareDeviceAuthOptions = {},
): Promise<OAuthCredential> {
	const loginOptions: PiDevLoginOptions = {
		scopes: [PI_DEV_SESSION_SHARE_SCOPE],
		signal: options.signal,
		onDeviceCode: options.onDeviceCode,
	};
	return loginPiDev(authStorage, loginOptions);
}

export async function getPiDevShareAuth(authStorage: AuthStorage): Promise<PiDevShareAuthResult> {
	return getPiDevAuth(authStorage, [PI_DEV_SESSION_SHARE_SCOPE]);
}

export async function uploadPiDevSessionShare(options: PiDevShareUploadOptions): Promise<PiDevShareUploadResult> {
	const response = await getPiDevFetch(options.fetchFn)(
		`${normalizePiDevBaseUrl(options.baseUrl ?? getPiDevBaseUrl())}/api/session-shares`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.accessToken}`,
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": String(options.byteSize),
			},
			body: options.bytes,
			signal: options.signal,
		},
	);
	const data = await readJsonObject(response);
	if (response.status !== 201) {
		throw new Error(formatPiDevShareUploadError(response, data));
	}

	const id = stringField(data, "id");
	const url = stringField(data, "url");
	if (!id || !url) {
		throw new Error("pi.dev returned an invalid share response.");
	}
	return { id, url };
}

export function formatPiDevShareSuccess(url: string): string {
	return `Share URL: ${url}\nStored on pi.dev as an unlisted session share.\nAnyone with this link can view it.`;
}

export function formatPiDevShareUploadError(response: Response, data: Record<string, unknown> | undefined): string {
	if (response.status === 401) {
		return "authentication failed (token is invalid or expired)";
	}
	if (response.status === 403) {
		return "your pi.dev login does not include session sharing permission";
	}
	if (response.status === 411) {
		return "pi.dev requires Content-Length for session uploads";
	}
	if (response.status === 413) {
		const maxBytes = numberField(data, "max_bytes");
		return maxBytes === undefined
			? "session export is too large"
			: `session export is too large (max ${maxBytes} bytes)`;
	}
	if (response.status === 415) {
		return "pi.dev rejected the upload content type";
	}
	return (
		stringField(data, "error_description") ||
		stringField(data, "error") ||
		`HTTP ${response.status} ${response.statusText}`.trim()
	);
}
