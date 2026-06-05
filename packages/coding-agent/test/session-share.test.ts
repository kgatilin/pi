import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	formatPiDevShareSuccess,
	getPiDevBaseUrl,
	getPiDevShareAuth,
	loginPiDevShare,
	parseShareCommand,
	uploadPiDevSessionShare,
} from "../src/core/pi-dev/index.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("session share client", () => {
	it("parses share modes", () => {
		expect(parseShareCommand("/share")).toEqual({ ok: true, mode: "auto" });
		expect(parseShareCommand("/share pi.dev")).toEqual({ ok: true, mode: "pi.dev" });
		expect(parseShareCommand("/share github")).toEqual({ ok: true, mode: "github" });
		expect(parseShareCommand("/share nope")).toEqual({ ok: false, message: "Usage: /share [pi.dev|github]" });
	});

	it("treats missing pi.dev auth as unavailable", async () => {
		const authStorage = AuthStorage.inMemory();
		await expect(getPiDevShareAuth(authStorage)).resolves.toEqual({ available: false, reason: "unauthenticated" });
	});

	it("treats pi.dev auth without session_share scope as unavailable", async () => {
		const authStorage = AuthStorage.inMemory({
			"pi.dev": {
				type: "oauth",
				access: "piga_old",
				refresh: "pigr_old",
				expires: Date.now() + 60_000,
				scope: "offline_access",
			},
		});

		await expect(getPiDevShareAuth(authStorage)).resolves.toEqual({ available: false, reason: "missing_scope" });
	});

	it("accepts pi.dev auth with session_share scope", async () => {
		const authStorage = AuthStorage.inMemory({
			"pi.dev": {
				type: "oauth",
				access: "piga_share",
				refresh: "pigr_share",
				expires: Date.now() + 60_000,
				scope: "session_share offline_access",
			},
		});

		await expect(getPiDevShareAuth(authStorage)).resolves.toEqual({ available: true, accessToken: "piga_share" });
	});

	it("refreshes expired pi.dev share tokens without a pi-ai OAuth provider", async () => {
		vi.stubEnv("PI_DEV_URL", "http://127.0.0.1:8787/");
		const authStorage = AuthStorage.inMemory({
			"pi.dev": {
				type: "oauth",
				access: "piga_old",
				refresh: "pigr_old",
				expires: Date.now() - 1,
				scope: "session_share offline_access",
			},
		});
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			if (!(init?.body instanceof URLSearchParams)) {
				throw new Error("Expected form body");
			}
			expect(init.body.get("grant_type")).toBe("refresh_token");
			expect(init.body.get("client_id")).toBe("pi-coding-agent");
			expect(init.body.get("refresh_token")).toBe("pigr_old");
			return Response.json({
				access_token: "piga_new",
				refresh_token: "pigr_new",
				expires_in: 86400,
				scope: "session_share offline_access",
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(getPiDevShareAuth(authStorage)).resolves.toEqual({ available: true, accessToken: "piga_new" });
		expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/api/oauth/token", expect.any(Object));
		expect(authStorage.get("pi.dev")).toMatchObject({ access: "piga_new", refresh: "pigr_new" });
	});

	it("runs pi.dev share device auth without a pi-ai OAuth provider", async () => {
		vi.stubEnv("PI_DEV_URL", "http://127.0.0.1:8787/");
		const authStorage = AuthStorage.inMemory();
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			if (!(init?.body instanceof URLSearchParams)) {
				throw new Error("Expected form body");
			}
			if (input === "http://127.0.0.1:8787/api/oauth/device") {
				expect(init.body.get("client_id")).toBe("pi-coding-agent");
				expect(init.body.get("scope")).toBe("session_share offline_access");
				return Response.json({
					device_code: "pigd_123",
					user_code: "ABCD-EFGH",
					verification_uri: "http://127.0.0.1:8787/pair",
					verification_uri_complete: "http://127.0.0.1:8787/pair?code=ABCD-EFGH",
					expires_in: 300,
					interval: 1,
				});
			}
			if (input === "http://127.0.0.1:8787/api/oauth/token") {
				expect(init.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(init.body.get("client_id")).toBe("pi-coding-agent");
				expect(init.body.get("device_code")).toBe("pigd_123");
				return Response.json({
					access_token: "piga_new",
					refresh_token: "pigr_new",
					expires_in: 86400,
					scope: "session_share offline_access",
				});
			}
			throw new Error(`Unexpected fetch URL: ${String(input)}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const deviceCodes: Array<{ userCode: string; verificationUri: string }> = [];

		const credential = await loginPiDevShare(authStorage, {
			onDeviceCode: (info) => deviceCodes.push({ userCode: info.userCode, verificationUri: info.verificationUri }),
		});

		expect(credential.access).toBe("piga_new");
		expect(authStorage.get("pi.dev")).toMatchObject({ access: "piga_new", refresh: "pigr_new" });
		expect(deviceCodes).toEqual([
			{ userCode: "ABCD-EFGH", verificationUri: "http://127.0.0.1:8787/pair?code=ABCD-EFGH" },
		]);
	});

	it("uploads HTML to the pi.dev share endpoint", async () => {
		const bytes = Buffer.from("<html>ok</html>");
		const calls: Array<Parameters<typeof fetch>> = [];
		const fetchFn: typeof fetch = async (input, init) => {
			calls.push([input, init]);
			return Response.json({ ok: true, id: "psh_123", url: "https://pi.dev/session/#pi/psh_123" }, { status: 201 });
		};

		const result = await uploadPiDevSessionShare({
			accessToken: "piga_share",
			bytes,
			byteSize: bytes.byteLength,
			baseUrl: "https://pi.dev/",
			fetchFn,
		});

		expect(result).toEqual({ id: "psh_123", url: "https://pi.dev/session/#pi/psh_123" });
		expect(calls).toHaveLength(1);
		const [url, init] = calls[0]!;
		expect(url).toBe("https://pi.dev/api/session-shares");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({
			Authorization: "Bearer piga_share",
			"Content-Type": "text/html; charset=utf-8",
			"Content-Length": String(bytes.byteLength),
		});
		expect(init?.body).toBe(bytes);
	});

	it("uses PI_DEV_URL for pi.dev API base URL", () => {
		vi.stubEnv("PI_DEV_URL", "http://127.0.0.1:8787/");
		expect(getPiDevBaseUrl()).toBe("http://127.0.0.1:8787");
	});

	it("formats successful pi.dev share output with unlisted warning", () => {
		expect(formatPiDevShareSuccess("https://pi.dev/session/#pi/psh_123")).toBe(
			"Share URL: https://pi.dev/session/#pi/psh_123\nStored on pi.dev as an unlisted session share.\nAnyone with this link can view it.",
		);
	});
});
