/**
 * Utilities
 *
 * @author Takuto Yanagida
 * @version 2026-07-03
 */

export type IdValidationOptions = {
	chars : string;
	minLen: number;
	maxLen: number;
};

export const DEFAULT_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // cspell:disable-line

export function jsonResponse(v: unknown, headers = {}, status = 200): Response {
	return new Response(JSON.stringify(v), {
		status,
		headers: {
			...headers,
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

// ---

export function createId(pf: string): string {
	return `${pf}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function generateUniqueCode(
	len      : number,
	chars    : string,
	exists   : (code: string) => boolean,
	attempts = 1000,
): string {
	for (let i = 0; i < attempts; i++) {
		const c = randomCode(len, chars);
		if (!exists(c)) return c;
	}
	throw new Error('Could not generate a unique code.');
}

function randomCode(len: number, chars: string): string {
	let out = '';
	for (let i = 0; i < len; i++) {
		out += chars[Math.floor(Math.random() * chars.length)];
	}
	return out;
}

export function normalizeId(v: string): string {
	return v.trim().toUpperCase();
}

export function validateId(id: string, opts: IdValidationOptions): string | null {
	if (id.length < opts.minLen) return 'id_too_short';
	if (id.length > opts.maxLen) return 'id_too_long';

	for (const ch of id) {
		if (!opts.chars.includes(ch)) return 'id_has_invalid_character';
	}
	return null;
}

// ---

export function normalizeDisplayName(v: string): string {
	return v.trim();
}

export function validateDisplayName(dn: string, maxLen: number): string | null {
	if (dn.length < 1) return 'display_name_empty';
	if (dn.length > maxLen) return 'display_name_too_long';
	return null;
}

// ---

export function normalizeApprovalRatio(v: unknown): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) return 0.5;
	return v <= 0 ? 0.5 : Math.min(v, 1);
}

// ---

export function joinUrl(serverUrl: string, path: string): string {
	const url = new URL(serverUrl);
	url.pathname = path;
	url.search   = "";
	return url.toString();
}

export function buildWebSocketUrl(baseUrl: string | URL, path: string, params: Record<string, string | number | boolean | null | undefined> = {}, isRelative: boolean = false): string {
	const url = new URL(path, baseUrl);

	switch (url.protocol) {
		case "http:" : url.protocol = "ws:";  break;
		case "https:": url.protocol = "wss:"; break;
		case "ws:"   : break;
		case "wss:"  : break;
		default      : url.protocol = "ws:";
	}
	url.search = "";

	for (const [key, value] of Object.entries(params)) {
		if (value === null || value === undefined || value === "") continue;
		url.searchParams.set(key, String(value));
	}
	if (isRelative) {
		return `${url.pathname}${url.search}`;
	}
	return url.toString();
}
