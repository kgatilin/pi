import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";
import { normalizePath } from "../../utils/paths.ts";
import type { SettingsManager } from "../settings-manager.ts";

export interface ActivitySyncState {
	lastAttemptAt?: string;
	lastSuccessAt?: string;
}

export type ActivitySyncLockResult<T> = { status: "acquired"; result: T } | { status: "already_running" };

export interface ActivitySyncStatePaths {
	agentDir: string;
	statePath: string;
	lockPath: string;
}

export function getActivitySyncStatePaths(agentDir: string = getAgentDir()): ActivitySyncStatePaths {
	const resolvedAgentDir = normalizePath(agentDir);
	return {
		agentDir: resolvedAgentDir,
		statePath: join(resolvedAgentDir, "activity-sync.json"),
		lockPath: join(resolvedAgentDir, "activity-sync.lock"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseActivitySyncState(value: unknown): ActivitySyncState {
	if (!isRecord(value)) return {};
	return {
		lastAttemptAt: isString(value.lastAttemptAt) ? value.lastAttemptAt : undefined,
		lastSuccessAt: isString(value.lastSuccessAt) ? value.lastSuccessAt : undefined,
	};
}

export async function loadActivitySyncState(agentDir?: string): Promise<ActivitySyncState> {
	const { statePath } = getActivitySyncStatePaths(agentDir);
	try {
		return parseActivitySyncState(JSON.parse(await readFile(statePath, "utf8")));
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
		if (code === "ENOENT") return {};
		throw error;
	}
}

export async function saveActivitySyncState(state: ActivitySyncState, agentDir?: string): Promise<void> {
	const { statePath } = getActivitySyncStatePaths(agentDir);
	await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
	await writeFile(statePath, JSON.stringify(state, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
}

export async function updateActivitySyncState(
	updater: (state: ActivitySyncState) => ActivitySyncState,
	agentDir?: string,
): Promise<ActivitySyncState> {
	const next = updater(await loadActivitySyncState(agentDir));
	await saveActivitySyncState(next, agentDir);
	return next;
}

function isLockError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && String(error.code) === "ELOCKED";
}

export async function withActivitySyncLock<T>(
	fn: () => Promise<T>,
	agentDir?: string,
): Promise<ActivitySyncLockResult<T>> {
	const { lockPath } = getActivitySyncStatePaths(agentDir);
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	if (!existsSync(lockPath)) await writeFile(lockPath, "", { mode: 0o600 });
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(lockPath, {
			stale: 10 * 60 * 1000,
			update: 30 * 1000,
			retries: 0,
			realpath: false,
		});
	} catch (error) {
		if (isLockError(error)) return { status: "already_running" };
		throw error;
	}

	try {
		return { status: "acquired", result: await fn() };
	} finally {
		if (release) await release();
	}
}

export function getStableActivitySyncDeviceId(settingsManager: SettingsManager): string {
	const existing = settingsManager.getActivitySyncDeviceId();
	if (existing) return existing;
	const deviceId = randomUUID();
	settingsManager.setActivitySyncDeviceId(deviceId);
	return deviceId;
}
