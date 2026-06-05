export const PI_DEV_DEFAULT_BASE_URL = "https://pi.dev";
export const PI_DEV_OAUTH_CLIENT_ID = "pi-coding-agent";
export const PI_DEV_OAUTH_PROVIDER_ID = "pi.dev";
export const PI_DEV_OFFLINE_ACCESS_SCOPE = "offline_access";
export const PI_DEV_SESSION_SHARE_SCOPE = "session_share";
export const PI_DEV_ACTIVITY_SYNC_SCOPE = "activity_sync";
export const PI_DEV_PROFILE_SCOPES = [PI_DEV_ACTIVITY_SYNC_SCOPE, PI_DEV_SESSION_SHARE_SCOPE] as const;

export function normalizePiDevBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

export function getPiDevBaseUrl(baseUrl?: string): string {
	return normalizePiDevBaseUrl(baseUrl ?? process.env.PI_DEV_URL ?? PI_DEV_DEFAULT_BASE_URL);
}

export function formatPiDevScopes(scopes: readonly string[]): string {
	return Array.from(new Set(scopes)).join(" ");
}

export function scopesFromString(scope: string | undefined): string[] {
	return scope?.split(/\s+/).filter((part) => part.length > 0) ?? [];
}

export function withPiDevOfflineAccess(scopes: readonly string[]): string[] {
	return Array.from(new Set([...scopes, PI_DEV_OFFLINE_ACCESS_SCOPE]));
}
