import {
	type Component,
	type Container,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../core/settings-manager.ts";
import {
	getAllSetupStepIds,
	getPendingSetupStepIds,
	markSetupStepComplete,
	type SetupStepId,
} from "../../core/setup-state.ts";
import { getSelectListTheme, theme } from "./theme/theme.ts";

type SetupWizardMode = "automatic" | "manual";
type SetupStepOutcome = "completed" | "cancelled" | { profileRequested: true };

const SETUP_LOGO_LINES = ["██████", "██  ██", "████  ██", "██    ██"];

interface SetupWizardMountOptions {
	parent: Container;
	before: Component;
}

export interface SetupWizardOptions {
	tui: TUI;
	settingsManager: SettingsManager;
	agentDir: string;
	mode: SetupWizardMode;
	steps?: readonly SetupStepId[];
	container: Container;
	mount?: SetupWizardMountOptions;
	focusAfter?: Component;
}

export interface SetupWizardResult {
	completed: boolean;
	cancelled: boolean;
	completedSteps: SetupStepId[];
	profileRequested?: boolean;
}

function mountSetupContainer(options: SetupWizardOptions): void {
	if (!options.mount || options.mount.parent.children.includes(options.container)) {
		return;
	}

	const insertIndex = options.mount.parent.children.indexOf(options.mount.before);
	if (insertIndex === -1) {
		options.mount.parent.addChild(options.container);
		return;
	}
	options.mount.parent.children.splice(insertIndex, 0, options.container);
}

function unmountSetupContainer(options: SetupWizardOptions): void {
	if (options.mount) {
		options.mount.parent.removeChild(options.container);
	}
}

function showSetupComponent(options: SetupWizardOptions, component: Component): () => void {
	mountSetupContainer(options);
	options.container.clear();
	options.container.addChild(component);
	options.tui.setFocus(component);
	options.tui.requestRender();
	return () => {
		options.container.clear();
		unmountSetupContainer(options);
		options.tui.setFocus(options.focusAfter ?? null);
		options.tui.requestRender();
	};
}

function pushSetupLogo(lines: string[], width: number): void {
	for (const line of SETUP_LOGO_LINES) {
		lines.push(truncateToWidth(`  ${theme.fg("accent", line)}`, width, ""));
	}
	lines.push("");
}

class PiDevProfileSetupComponent implements Component {
	private readonly selectList: SelectList;

	constructor(onCreateProfile: () => void, onSkip: () => void) {
		const items: SelectItem[] = [
			{
				value: "create-profile",
				label: "Create profile / Sign in",
				description: "Enable background sync of usage activity and store /share sessions",
			},
			{
				value: "skip",
				label: "Continue without profile",
				description: "Use local sessions; create a profile later with /share",
			},
		];
		this.selectList = new SelectList(items, items.length, getSelectListTheme(), {
			minPrimaryColumnWidth: 30,
			maxPrimaryColumnWidth: 34,
		});
		this.selectList.onSelect = (item) => {
			if (item.value === "create-profile") {
				onCreateProfile();
				return;
			}
			onSkip();
		};
		this.selectList.onCancel = onSkip;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const push = (line = "") => lines.push(truncateToWidth(line, width, ""));

		pushSetupLogo(lines, width);
		push(`  ${theme.fg("accent", theme.bold("Welcome to Pi, the minimal coding agent."))}`);
		push();
		lines.push(...this.selectList.render(width));
		push();
		push(`  ${theme.fg("dim", "Enter to continue · Esc to skip")}`);

		return lines;
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	invalidate(): void {
		this.selectList.invalidate();
	}
}

class TelemetryConsentComponent implements Component {
	private readonly selectList: SelectList;
	private readonly hint: string;
	private readonly showWelcome: boolean;

	constructor(
		currentEnabled: boolean,
		onSelect: (enabled: boolean) => void,
		onCancel: () => void,
		hint: string,
		showWelcome: boolean,
	) {
		this.hint = hint;
		this.showWelcome = showWelcome;
		const items: SelectItem[] = [
			{
				value: "disabled",
				label: "Do not send",
				description: "Default. Disable analytics reporting",
			},
			{
				value: "enabled",
				label: "Allow",
				description: "Send anonymous analytics to help improve Pi",
			},
		];
		this.selectList = new SelectList(items, items.length, getSelectListTheme(), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 24,
		});
		this.selectList.setSelectedIndex(currentEnabled ? 1 : 0);
		this.selectList.onSelect = (item) => {
			onSelect(item.value === "enabled");
		};
		this.selectList.onCancel = onCancel;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const push = (line = "") => lines.push(truncateToWidth(line, width, ""));
		const description =
			"Allow Pi to send anonymous diagnostics to improve reliability. This includes version/update analytics. Prompts, responses, file contents, and API keys are not sent.";

		pushSetupLogo(lines, width);
		if (this.showWelcome) {
			push(`  ${theme.fg("accent", theme.bold("Welcome to Pi."))}`);
			push();
		}
		push(`  ${theme.fg("accent", theme.bold("Analytics reporting"))}`);
		push();
		for (const line of wrapTextWithAnsi(theme.fg("muted", description), Math.max(1, width - 4))) {
			push(`  ${line}`);
		}
		push();
		lines.push(...this.selectList.render(width));
		push();
		push(`  ${theme.fg("dim", this.hint)}`);

		return lines;
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	invalidate(): void {
		this.selectList.invalidate();
	}
}

async function runTelemetrySetupStep(
	options: SetupWizardOptions,
	isFinalStep: boolean,
	showWelcome: boolean,
): Promise<SetupStepOutcome> {
	return new Promise((resolve) => {
		let closeComponent: (() => void) | undefined;
		let closed = false;

		const finish = (outcome: SetupStepOutcome) => {
			if (closed) {
				return;
			}
			closed = true;
			closeComponent?.();
			options.tui.requestRender();
			resolve(outcome);
		};

		const saveTelemetry = (enabled: boolean) => {
			void (async () => {
				options.settingsManager.setTelemetryEnabled(enabled);
				await options.settingsManager.flush();
				markSetupStepComplete("telemetry", options.agentDir);
				finish("completed");
			})();
		};

		const cancel = () => {
			finish("cancelled");
		};

		const automaticHint = isFinalStep ? "Enter to save and finish" : "Enter to save and continue";
		const manualHint = isFinalStep ? "Enter to save · Esc to cancel" : "Enter to save and continue · Esc to cancel";
		const consent = new TelemetryConsentComponent(
			options.settingsManager.getTelemetryEnabled(),
			saveTelemetry,
			cancel,
			options.mode === "automatic" ? automaticHint : manualHint,
			showWelcome,
		);
		closeComponent = showSetupComponent(options, consent);
	});
}

async function runPiDevProfileSetupStep(options: SetupWizardOptions): Promise<SetupStepOutcome> {
	return new Promise((resolve) => {
		let closeComponent: (() => void) | undefined;
		let closed = false;

		const finish = (outcome: SetupStepOutcome) => {
			if (closed) {
				return;
			}
			closed = true;
			markSetupStepComplete("pi-dev-profile", options.agentDir);
			closeComponent?.();
			options.tui.requestRender();
			resolve(outcome);
		};

		const profile = new PiDevProfileSetupComponent(
			() => finish({ profileRequested: true }),
			() => finish("completed"),
		);
		closeComponent = showSetupComponent(options, profile);
	});
}

async function runSetupStep(
	options: SetupWizardOptions,
	step: SetupStepId,
	isFinalStep: boolean,
): Promise<SetupStepOutcome> {
	switch (step) {
		case "pi-dev-profile":
			return runPiDevProfileSetupStep(options);
		case "telemetry":
			return runTelemetrySetupStep(options, isFinalStep, false);
	}
}

async function completeAutomaticSetupWithDefaults(
	options: SetupWizardOptions,
	steps: SetupStepId[],
	completedSteps: SetupStepId[],
	profileRequested: boolean,
): Promise<SetupWizardResult> {
	const completedSet = new Set(completedSteps);
	const completeStep = (step: SetupStepId) => {
		if (completedSet.has(step)) {
			return;
		}
		markSetupStepComplete(step, options.agentDir);
		completedSet.add(step);
		completedSteps.push(step);
	};

	if (steps.includes("telemetry") && !completedSet.has("telemetry")) {
		options.settingsManager.setTelemetryEnabled(false);
		completeStep("telemetry");
	}

	if (steps.includes("pi-dev-profile") && !completedSet.has("pi-dev-profile")) {
		completeStep("pi-dev-profile");
	}

	await options.settingsManager.flush();
	return { completed: true, cancelled: false, completedSteps, profileRequested };
}

export async function runSetupWizard(options: SetupWizardOptions): Promise<SetupWizardResult> {
	const steps = [
		...(options.steps ??
			(options.mode === "manual" ? getAllSetupStepIds() : getPendingSetupStepIds(options.agentDir))),
	];
	const completedSteps: SetupStepId[] = [];
	let profileRequested = false;
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		const outcome = await runSetupStep(options, step, index === steps.length - 1);
		if (outcome === "cancelled") {
			if (options.mode === "automatic") {
				return completeAutomaticSetupWithDefaults(options, steps, completedSteps, profileRequested);
			}
			return { completed: false, cancelled: true, completedSteps, profileRequested };
		}
		if (typeof outcome === "object") {
			profileRequested = outcome.profileRequested;
		}
		completedSteps.push(step);
	}

	return { completed: true, cancelled: false, completedSteps, profileRequested };
}
