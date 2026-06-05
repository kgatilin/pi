import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("slash commands", () => {
	it("does not expose activity sync as a slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("activity-sync");
	});
});
