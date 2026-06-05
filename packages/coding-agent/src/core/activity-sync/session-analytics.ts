import { createHash } from "crypto";
import type { SessionEntry, SessionHeader } from "../session-manager.ts";

export const SESSION_ANALYTICS_SCHEMA_VERSION = 1;

export interface SessionAnalyticsUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	costTotal: number;
}

export interface SessionAnalyticsContentStats {
	stringContent: boolean;
	textBlocks: number;
	imageBlocks: number;
	thinkingBlocks: number;
	redactedThinkingBlocks: number;
	toolCallBlocks: number;
	otherBlocks: number;
}

export interface SessionAnalyticsSessionRecord {
	recordType: "session";
	schemaVersion: typeof SESSION_ANALYTICS_SCHEMA_VERSION;
	sessionId: string;
	version?: number;
	createdAt?: string;
	modifiedAt?: string;
	parentSessionHash?: string;
}

export interface SessionAnalyticsEntryRecord {
	recordType: "entry";
	schemaVersion: typeof SESSION_ANALYTICS_SCHEMA_VERSION;
	sessionId: string;
	entryId: string;
	parentEntryId: string | null;
	entryType: string;
	timestamp: string;

	// Message-level metadata. Raw content, tool arguments, thinking text, and errors are intentionally omitted.
	role?: string;
	api?: string;
	provider?: string;
	model?: string;
	responseModel?: string;
	stopReason?: string;
	hasError?: boolean;
	usage?: SessionAnalyticsUsage;
	contentStats?: SessionAnalyticsContentStats;
	isError?: boolean;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
	excludeFromContext?: boolean;

	// Non-message entry metadata. Raw summaries, labels, names, custom data, and details are intentionally omitted.
	modelId?: string;
	thinkingLevel?: string;
	activeToolCount?: number;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	fromHook?: boolean;
	hasDetails?: boolean;
	fromId?: string;
	customType?: string;
	display?: boolean;
	hasData?: boolean;
	targetId?: string | null;
	hasLabel?: boolean;
	hasName?: boolean;
}

export type SessionAnalyticsRecord = SessionAnalyticsSessionRecord | SessionAnalyticsEntryRecord;

export interface ProjectSessionHeaderAnalyticsOptions {
	modifiedAt?: Date | string;
	hashString?: (value: string) => string;
}

export interface ProjectSessionAnalyticsOptions extends ProjectSessionHeaderAnalyticsOptions {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function maybeString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function maybeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNumber(value: unknown): number {
	return maybeNumber(value) ?? 0;
}

function modifiedAtToString(value: Date | string | undefined): string | undefined {
	if (value instanceof Date) return value.toISOString();
	return maybeString(value);
}

function cleanRecord<T extends object>(record: T): T {
	const mutableRecord = record as Record<string, unknown>;
	for (const key of Object.keys(mutableRecord)) {
		if (mutableRecord[key] === undefined) delete mutableRecord[key];
	}
	return record;
}

export function hashSessionAnalyticsString(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function projectSessionHeaderForAnalytics(
	header: SessionHeader,
	options: ProjectSessionHeaderAnalyticsOptions = {},
): SessionAnalyticsSessionRecord {
	const hash = options.hashString ?? hashSessionAnalyticsString;
	return cleanRecord({
		recordType: "session",
		schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
		sessionId: header.id,
		version: header.version,
		createdAt: maybeString(header.timestamp),
		modifiedAt: modifiedAtToString(options.modifiedAt),
		parentSessionHash: header.parentSession ? hash(header.parentSession) : undefined,
	});
}

function projectUsageForAnalytics(usage: unknown): SessionAnalyticsUsage | undefined {
	if (!isRecord(usage)) return undefined;
	const cost = isRecord(usage.cost) ? usage.cost : undefined;
	return {
		input: asNumber(usage.input),
		output: asNumber(usage.output),
		cacheRead: asNumber(usage.cacheRead),
		cacheWrite: asNumber(usage.cacheWrite),
		totalTokens: asNumber(usage.totalTokens),
		costInput: asNumber(cost?.input),
		costOutput: asNumber(cost?.output),
		costCacheRead: asNumber(cost?.cacheRead),
		costCacheWrite: asNumber(cost?.cacheWrite),
		costTotal: asNumber(cost?.total),
	};
}

function projectContentStatsForAnalytics(content: unknown): SessionAnalyticsContentStats {
	const stats: SessionAnalyticsContentStats = {
		stringContent: false,
		textBlocks: 0,
		imageBlocks: 0,
		thinkingBlocks: 0,
		redactedThinkingBlocks: 0,
		toolCallBlocks: 0,
		otherBlocks: 0,
	};

	if (typeof content === "string") {
		stats.stringContent = true;
		if (content.length > 0) stats.textBlocks = 1;
		return stats;
	}

	if (!Array.isArray(content)) {
		stats.otherBlocks = 1;
		return stats;
	}

	for (const block of content) {
		if (!isRecord(block)) {
			stats.otherBlocks++;
			continue;
		}
		switch (block.type) {
			case "text":
				stats.textBlocks++;
				break;
			case "image":
				stats.imageBlocks++;
				break;
			case "thinking":
				stats.thinkingBlocks++;
				if (block.redacted === true) stats.redactedThinkingBlocks++;
				break;
			case "toolCall":
				stats.toolCallBlocks++;
				break;
			default:
				stats.otherBlocks++;
				break;
		}
	}

	return stats;
}

function createEntryBase(sessionId: string, entry: SessionEntry): SessionAnalyticsEntryRecord {
	return {
		recordType: "entry",
		schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
		sessionId,
		entryId: entry.id,
		parentEntryId: entry.parentId,
		entryType: entry.type,
		timestamp: entry.timestamp,
	};
}

function projectMessageEntryForAnalytics(sessionId: string, entry: Extract<SessionEntry, { type: "message" }>) {
	const base = createEntryBase(sessionId, entry);
	const message = isRecord(entry.message) ? entry.message : undefined;
	const role = maybeString(message?.role) ?? "unknown";

	if (role === "assistant") {
		return cleanRecord({
			...base,
			role,
			api: maybeString(message?.api),
			provider: maybeString(message?.provider),
			model: maybeString(message?.model),
			responseModel: maybeString(message?.responseModel),
			stopReason: maybeString(message?.stopReason),
			hasError:
				Boolean(message?.errorMessage) || message?.stopReason === "error" || message?.stopReason === "aborted",
			usage: projectUsageForAnalytics(message?.usage),
			contentStats: projectContentStatsForAnalytics(message?.content),
		});
	}

	if (role === "user") return { ...base, role, contentStats: projectContentStatsForAnalytics(message?.content) };

	if (role === "toolResult") {
		return {
			...base,
			role,
			isError: message?.isError === true,
			contentStats: projectContentStatsForAnalytics(message?.content),
		};
	}

	if (role === "bashExecution") {
		return cleanRecord({
			...base,
			role,
			exitCode: maybeNumber(message?.exitCode),
			cancelled: message?.cancelled === true,
			truncated: message?.truncated === true,
			excludeFromContext: message?.excludeFromContext === true,
		});
	}

	if (role === "custom") {
		return cleanRecord({
			...base,
			role,
			customType: maybeString(message?.customType),
			display: typeof message?.display === "boolean" ? message.display : undefined,
			contentStats: projectContentStatsForAnalytics(message?.content),
		});
	}

	return { ...base, role };
}

export function projectSessionEntryForAnalytics(sessionId: string, entry: SessionEntry): SessionAnalyticsEntryRecord {
	switch (entry.type) {
		case "message":
			return projectMessageEntryForAnalytics(sessionId, entry);
		case "model_change":
			return { ...createEntryBase(sessionId, entry), provider: entry.provider, modelId: entry.modelId };
		case "thinking_level_change":
			return { ...createEntryBase(sessionId, entry), thinkingLevel: entry.thinkingLevel };
		case "compaction":
			return cleanRecord({
				...createEntryBase(sessionId, entry),
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
				fromHook: entry.fromHook,
				hasDetails: entry.details !== undefined,
			});
		case "branch_summary":
			return cleanRecord({
				...createEntryBase(sessionId, entry),
				fromId: entry.fromId,
				fromHook: entry.fromHook,
				hasDetails: entry.details !== undefined,
			});
		case "custom":
			return cleanRecord({
				...createEntryBase(sessionId, entry),
				customType: entry.customType,
				hasData: entry.data !== undefined,
			});
		case "custom_message":
			return cleanRecord({
				...createEntryBase(sessionId, entry),
				customType: entry.customType,
				display: entry.display,
				hasDetails: entry.details !== undefined,
				contentStats: projectContentStatsForAnalytics(entry.content),
			});
		case "label":
			return cleanRecord({
				...createEntryBase(sessionId, entry),
				targetId: entry.targetId,
				hasLabel: typeof entry.label === "string" && entry.label.length > 0,
			});
		case "session_info":
			return { ...createEntryBase(sessionId, entry), hasName: Boolean(entry.name?.trim()) };
		default:
			return createEntryBase(sessionId, entry);
	}
}

export function projectSessionForAnalytics(
	header: SessionHeader,
	entries: SessionEntry[],
	options: ProjectSessionAnalyticsOptions = {},
): SessionAnalyticsRecord[] {
	const session = projectSessionHeaderForAnalytics(header, options);
	return [session, ...entries.map((entry) => projectSessionEntryForAnalytics(session.sessionId, entry))];
}
