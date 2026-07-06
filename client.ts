/**
 * Cadent Cable - Client
 * Generic room-based WebSocket relay server for Bun.
 *
 * @author Takuto Yanagida
 * @version 2026-07-06
 */

import type {
	CreateRoomOptions,
	CreateRoomResult,
	RelayEvent
} from './types';
import {
	buildWebSocketUrl,
	joinUrl,
	normalizeApprovalRatio,
	normalizeDisplayName,
	normalizeId,
} from './utils';

export type RelayConnectionOptions<TPayload = unknown> = {
	serverUrl      : string;
	roomId         : string;
	displayName    : string;
	ownerToken?    : string;
	autoSync?      : boolean;
	syncIntervalMs?: number;
	onEvent?       : (event: RelayEvent<TPayload>) => void;
};

export class RelayConnection<TPayload = unknown> {
	readonly serverUrl  : string;
	readonly roomId     : string;
	readonly displayName: string;
	readonly ownerToken?: string;

	playerId          : string | null = null;
	rtt               : number | null = null;
	offsetToServerTime: number | null = null;

	#ws            : WebSocket | null = null;
	#syncTimer     : number | null    = null;
	#onEvent       : (event: RelayEvent<TPayload>) => void;
	#autoSync      : boolean;
	#syncIntervalMs: number;

	constructor(options: RelayConnectionOptions<TPayload>) {
		this.serverUrl       = options.serverUrl;
		this.roomId          = normalizeId(options.roomId);
		this.displayName     = normalizeDisplayName(options.displayName);
		this.ownerToken      = options.ownerToken;
		this.#onEvent        = options.onEvent ?? (() => {});
		this.#autoSync       = options.autoSync ?? true;
		this.#syncIntervalMs = options.syncIntervalMs ?? 3000;
	}

	connect(): Promise<void> {
		if (this.#ws !== null) return Promise.resolve();

		return new Promise((resolve, reject) => {
			const url = buildWebSocketUrl(this.serverUrl, 'ws', {
				roomId     : this.roomId,
				displayName: this.displayName,
				ownerToken : this.ownerToken ?? '',
			});
			const ws = new WebSocket(url);
			this.#ws = ws;

			ws.addEventListener('open', () => {
				this.#emit({ type: 'open' } satisfies RelayEvent);
				if (this.#autoSync) this.startSync();
				resolve();
			});
			ws.addEventListener('message', (ev) => this.#handleMessage(ev.data));

			ws.addEventListener('close', (ev) => {
				this.stopSync();
				this.#ws = null;
				this.#emit({ type: 'close', code: ev.code, reason: ev.reason } satisfies RelayEvent);
			});
			ws.addEventListener('error', () => {
				this.#emit({ type: 'error', code: 'websocket_error' } satisfies RelayEvent);
				reject(new Error('WebSocket connection failed.'));
			});
		});
	}

	disconnect(): void {
		this.stopSync();
		this.#ws?.close();
		this.#ws = null;
	}

	sendData(payload: TPayload): void {
		this.#send({ type: 'data', clientTime: performance.now(), payload });
	}

	approve(requestId: string): void {
		this.#send({ type: 'approve', requestId });
	}

	syncOnce(): void {
		this.#send({ type: 'syncRequest', clientSendTime: performance.now() });
	}

	startSync(): void {
		this.stopSync();
		this.syncOnce();
		this.#syncTimer = window.setInterval(() => this.syncOnce(), this.#syncIntervalMs);
	}

	stopSync(): void {
		if (this.#syncTimer !== null) {
			window.clearInterval(this.#syncTimer);
			this.#syncTimer = null;
		}
	}

	#send(value: unknown): void {
		if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
			throw new Error('WebSocket is not open.');
		}
		this.#ws.send(JSON.stringify(value));
	}

	#handleMessage(data: unknown): void {
		if (typeof data !== 'string') {
			this.#emit({ type: 'error', code: 'unsupported_message', message: 'Only JSON text messages are supported.' } satisfies RelayEvent);
			return;
		}
		let msg: RelayEvent;
		try {
			msg = JSON.parse(data) as RelayEvent;
		} catch {
			this.#emit({ type: 'error', code: 'invalid_json', message: 'Received invalid JSON.' } satisfies RelayEvent);
			return;
		}
		if (msg.type === 'joined') {
			this.playerId = msg.playerId as string;
		}
		if (msg.type === 'syncResponse') {
			this.#send({
				type          : 'syncReport',
				clientSendTime: msg.clientSendTime,
				serverRecvTime: msg.serverRecvTime,
				serverSendTime: msg.serverSendTime,
				clientRecvTime: performance.now(),
			} satisfies RelayEvent);
			return;
		}
		if (msg.type === 'syncStatus') {
			this.rtt                = msg.rtt as number;
			this.offsetToServerTime = msg.offsetToServerTime as number;
		}
		this.#emit(msg as RelayEvent<TPayload>);
	}

	#emit(event: RelayEvent<TPayload>): void {
		this.#onEvent(event);
	}
}

export async function createRoom(serverUrl: string, options: CreateRoomOptions = {}): Promise<CreateRoomResult> {
	const res = await fetch(joinUrl(serverUrl, 'rooms'), {
		method : 'POST',
		headers: { 'Content-Type': 'application/json' },
		body   : JSON.stringify({
			roomId       : options.roomId ?? null,
			roomMode     : options.roomMode ?? 'broadcast',
			approvalRatio: normalizeApprovalRatio(options.approvalRatio),
		} satisfies CreateRoomOptions),
	});
	const json = await res.json() as any;
	if (!res.ok || !json.ok) {
		throw new Error(json.error ?? `Failed to create room: ${res.status}`);
	}
	return json as CreateRoomResult;
}
