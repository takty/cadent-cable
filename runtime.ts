export type CCClock = {
	now(): number;
};

export const browserClock: CCClock = {
	now: () => performance.now(),
};

// -----------------------------------------------------------------------------

export type CCTimerId = number;

export type CCTimer = {
	setInterval(callback: () => void, intervalMs: number): CCTimerId;
	clearInterval(id: CCTimerId): void;
};

export const browserTimer: CCTimer = {
	setInterval : (callback, intervalMs) => window.setInterval(callback, intervalMs),
	clearInterval: (id) => window.clearInterval(id),
};

// -----------------------------------------------------------------------------

export type CCWebSocket = {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	addEventListener(type: 'open', listener: () => void): void;
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
	addEventListener(type: 'error', listener: () => void): void;
};

export const CC_WS_OPEN = 1;

export type CCWebSocketFactory = {
	create(url: string): CCWebSocket;
};

export const browserWebSocketFactory: CCWebSocketFactory = {
	create: (url) => new WebSocket(url),
};

// -----------------------------------------------------------------------------

export type CCHttp = {
	postJson<TRequest, TResponse>(url: string, body: TRequest): Promise<TResponse>;
};

export const browserHttp: CCHttp = {
	async postJson<TRequest, TResponse>(url: string, body: TRequest): Promise<TResponse> {
		const res = await fetch(url, {
			method : 'POST',
			headers: { 'Content-Type': 'application/json' },
			body   : JSON.stringify(body),
		});
		const json = await res.json() as any;
		if (!res.ok || !json.ok) {
			throw new Error(json.error ?? `HTTP request failed: ${res.status}`);
		}
		return json as TResponse;
	},
};

// -----------------------------------------------------------------------------

export type CCRuntime = {
	clock           : CCClock;
	timer           : CCTimer;
	webSocketFactory: CCWebSocketFactory;
	http            : CCHttp;
};

export const browserRuntime: CCRuntime = {
	clock           : browserClock,
	timer           : browserTimer,
	webSocketFactory: browserWebSocketFactory,
	http            : browserHttp,
};
