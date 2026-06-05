import { type OAuthDeviceCodeInfo, pollOAuthDeviceCodeFlow } from "@earendil-works/pi-ai/oauth";
import type { AuthStorage, OAuthCredential } from "../auth-storage.ts";
import {
	formatPiDevScopes,
	PI_DEV_OAUTH_CLIENT_ID,
	PI_DEV_OAUTH_PROVIDER_ID,
	PI_DEV_SESSION_SHARE_SCOPE,
	scopesFromString,
	withPiDevOfflineAccess,
} from "./config.ts";
import {
	createFormBody,
	getPiDevApiUrl,
	getPiDevFetch,
	PiDevApiError,
	type PiDevApiErrorCtor,
	type PiDevApiOptions,
	readJson,
	readJsonObject,
	requireNumber,
	requireString,
	stringField,
	throwIfPiDevNotOk,
} from "./http.ts";

const PI_DEV_DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface PiDevDeviceFlowResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

export interface PiDevTokenResponse {
	token_type: "Bearer";
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope: string;
}

export interface PiDevDeviceFlowOptions extends PiDevApiOptions {
	scopes: readonly string[];
	deviceId?: string;
	signal?: AbortSignal;
	errorClass?: PiDevApiErrorCtor;
}

export interface PiDevDeviceTokenOptions extends PiDevApiOptions {
	signal?: AbortSignal;
	errorClass?: PiDevApiErrorCtor;
}

export interface PiDevRefreshTokenOptions extends PiDevApiOptions {
	errorClass?: PiDevApiErrorCtor;
}

export interface PiDevAccessIntrospectionResult {
	active: boolean;
	scope?: string;
	sessionShareAccess?: boolean;
}

export interface PiDevAuthOptions extends PiDevApiOptions {
	forceRefresh?: boolean;
}

export type PiDevAuthResult =
	| { available: true; accessToken: string }
	| {
			available: false;
			reason: "unauthenticated" | "invalid_token" | "missing_scope";
	  };

export interface PiDevDeviceCodeInfo extends OAuthDeviceCodeInfo {
	displayVerificationUri?: string;
}

export interface PiDevLoginOptions extends PiDevApiOptions {
	scopes: readonly string[];
	deviceId?: string;
	signal?: AbortSignal;
	onDeviceCode?: (info: PiDevDeviceCodeInfo) => void;
}

function parseDeviceFlowResponse(json: unknown): PiDevDeviceFlowResponse {
	if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid pi.dev device flow response");
	const record = json as Record<string, unknown>;
	return {
		device_code: requireString(record, "device_code", "pi.dev device flow response"),
		user_code: requireString(record, "user_code", "pi.dev device flow response"),
		verification_uri: requireString(record, "verification_uri", "pi.dev device flow response"),
		verification_uri_complete: requireString(record, "verification_uri_complete", "pi.dev device flow response"),
		expires_in: requireNumber(record, "expires_in", "pi.dev device flow response"),
		interval: requireNumber(record, "interval", "pi.dev device flow response"),
	};
}

function parseTokenResponse(json: unknown): PiDevTokenResponse {
	if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid pi.dev token response");
	const record = json as Record<string, unknown>;
	const tokenType = stringField(record, "token_type") ?? "Bearer";
	if (tokenType !== "Bearer") throw new Error(`Invalid pi.dev token type: ${tokenType}`);
	return {
		token_type: "Bearer",
		access_token: requireString(record, "access_token", "pi.dev token response"),
		refresh_token: requireString(record, "refresh_token", "pi.dev token response"),
		expires_in: requireNumber(record, "expires_in", "pi.dev token response"),
		scope: requireString(record, "scope", "pi.dev token response"),
	};
}

function credentialFromTokenResponse(response: PiDevTokenResponse): OAuthCredential {
	return {
		type: "oauth",
		access: response.access_token,
		refresh: response.refresh_token,
		expires: Date.now() + response.expires_in * 1000,
		scope: response.scope,
	};
}

function credentialScope(credential: OAuthCredential): string | undefined {
	const scope = credential.scope;
	return typeof scope === "string" ? scope : undefined;
}

export function hasPiDevScopes(scope: string | undefined, requiredScopes: readonly string[]): boolean {
	const availableScopes = new Set(scopesFromString(scope));
	return requiredScopes.every((requiredScope) => availableScopes.has(requiredScope));
}

function getMergedLoginScopes(authStorage: AuthStorage, requiredScopes: readonly string[]): string[] {
	const credential = authStorage.get(PI_DEV_OAUTH_PROVIDER_ID);
	const existingScopes = credential?.type === "oauth" ? scopesFromString(credentialScope(credential)) : [];
	return withPiDevOfflineAccess([...existingScopes, ...requiredScopes]);
}

export async function startPiDevDeviceFlow(options: PiDevDeviceFlowOptions): Promise<PiDevDeviceFlowResponse> {
	const fields: Record<string, string> = {
		client_id: PI_DEV_OAUTH_CLIENT_ID,
		scope: formatPiDevScopes(withPiDevOfflineAccess(options.scopes)),
	};
	if (options.deviceId) fields.device_id = options.deviceId;
	const response = await getPiDevFetch(options.fetch)(getPiDevApiUrl("/api/oauth/device", options.baseUrl), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: createFormBody(fields),
		signal: options.signal,
	});
	await throwIfPiDevNotOk(response, "POST /api/oauth/device", options.errorClass);
	return parseDeviceFlowResponse(await readJson(response));
}

export async function pollPiDevDeviceToken(
	deviceCode: string,
	options: PiDevDeviceTokenOptions = {},
): Promise<PiDevTokenResponse> {
	const response = await getPiDevFetch(options.fetch)(getPiDevApiUrl("/api/oauth/token", options.baseUrl), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: createFormBody({
			grant_type: PI_DEV_DEVICE_CODE_GRANT,
			client_id: PI_DEV_OAUTH_CLIENT_ID,
			device_code: deviceCode,
		}),
		signal: options.signal,
	});
	await throwIfPiDevNotOk(response, "POST /api/oauth/token device_code", options.errorClass);
	return parseTokenResponse(await readJson(response));
}

export async function refreshPiDevAccessToken(
	refreshToken: string,
	options: PiDevRefreshTokenOptions = {},
): Promise<PiDevTokenResponse> {
	const response = await getPiDevFetch(options.fetch)(getPiDevApiUrl("/api/oauth/token", options.baseUrl), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: createFormBody({
			grant_type: "refresh_token",
			client_id: PI_DEV_OAUTH_CLIENT_ID,
			refresh_token: refreshToken,
		}),
	});
	await throwIfPiDevNotOk(response, "POST /api/oauth/token refresh_token", options.errorClass);
	return parseTokenResponse(await readJson(response));
}

export async function introspectPiDevAccessToken(
	accessToken: string,
	options: PiDevApiOptions = {},
): Promise<PiDevAccessIntrospectionResult> {
	const response = await getPiDevFetch(options.fetch)(getPiDevApiUrl("/api/oauth/introspect", options.baseUrl), {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	const data = await readJsonObject(response);
	if (!response.ok || data?.active !== true) {
		return { active: false };
	}
	return {
		active: true,
		scope: stringField(data, "scope"),
		sessionShareAccess: data.session_share_access === true,
	};
}

async function refreshPiDevCredential(credential: OAuthCredential, options: PiDevApiOptions): Promise<OAuthCredential> {
	return credentialFromTokenResponse(await refreshPiDevAccessToken(credential.refresh, options));
}

function introspectionSatisfiesScopes(
	introspection: PiDevAccessIntrospectionResult,
	requiredScopes: readonly string[],
): boolean {
	if (!introspection.active) return false;
	if (hasPiDevScopes(introspection.scope, requiredScopes)) return true;
	return (
		requiredScopes.length === 1 &&
		requiredScopes[0] === PI_DEV_SESSION_SHARE_SCOPE &&
		introspection.sessionShareAccess === true
	);
}

export async function getPiDevAuth(
	authStorage: AuthStorage,
	requiredScopes: readonly string[],
	options: PiDevAuthOptions = {},
): Promise<PiDevAuthResult> {
	let credential = authStorage.get(PI_DEV_OAUTH_PROVIDER_ID);
	if (credential?.type !== "oauth") {
		return { available: false, reason: "unauthenticated" };
	}

	if (options.forceRefresh || Date.now() >= credential.expires) {
		try {
			credential = await refreshPiDevCredential(credential, options);
			authStorage.set(PI_DEV_OAUTH_PROVIDER_ID, credential);
		} catch (error) {
			if (error instanceof PiDevApiError && error.errorCode === "invalid_grant") {
				authStorage.remove(PI_DEV_OAUTH_PROVIDER_ID);
			}
			return { available: false, reason: "invalid_token" };
		}
	}

	const scope = credentialScope(credential);
	if (scope) {
		return hasPiDevScopes(scope, requiredScopes)
			? { available: true, accessToken: credential.access }
			: { available: false, reason: "missing_scope" };
	}

	try {
		const introspection = await introspectPiDevAccessToken(credential.access, options);
		if (!introspection.active) return { available: false, reason: "invalid_token" };
		return introspectionSatisfiesScopes(introspection, requiredScopes)
			? { available: true, accessToken: credential.access }
			: { available: false, reason: "missing_scope" };
	} catch {
		return { available: false, reason: "invalid_token" };
	}
}

export async function loginPiDev(authStorage: AuthStorage, options: PiDevLoginOptions): Promise<OAuthCredential> {
	const scopes = getMergedLoginScopes(authStorage, options.scopes);
	const started = await startPiDevDeviceFlow({
		baseUrl: options.baseUrl,
		fetch: options.fetch,
		signal: options.signal,
		scopes,
		deviceId: options.deviceId,
	});
	options.onDeviceCode?.({
		userCode: started.user_code,
		verificationUri: started.verification_uri_complete || started.verification_uri,
		displayVerificationUri: started.verification_uri,
		intervalSeconds: started.interval,
		expiresInSeconds: started.expires_in,
	});
	const token = await pollOAuthDeviceCodeFlow<PiDevTokenResponse>({
		intervalSeconds: started.interval,
		expiresInSeconds: started.expires_in,
		signal: options.signal,
		poll: async () => {
			try {
				return {
					status: "complete",
					value: await pollPiDevDeviceToken(started.device_code, {
						baseUrl: options.baseUrl,
						fetch: options.fetch,
						signal: options.signal,
					}),
				};
			} catch (error) {
				if (error instanceof PiDevApiError && error.errorCode === "authorization_pending") {
					return { status: "pending" };
				}
				if (error instanceof PiDevApiError && error.errorCode === "slow_down") {
					return { status: "slow_down" };
				}
				return {
					status: "failed",
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
	});
	const credential = credentialFromTokenResponse(token);
	authStorage.set(PI_DEV_OAUTH_PROVIDER_ID, credential);
	return credential;
}
