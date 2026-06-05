import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

export const SETUP_STEPS = [
	{ id: "pi-dev-profile", introducedIn: 1 },
	{ id: "telemetry", introducedIn: 1 },
] as const;

export const CURRENT_SETUP_VERSION = SETUP_STEPS.reduce(
	(maxVersion, step) => Math.max(maxVersion, step.introducedIn),
	0,
);

export type SetupStepId = (typeof SETUP_STEPS)[number]["id"];

export interface SetupStepState {
	completedAt: string;
	setupVersion: number;
}

export interface SetupState {
	schemaVersion: 1;
	completedVersion: number;
	completedAt?: string;
	steps: Record<string, SetupStepState>;
}

function createEmptySetupState(): SetupState {
	return {
		schemaVersion: 1,
		completedVersion: 0,
		steps: {},
	};
}

function isSetupStepState(value: unknown): value is SetupStepState {
	return (
		typeof value === "object" &&
		value !== null &&
		"completedAt" in value &&
		typeof value.completedAt === "string" &&
		"setupVersion" in value &&
		typeof value.setupVersion === "number" &&
		Number.isFinite(value.setupVersion)
	);
}

function normalizeSetupState(value: unknown): SetupState | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const rawSteps = record.steps;
	const steps: Record<string, SetupStepState> = {};
	if (typeof rawSteps === "object" && rawSteps !== null) {
		for (const [stepId, stepState] of Object.entries(rawSteps)) {
			if (isSetupStepState(stepState)) {
				steps[stepId] = {
					completedAt: stepState.completedAt,
					setupVersion: Math.floor(stepState.setupVersion),
				};
			}
		}
	}

	const completedVersion =
		typeof record.completedVersion === "number" && Number.isFinite(record.completedVersion)
			? Math.max(0, Math.floor(record.completedVersion))
			: computeCompletedVersion(steps);

	const state: SetupState = {
		schemaVersion: 1,
		completedVersion,
		steps,
	};
	if (typeof record.completedAt === "string") {
		state.completedAt = record.completedAt;
	}
	return state;
}

function computeCompletedVersion(steps: Record<string, SetupStepState>): number {
	const versions = Array.from(new Set(SETUP_STEPS.map((step) => step.introducedIn))).sort((a, b) => a - b);
	let completedVersion = 0;
	for (const version of versions) {
		const completeThroughVersion = SETUP_STEPS.every(
			(step) => step.introducedIn > version || steps[step.id] !== undefined,
		);
		if (!completeThroughVersion) {
			break;
		}
		completedVersion = version;
	}
	return completedVersion;
}

function finalizeSetupState(state: SetupState): SetupState {
	const completedVersion = computeCompletedVersion(state.steps);
	const next: SetupState = {
		...state,
		schemaVersion: 1,
		completedVersion,
		steps: { ...state.steps },
	};
	if (SETUP_STEPS.every((step) => next.steps[step.id] !== undefined)) {
		next.completedAt = SETUP_STEPS.reduce<string | undefined>((latest, step) => {
			const completedAt = next.steps[step.id]?.completedAt;
			if (!completedAt) {
				return latest;
			}
			return latest === undefined || completedAt > latest ? completedAt : latest;
		}, next.completedAt);
	} else {
		delete next.completedAt;
	}
	return next;
}

export function getSetupStatePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "setup.json");
}

export function readSetupState(agentDir: string = getAgentDir()): SetupState | undefined {
	const setupPath = getSetupStatePath(agentDir);
	if (!existsSync(setupPath)) {
		return undefined;
	}
	try {
		return normalizeSetupState(JSON.parse(readFileSync(setupPath, "utf-8")));
	} catch {
		return undefined;
	}
}

export function writeSetupState(state: SetupState, agentDir: string = getAgentDir()): void {
	const setupPath = getSetupStatePath(agentDir);
	mkdirSync(dirname(setupPath), { recursive: true });
	writeFileSync(setupPath, `${JSON.stringify(finalizeSetupState(state), null, 2)}\n`, "utf-8");
}

export function getAllSetupStepIds(): SetupStepId[] {
	return SETUP_STEPS.map((step) => step.id);
}

export function getPendingSetupStepIds(agentDir: string = getAgentDir()): SetupStepId[] {
	const state = readSetupState(agentDir) ?? createEmptySetupState();
	return SETUP_STEPS.filter((step) => state.steps[step.id] === undefined).map((step) => step.id);
}

export function hasPendingSetupSteps(agentDir: string = getAgentDir()): boolean {
	return getPendingSetupStepIds(agentDir).length > 0;
}

export function markSetupStepComplete(
	stepId: SetupStepId,
	agentDir: string = getAgentDir(),
	completedAt: Date = new Date(),
): void {
	const state = readSetupState(agentDir) ?? createEmptySetupState();
	const step = SETUP_STEPS.find((candidate) => candidate.id === stepId);
	if (!step) {
		return;
	}
	state.steps[stepId] = {
		completedAt: completedAt.toISOString(),
		setupVersion: step.introducedIn,
	};
	writeSetupState(state, agentDir);
}
