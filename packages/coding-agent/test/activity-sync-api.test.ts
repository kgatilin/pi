import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	type ActivitySyncApiError,
	getActivitySyncWatermark,
	refreshActivitySyncAccessToken,
	startActivitySyncDeviceFlow,
	uploadSessionAnalytics,
} from "../src/core/activity-sync/api.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("activity sync api", () => {
	it("starts the OAuth device flow with the activity sync scope", async () => {
		let request: Request | undefined;
		const fetchMock: typeof fetch = async (input, init) => {
			request = new Request(input, init);
			return jsonResponse({
				device_code: "pigd_1",
				user_code: "ABCD-EFGH",
				verification_uri: "https://pi.dev/pair",
				verification_uri_complete: "https://pi.dev/pair?code=ABCD-EFGH",
				expires_in: 300,
				interval: 2,
			});
		};

		const response = await startActivitySyncDeviceFlow("00000000-0000-4000-8000-000000000000", {
			baseUrl: "https://example.test/",
			fetch: fetchMock,
		});

		expect(response.device_code).toBe("pigd_1");
		expect(request?.url).toBe("https://example.test/api/oauth/device");
		expect(request?.method).toBe("POST");
		const body = new URLSearchParams(await request?.text());
		expect(body.get("client_id")).toBe("pi-coding-agent");
		expect(body.get("scope")).toBe("activity_sync offline_access");
		expect(body.get("device_id")).toBe("00000000-0000-4000-8000-000000000000");
	});

	it("refreshes tokens and reads watermarks", async () => {
		const urls: string[] = [];
		const fetchMock: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			urls.push(request.url);
			if (request.url.endsWith("/api/oauth/token")) {
				return jsonResponse({
					token_type: "Bearer",
					access_token: "access-2",
					refresh_token: "refresh-2",
					expires_in: 86400,
					scope: "activity_sync offline_access",
				});
			}
			expect(request.headers.get("Authorization")).toBe("Bearer access-2");
			return jsonResponse({ ok: true, watermark: "2026-01-01T00:00:00.000Z" });
		};

		const token = await refreshActivitySyncAccessToken("refresh-1", {
			baseUrl: "https://example.test",
			fetch: fetchMock,
		});
		const watermark = await getActivitySyncWatermark(token.access_token, "device-1", {
			baseUrl: "https://example.test",
			fetch: fetchMock,
		});

		expect(token.refresh_token).toBe("refresh-2");
		expect(watermark.watermark).toBe("2026-01-01T00:00:00.000Z");
		expect(urls).toEqual([
			"https://example.test/api/oauth/token",
			"https://example.test/analytics/activity/device-1",
		]);
	});

	it("uploads compressed NDJSON with sync headers and surfaces API errors", async () => {
		let request: Request | undefined;
		const fetchMock: typeof fetch = async (input, init) => {
			request = new Request(input, init);
			return jsonResponse(
				{
					ok: true,
					accepted: true,
					received_bytes: 10,
					watermark: "2026-01-02T00:00:00.000Z",
				},
				202,
			);
		};

		const response = await uploadSessionAnalytics({
			baseUrl: "https://example.test",
			fetch: fetchMock,
			accessToken: "access-1",
			deviceId: "device-1",
			watermark: "2026-01-02T00:00:00.000Z",
			idempotencyKey: "retry-key",
			body: Buffer.from("payload"),
			contentEncoding: "zstd",
		});

		expect(response.accepted).toBe(true);
		expect(request?.headers.get("Authorization")).toBe("Bearer access-1");
		expect(request?.headers.get("Content-Type")).toBe("application/x-ndjson");
		expect(request?.headers.get("Content-Encoding")).toBe("zstd");
		expect(request?.headers.get("Pi-Sync-Watermark")).toBe("2026-01-02T00:00:00.000Z");
		expect(request?.headers.get("Idempotency-Key")).toBe("retry-key");

		const failingFetch: typeof fetch = async () =>
			jsonResponse({ ok: false, error: "invalid_payload", description: "bad line" }, 400);
		await expect(
			uploadSessionAnalytics({
				baseUrl: "https://example.test",
				fetch: failingFetch,
				accessToken: "access-1",
				deviceId: "device-1",
				watermark: "2026-01-02T00:00:00.000Z",
				idempotencyKey: "retry-key",
				body: Buffer.from("payload"),
				contentEncoding: "zstd",
			}),
		).rejects.toMatchObject({
			name: "ActivitySyncApiError",
			status: 400,
			errorCode: "invalid_payload",
			description: "bad line",
			operation: "POST /analytics/activity/:deviceId",
			message: "POST /analytics/activity/:deviceId failed: invalid_payload: bad line",
		} satisfies Partial<ActivitySyncApiError>);
	});
});
