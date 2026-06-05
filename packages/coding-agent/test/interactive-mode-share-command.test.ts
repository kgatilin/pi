import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ShareCommandMode } from "../src/core/pi-dev/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PiDevAuthOptions = { title: string; deviceId?: string; forceLogin?: boolean };

type ShareCommandContext = {
	session: { modelRegistry: { authStorage: AuthStorage } };
	ensurePiDevAuthenticated: (
		requiredScopes: readonly string[],
		options: PiDevAuthOptions,
	) => Promise<string | undefined>;
	handleGitHubShareCommand: () => Promise<void>;
	handlePiDevShareCommand: (accessToken: string, mode: ShareCommandMode) => Promise<void>;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
};

type InteractiveModePrototype = {
	handleShareCommand(this: ShareCommandContext, text: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createContext(authStorage: AuthStorage): ShareCommandContext {
	return {
		session: { modelRegistry: { authStorage } },
		ensurePiDevAuthenticated: vi.fn(async () => "piga_login"),
		handleGitHubShareCommand: vi.fn(async () => {}),
		handlePiDevShareCommand: vi.fn(async () => {}),
		showError: vi.fn(),
		showStatus: vi.fn(),
	};
}

describe("InteractiveMode /share", () => {
	it("falls back to GitHub gist for default shares when pi.dev is not authenticated", async () => {
		const context = createContext(AuthStorage.inMemory());

		await interactiveModePrototype.handleShareCommand.call(context, "/share");

		expect(context.handleGitHubShareCommand).toHaveBeenCalledTimes(1);
		expect(context.ensurePiDevAuthenticated).not.toHaveBeenCalled();
		expect(context.handlePiDevShareCommand).not.toHaveBeenCalled();
	});

	it("uses pi.dev for default shares when pi.dev auth is available", async () => {
		const context = createContext(
			AuthStorage.inMemory({
				"pi.dev": {
					type: "oauth",
					access: "piga_share",
					refresh: "pigr_share",
					expires: Date.now() + 60_000,
					scope: "session_share offline_access",
				},
			}),
		);

		await interactiveModePrototype.handleShareCommand.call(context, "/share");

		expect(context.handlePiDevShareCommand).toHaveBeenCalledWith("piga_share", "auto");
		expect(context.ensurePiDevAuthenticated).not.toHaveBeenCalled();
		expect(context.handleGitHubShareCommand).not.toHaveBeenCalled();
	});

	it("keeps explicit pi.dev shares as an authenticated pi.dev flow", async () => {
		const context = createContext(AuthStorage.inMemory());

		await interactiveModePrototype.handleShareCommand.call(context, "/share pi.dev");

		expect(context.ensurePiDevAuthenticated).toHaveBeenCalledWith(["session_share"], {
			title: "Create pi.dev profile to share sessions",
		});
		expect(context.handlePiDevShareCommand).toHaveBeenCalledWith("piga_login", "pi.dev");
		expect(context.handleGitHubShareCommand).not.toHaveBeenCalled();
	});
});
