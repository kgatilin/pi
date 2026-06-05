import { getPiDevBaseUrl } from "./config.ts";

export type PiDevFetch = typeof fetch;

export interface PiDevApiOptions {
	baseUrl?: string;
	fetch?: PiDevFetch;
}

export class PiDevApiError extends Error {
	status: number;
	errorCode?: string;
	description?: string;
	operation?: string;

	constructor(status: number, errorCode: string | undefined, description: string | undefined, operation?: string) {
		const detail = description ? `${errorCode ?? "pi_dev_error"}: ${description}` : (errorCode ?? `HTTP ${status}`);
		super(operation ? `${operation} failed: ${detail}` : detail);
		this.name = "PiDevApiError";
		this.status = status;
		this.errorCode = errorCode;
		this.description = description;
		this.operation = operation;
	}
}

export type PiDevApiErrorCtor = new (
	status: number,
	errorCode: string | undefined,
	description: string | undefined,
	operation?: string,
) => PiDevApiError;

export function getPiDevFetch(fetchImpl: PiDevFetch | undefined): PiDevFetch {
	return fetchImpl ?? fetch;
}

export function getPiDevApiUrl(path: string, baseUrl?: string): string {
	return `${getPiDevBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

export function createFormBody(fields: Record<string, string>): URLSearchParams {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(fields)) {
		body.set(key, value);
	}
	return body;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const field = value?.[key];
	return typeof field === "string" ? field : undefined;
}

export function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
	const field = value?.[key];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export function requireString(record: Record<string, unknown>, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${context}: missing ${key}`);
	return value;
}

export function requireNumber(record: Record<string, unknown>, key: string, context: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${context}: missing ${key}`);
	return value;
}

export async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

export async function readJsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
	const json = await readJson(response);
	return isRecord(json) ? json : undefined;
}

export async function throwIfPiDevNotOk(
	response: Response,
	operation: string,
	ErrorClass: PiDevApiErrorCtor = PiDevApiError,
): Promise<void> {
	if (response.ok) return;
	const json = await readJson(response);
	const errorCode = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
	const description = isRecord(json)
		? typeof json.description === "string"
			? json.description
			: typeof json.error_description === "string"
				? json.error_description
				: undefined
		: undefined;
	throw new ErrorClass(response.status, errorCode, description, operation);
}
