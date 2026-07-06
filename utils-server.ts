/**
 * Utilities for servers
 *
 * @author Takuto Yanagida
 * @version 2026-07-06
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
