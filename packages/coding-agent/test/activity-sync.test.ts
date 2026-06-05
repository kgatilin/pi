import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncSessionAnalytics } from "../src/core/activity-sync/activity-sync.ts";
import { loadActivitySyncState } from "../src/core/activity-sync/state.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-activity-sync-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function writeSessionFile(sessionsRoot: string): void {
	const sessionDir = join(sessionsRoot, "default");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, "session-1.jsonl"),
		`${[
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			{
				type: "model_change",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				provider: "openai",
				modelId: "gpt-4.1",
			},
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`,
	);
}

function createActivitySyncAuthStorage(refresh = "refresh-1"): AuthStorage {
	return AuthStorage.inMemory({
		"pi.dev": {
			type: "oauth",
			access: "access-old",
			refresh,
			expires: Date.now() - 1,
			scope: "activity_sync offline_access",
		},
	});
}

describe("syncSessionAnalytics", () => {
	it("returns not_authenticated after recording lastAttemptAt", async () => {
		const agentDir = createTempDir();
		const result = await syncSessionAnalytics({
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			now: new Date("2026-01-01T00:00:00.000Z"),
		});

		expect(result).toEqual({ status: "not_authenticated" });
		expect(await loadActivitySyncState(agentDir)).toMatchObject({
			lastAttemptAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("updates lastAttemptAt on no_changes", async () => {
		const agentDir = createTempDir();
		const sessionsRoot = createTempDir();
		const authStorage = createActivitySyncAuthStorage();
		const fetchMock: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url.endsWith("/api/oauth/token")) {
				return jsonResponse({
					token_type: "Bearer",
					access_token: "access-1",
					refresh_token: "refresh-2",
					expires_in: 86400,
					scope: "activity_sync offline_access",
				});
			}
			return jsonResponse({ ok: true, watermark: null });
		};

		const result = await syncSessionAnalytics({
			agentDir,
			sessionsRoot,
			settingsManager: SettingsManager.inMemory(),
			authStorage,
			fetch: fetchMock,
			now: new Date("2026-01-02T00:00:00.000Z"),
		});

		expect(result).toMatchObject({
			status: "no_changes",
			filesScanned: 0,
			serverWatermark: null,
		});
		expect(await loadActivitySyncState(agentDir)).toMatchObject({
			lastAttemptAt: "2026-01-02T00:00:00.000Z",
		});
		expect(authStorage.get("pi.dev")).toMatchObject({ refresh: "refresh-2" });
	});

	it("clears stale pi.dev credentials that the server rejects", async () => {
		const agentDir = createTempDir();
		const authStorage = createActivitySyncAuthStorage();
		const fetchMock: typeof fetch = async () =>
			jsonResponse({ error: "invalid_grant", description: "stale refresh token" }, 400);

		const result = await syncSessionAnalytics({
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			authStorage,
			fetch: fetchMock,
			now: new Date("2026-01-02T00:00:00.000Z"),
		});

		expect(result).toEqual({ status: "not_authenticated" });
		expect(authStorage.get("pi.dev")).toBeUndefined();
		expect(await loadActivitySyncState(agentDir)).toMatchObject({
			lastAttemptAt: "2026-01-02T00:00:00.000Z",
		});
	});

	it("uploads with an idempotency key without persisting payload files", async () => {
		const agentDir = createTempDir();
		const sessionsRoot = createTempDir();
		writeSessionFile(sessionsRoot);
		const authStorage = createActivitySyncAuthStorage();
		const idempotencyKeys: string[] = [];
		const fetchMock: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url.endsWith("/api/oauth/token")) {
				return jsonResponse({
					token_type: "Bearer",
					access_token: "access-1",
					refresh_token: "refresh-2",
					expires_in: 86400,
					scope: "activity_sync offline_access",
				});
			}
			if (request.method === "GET") return jsonResponse({ ok: true, watermark: null });
			idempotencyKeys.push(request.headers.get("Idempotency-Key") ?? "");
			expect((await request.arrayBuffer()).byteLength).toBeGreaterThan(0);
			return jsonResponse({
				ok: true,
				accepted: true,
				received_bytes: 21,
				watermark: "2026-01-02T00:00:00.000Z",
			});
		};

		const result = await syncSessionAnalytics({
			agentDir,
			sessionsRoot,
			settingsManager: SettingsManager.inMemory(),
			authStorage,
			fetch: fetchMock,
			now: new Date("2026-01-03T00:00:00.000Z"),
		});

		expect(result).toMatchObject({
			status: "uploaded",
			recordsSent: 2,
			serverWatermark: null,
			watermark: "2026-01-02T00:00:00.000Z",
		});
		expect(idempotencyKeys).toHaveLength(1);
		expect(idempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(existsSync(join(agentDir, "activity-sync-payloads"))).toBe(false);
		expect(await loadActivitySyncState(agentDir)).toMatchObject({
			lastSuccessAt: "2026-01-03T00:00:00.000Z",
		});
		expect(authStorage.get("pi.dev")).toMatchObject({ refresh: "refresh-2" });
	});

	it("includes the server watermark when upload fails", async () => {
		const agentDir = createTempDir();
		const sessionsRoot = createTempDir();
		writeSessionFile(sessionsRoot);
		const authStorage = createActivitySyncAuthStorage();
		const fetchMock: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url.endsWith("/api/oauth/token")) {
				return jsonResponse({
					token_type: "Bearer",
					access_token: "access-1",
					refresh_token: "refresh-2",
					expires_in: 86400,
					scope: "activity_sync offline_access",
				});
			}
			if (request.method === "GET")
				return jsonResponse({
					ok: true,
					watermark: "2026-01-01T00:00:00.000Z",
				});
			return jsonResponse({}, 503);
		};

		const result = await syncSessionAnalytics({
			agentDir,
			sessionsRoot,
			settingsManager: SettingsManager.inMemory(),
			authStorage,
			fetch: fetchMock,
			now: new Date("2026-01-03T00:00:00.000Z"),
		});

		expect(result).toMatchObject({
			status: "failed",
			serverWatermark: "2026-01-01T00:00:00.000Z",
			error: "POST /analytics/activity/:deviceId failed: HTTP 503",
		});
	});
});
