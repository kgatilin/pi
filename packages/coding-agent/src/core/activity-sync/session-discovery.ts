import type { Dirent } from "fs";
import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { basename, dirname, join, relative, resolve } from "path";
import { createInterface } from "readline";
import { getSessionsDir } from "../../config.ts";
import type { SessionHeader } from "../session-manager.ts";

export type SessionDiscoveryPhase = "scan" | "read";

export interface SessionDiscoveryProgress {
	phase: SessionDiscoveryPhase;
	foundFiles: number;
	processedFiles: number;
	sessions: number;
	currentFile?: string;
}

export type SessionDiscoveryProgressCallback = (progress: SessionDiscoveryProgress) => void;

export interface DiscoverSessionFilesOptions {
	/** Root sessions directory. Defaults to ~/.pi/agent/sessions. */
	sessionsRoot?: string;
	signal?: AbortSignal;
	onProgress?: SessionDiscoveryProgressCallback;
}

export interface DiscoverSessionsOptions extends DiscoverSessionFilesOptions {}

export interface DiscoveredSession {
	path: string;
	relativePath: string;
	sessionDir: string;
	sessionDirName: string;
	header: SessionHeader;
	sessionId: string;
	cwd: string;
	createdAt?: Date;
	modifiedAt: Date;
	sizeBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseSessionHeader(value: unknown): SessionHeader | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "session") return undefined;
	if (typeof value.id !== "string" || !value.id) return undefined;
	if (typeof value.timestamp !== "string" || !value.timestamp) return undefined;
	if (typeof value.cwd !== "string") return undefined;
	if (value.version !== undefined && typeof value.version !== "number") return undefined;
	if (value.parentSession !== undefined && typeof value.parentSession !== "string") return undefined;
	return {
		type: "session",
		version: value.version,
		id: value.id,
		timestamp: value.timestamp,
		cwd: value.cwd,
		parentSession: value.parentSession,
	};
}

function parseDate(value: string): Date | undefined {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function emitProgress(
	onProgress: SessionDiscoveryProgressCallback | undefined,
	progress: SessionDiscoveryProgress,
): void {
	onProgress?.({ ...progress });
}

async function walkSessionFiles(
	dir: string,
	files: string[],
	progress: SessionDiscoveryProgress,
	signal: AbortSignal | undefined,
	onProgress: SessionDiscoveryProgressCallback | undefined,
): Promise<void> {
	if (signal?.aborted) return;
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (signal?.aborted) return;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkSessionFiles(path, files, progress, signal, onProgress);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		files.push(path);
		progress.foundFiles = files.length;
		emitProgress(onProgress, progress);
	}
}

export async function discoverSessionFiles(options: DiscoverSessionFilesOptions = {}): Promise<string[]> {
	const sessionsRoot = resolve(options.sessionsRoot ?? getSessionsDir());
	const files: string[] = [];
	const progress: SessionDiscoveryProgress = {
		phase: "scan",
		foundFiles: 0,
		processedFiles: 0,
		sessions: 0,
	};
	emitProgress(options.onProgress, progress);
	await walkSessionFiles(sessionsRoot, files, progress, options.signal, options.onProgress);
	files.sort((a, b) => a.localeCompare(b));
	return files;
}

async function readSessionHeader(filePath: string): Promise<SessionHeader | undefined> {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.trim()) return undefined;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return undefined;
			}
			return parseSessionHeader(parsed);
		}
		return undefined;
	} finally {
		lines.close();
		stream.destroy();
	}
}

async function discoverSessionFromFile(sessionsRoot: string, filePath: string): Promise<DiscoveredSession | undefined> {
	const [fileStats, header] = await Promise.all([stat(filePath), readSessionHeader(filePath)]);
	if (!header) return undefined;
	const sessionDir = dirname(filePath);
	return {
		path: filePath,
		relativePath: relative(sessionsRoot, filePath),
		sessionDir,
		sessionDirName: basename(sessionDir),
		header,
		sessionId: header.id,
		cwd: header.cwd,
		createdAt: parseDate(header.timestamp),
		modifiedAt: fileStats.mtime,
		sizeBytes: fileStats.size,
	};
}

export async function discoverSessions(options: DiscoverSessionsOptions = {}): Promise<DiscoveredSession[]> {
	const sessionsRoot = resolve(options.sessionsRoot ?? getSessionsDir());
	const files = await discoverSessionFiles({ sessionsRoot, signal: options.signal, onProgress: options.onProgress });
	const sessions: DiscoveredSession[] = [];
	const progress: SessionDiscoveryProgress = {
		phase: "read",
		foundFiles: files.length,
		processedFiles: 0,
		sessions: 0,
	};
	emitProgress(options.onProgress, progress);

	for (const filePath of files) {
		if (options.signal?.aborted) break;
		emitProgress(options.onProgress, { ...progress, currentFile: filePath });
		const session = await discoverSessionFromFile(sessionsRoot, filePath).catch(() => undefined);
		progress.processedFiles++;
		if (session) {
			sessions.push(session);
			progress.sessions = sessions.length;
		}
		emitProgress(options.onProgress, { ...progress, currentFile: filePath });
	}

	return sessions;
}
