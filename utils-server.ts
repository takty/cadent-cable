/**
 * Utilities for servers
 *
 * @author Takuto Yanagida
 * @version 2026-07-07
 */

export function getEnvInt(name: string, fb: number): number {
	const v = Bun.env[name];
	if (v === undefined || v === '') return fb;

	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : fb;
}

export function getEnvBool(name: string, fb: boolean): boolean {
	const v = Bun.env[name];
	if (v === undefined || v === '') return fb;

	return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

// -----------------------------------------------------------------------------

export function getRouteName(pathname: string): string {
	const parts = pathname.split('/').filter(Boolean);
	return parts.at(-1) ?? '';
}

export function getEndpointBaseUrl(reqUrl: string): URL {
	const url = new URL(reqUrl);
	url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/[^/]*$/, '/');
	url.search   = '';
	url.hash     = '';
	return url;
}

// -----------------------------------------------------------------------------

export function jsonResponse(v: unknown, headers = {}, status = 200): Response {
	return new Response(JSON.stringify(v), {
		status,
		headers: {
			...headers,
			'Content-Type': 'application/json; charset=utf-8',
		},
	});
}

// -----------------------------------------------------------------------------

export function createId(pf: string): string {
	return `${pf}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function generateUniqueCode(
	len: number,
	chars: string,
	exists: (code: string) => boolean,
	attempts = 1000
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
