import { describe, expect, it } from "vitest";
import {
	projectSessionForAnalytics,
	SESSION_ANALYTICS_SCHEMA_VERSION,
	type SessionAnalyticsRecord,
} from "../src/core/activity-sync/session-analytics.ts";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.ts";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "session-1",
	timestamp: "2026-01-02T03:04:05.000Z",
	cwd: "/tmp/project",
	parentSession: "/tmp/parent.jsonl",
};

const entries: SessionEntry[] = [
	{
		type: "model_change",
		id: "model-1",
		parentId: null,
		timestamp: "2026-01-02T03:04:06.000Z",
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
	},
	{
		type: "message",
		id: "user-1",
		parentId: "model-1",
		timestamp: "2026-01-02T03:04:07.000Z",
		message: {
			role: "user",
			content: [
				{ type: "text", text: "secret user prompt" },
				{ type: "image", data: "secret-image-data", mimeType: "image/png" },
			],
			timestamp: 1767323047000,
		},
	},
	{
		type: "message",
		id: "assistant-1",
		parentId: "user-1",
		timestamp: "2026-01-02T03:04:08.000Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "secret assistant answer" },
				{ type: "thinking", thinking: "secret reasoning" },
				{ type: "thinking", thinking: "", thinkingSignature: "secret-signature", redacted: true },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "secret/path.ts" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			responseModel: "claude-sonnet-4-5-20260101",
			responseId: "secret-response-id",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 30,
				cacheWrite: 40,
				totalTokens: 190,
				cost: {
					input: 0.1,
					output: 0.2,
					cacheRead: 0.03,
					cacheWrite: 0.04,
					total: 0.37,
				},
			},
			stopReason: "toolUse",
			timestamp: 1767323048000,
		},
	},
	{
		type: "message",
		id: "tool-result-1",
		parentId: "assistant-1",
		timestamp: "2026-01-02T03:04:09.000Z",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "secret tool result" }],
			isError: true,
			timestamp: 1767323049000,
		},
	},
	{
		type: "compaction",
		id: "compaction-1",
		parentId: "tool-result-1",
		timestamp: "2026-01-02T03:04:10.000Z",
		summary: "secret compaction summary",
		firstKeptEntryId: "user-1",
		tokensBefore: 1234,
		details: { secret: "compaction details" },
		fromHook: true,
	},
	{
		type: "label",
		id: "label-1",
		parentId: "compaction-1",
		timestamp: "2026-01-02T03:04:11.000Z",
		targetId: "assistant-1",
		label: "secret label",
	},
	{
		type: "session_info",
		id: "session-info-1",
		parentId: "label-1",
		timestamp: "2026-01-02T03:04:12.000Z",
		name: "secret session name",
	},
];

describe("projectSessionForAnalytics", () => {
	it("projects a complete session into ordered analytics records", () => {
		const records = projectSessionForAnalytics(header, entries, {
			modifiedAt: "2026-01-03T04:05:06.000Z",
			hashString: (value) => `hashed:${value}`,
		});

		expect(records).toEqual([
			{
				recordType: "session",
				schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
				sessionId: "session-1",
				version: 3,
				createdAt: "2026-01-02T03:04:05.000Z",
				modifiedAt: "2026-01-03T04:05:06.000Z",
				parentSessionHash: "hashed:/tmp/parent.jsonl",
			},
			{
				recordType: "entry",
				schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
				sessionId: "session-1",
				entryId: "model-1",
				parentEntryId: null,
				entryType: "model_change",
				timestamp: "2026-01-02T03:04:06.000Z",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			},
			{
				recordType: "entry",
				schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
				sessionId: "session-1",
				entryId: "user-1",
				parentEntryId: "model-1",
				entryType: "message",
				timestamp: "2026-01-02T03:04:07.000Z",
				role: "user",
				contentStats: {
					stringContent: false,
					textBlocks: 1,
					imageBlocks: 1,
					thinkingBlocks: 0,
					redactedThinkingBlocks: 0,
					toolCallBlocks: 0,
					otherBlocks: 0,
				},
			},
			{
				recordType: "entry",
				schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
				sessionId: "session-1",
				entryId: "assistant-1",
				parentEntryId: "user-1",
				entryType: "message",
				timestamp: "2026-01-02T03:04:08.000Z",
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				responseModel: "claude-sonnet-4-5-20260101",
				stopReason: "toolUse",
				hasError: false,
				usage: {
					input: 100,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					totalTokens: 190,
					costInput: 0.1,
					costOutput: 0.2,
					costCacheRead: 0.03,
					costCacheWrite: 0.04,
					costTotal: 0.37,
				},
				contentStats: {
					stringContent: false,
					textBlocks: 1,
					imageBlocks: 0,
					thinkingBlocks: 2,
					redactedThinkingBlocks: 1,
					toolCallBlocks: 1,
					otherBlocks: 0,
				},
			},
			{
				recordType: "entry",
				schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
				sessionId: "session-1",
				entryId: "tool-result-1",
				parentEntryId: "assistant-1",
				entryType: "message",
				timestamp: "2026-01-02T03:04:09.000Z",
				role: "toolResult",
				isError: true,
				contentStats: {
					stringContent: false,
					textBlocks: 1,
					imageBlocks: 0,
					thinkingBlocks: 0,
					redactedThinkingBlocks: 0,
					toolCallBlocks: 0,
					otherBlocks: 0,
				},
			},
			{
				recordType: "entry",
				schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
				sessionId: "session-1",
				entryId: "compaction-1",
				parentEntryId: "tool-result-1",
				entryType: "compaction",
				timestamp: "2026-01-02T03:04:10.000Z",
				firstKeptEntryId: "user-1",
				tokensBefore: 1234,
				fromHook: true,
				hasDetails: true,
			},
			{
				recordType: "entry",
				schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
				sessionId: "session-1",
				entryId: "label-1",
				parentEntryId: "compaction-1",
				entryType: "label",
				timestamp: "2026-01-02T03:04:11.000Z",
				targetId: "assistant-1",
				hasLabel: true,
			},
			{
				recordType: "entry",
				schemaVersion: SESSION_ANALYTICS_SCHEMA_VERSION,
				sessionId: "session-1",
				entryId: "session-info-1",
				parentEntryId: "label-1",
				entryType: "session_info",
				timestamp: "2026-01-02T03:04:12.000Z",
				hasName: true,
			},
		] satisfies SessionAnalyticsRecord[]);
	});

	it("omits raw private payload fields", () => {
		const serialized = JSON.stringify(projectSessionForAnalytics(header, entries));

		expect(serialized).not.toContain("secret user prompt");
		expect(serialized).not.toContain("secret assistant answer");
		expect(serialized).not.toContain("secret reasoning");
		expect(serialized).not.toContain("secret-image-data");
		expect(serialized).not.toContain("secret/path.ts");
		expect(serialized).not.toContain("secret tool result");
		expect(serialized).not.toContain("secret compaction summary");
		expect(serialized).not.toContain("compaction details");
		expect(serialized).not.toContain("secret label");
		expect(serialized).not.toContain("secret session name");
		expect(serialized).not.toContain("secret-response-id");
		expect(serialized).not.toContain("/tmp/project");
	});
});
