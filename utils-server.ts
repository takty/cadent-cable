/**
 * Utilities for servers
 *
 * @author Takuto Yanagida
 * @version 2026-07-03
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
