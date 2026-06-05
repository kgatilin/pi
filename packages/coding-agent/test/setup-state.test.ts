import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getPendingSetupStepIds,
	hasPendingSetupSteps,
	markSetupStepComplete,
	readSetupState,
} from "../src/core/setup-state.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-setup-state-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("setup state", () => {
	it("prompts new users for pi.dev profiles before telemetry", () => {
		const agentDir = createTempDir();

		expect(getPendingSetupStepIds(agentDir)).toEqual(["pi-dev-profile", "telemetry"]);
	});

	it("prompts existing setup users for the pi.dev profile step", () => {
		const agentDir = createTempDir();
		writeFileSync(
			join(agentDir, "setup.json"),
			JSON.stringify({
				schemaVersion: 1,
				completedVersion: 1,
				steps: {
					telemetry: { completedAt: "2026-01-01T00:00:00.000Z", setupVersion: 1 },
					login: { completedAt: "2026-01-01T00:00:00.000Z", setupVersion: 1 },
				},
			}),
		);

		expect(getPendingSetupStepIds(agentDir)).toEqual(["pi-dev-profile"]);

		markSetupStepComplete("pi-dev-profile", agentDir, new Date("2026-01-02T00:00:00.000Z"));

		expect(hasPendingSetupSteps(agentDir)).toBe(false);
		expect(readSetupState(agentDir)?.completedVersion).toBe(1);
	});
});
