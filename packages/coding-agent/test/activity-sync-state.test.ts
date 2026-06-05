import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getStableActivitySyncDeviceId,
	loadActivitySyncState,
	saveActivitySyncState,
	withActivitySyncLock,
} from "../src/core/activity-sync/state.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-activity-sync-state-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("activity sync state", () => {
	it("loads and saves sync state", async () => {
		const agentDir = createTempDir();
		await saveActivitySyncState({ lastAttemptAt: "2026-01-01T00:00:00.000Z" }, agentDir);

		expect(await loadActivitySyncState(agentDir)).toEqual({
			lastAttemptAt: "2026-01-01T00:00:00.000Z",
			lastSuccessAt: undefined,
		});
	});

	it("stores stable sync settings under piDev", () => {
		const settings = SettingsManager.inMemory({
			piDev: { activitySync: { intervalHours: 12 } },
		});
		const first = getStableActivitySyncDeviceId(settings);
		const second = getStableActivitySyncDeviceId(settings);
		settings.setActivitySyncEnabled(true);

		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(settings.getGlobalSettings().piDev?.activitySync?.deviceId).toBe(first);
		expect(settings.getActivitySyncSettings()).toEqual({
			enabled: true,
			intervalHours: 24,
		});
		expect(settings.getGlobalSettings().piDev?.activitySync).toEqual({
			deviceId: first,
			enabled: true,
			intervalHours: 24,
		});
	});

	it("returns already_running when the sync lock is held", async () => {
		const agentDir = createTempDir();
		const result = await withActivitySyncLock(
			async () => withActivitySyncLock(async () => "inner", agentDir),
			agentDir,
		);

		expect(result).toEqual({
			status: "acquired",
			result: { status: "already_running" },
		});
	});
});
