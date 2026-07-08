/**
 * Cadent Cable - Client
 * Generic room-based WebSocket relay server for Bun.
 *
 * @author Takuto Yanagida
 * @version 2026-07-08
 */

import {
	ROUTE,
	ROOM_MODE,
	EVENT_TYPE,
	type CreateRoomOptions,
	type CreateRoomResult,
	type RelayEvent
} from './protocol';
import {
	normalizeId,
	normalizeDisplayName,
	normalizeApprovalRatio,
	joinUrl,
	buildWebSocketUrl,
} from './utils';
import {
	browserRuntime,
	CC_WS_OPEN,
	type CCWebSocket,
	type CCRuntime,
	type CCTimerId,
} from './runtime';

export type RelayConnectionOptions<TPayload = unknown> = {
	serverUrl      : string;
	roomId         : string;
	displayName    : string;
	ownerToken?    : string;
	memberId?      : string;
	resumeToken?   : string;
	autoSync?      : boolean;
	syncIntervalMs?: number;
	onEvent?       : (event: RelayEvent<TPayload>) => void;
	runtime?       : CCRuntime;
};

export class RelayConnection<TPayload = unknown> {
	readonly serverUrl  : string;
	readonly roomId     : string;
	readonly ownerToken?: string;

	displayName       : string;
	memberId          : string | null;
	resumeToken       : string | null;
	rtt               : number | null = null;
	offsetToServerTime: number | null = null;

	#runtime       : CCRuntime;
	#ws            : CCWebSocket | null = null;
	#syncTimer     : CCTimerId | null = null;
	#onEvent       : (event: RelayEvent<TPayload>) => void;
	#autoSync      : boolean;
	#syncIntervalMs: number;

	constructor(options: RelayConnectionOptions<TPayload>) {
		this.serverUrl       = options.serverUrl;
		this.roomId          = normalizeId(options.roomId);
		this.displayName     = normalizeDisplayName(options.displayName);
		this.ownerToken      = options.ownerToken;
		this.memberId        = options.memberId && options.memberId !== '' ? options.memberId : null;
		this.resumeToken     = options.resumeToken && options.resumeToken !== '' ? options.resumeToken : null;
		this.#runtime        = options.runtime ?? browserRuntime;
		this.#onEvent        = options.onEvent ?? (() => {});
		this.#autoSync       = options.autoSync ?? true;
		this.#syncIntervalMs = options.syncIntervalMs ?? 3000;
	}

	setDisplayName(displayName: string): void {
		this.displayName = normalizeDisplayName(displayName);
	}

	join(): Promise<void> {
		if (this.#ws !== null) return Promise.resolve();

		if ((this.memberId === null) !== (this.resumeToken === null)) {
			return Promise.reject(new Error('Both memberId and resumeToken are required to resume.'));
		}

		return new Promise((resolve, reject) => {
			const url = buildWebSocketUrl(this.serverUrl, ROUTE.ws, {
				roomId     : this.roomId,
				displayName: this.displayName,
				ownerToken : this.ownerToken ?? '',
				memberId   : this.memberId ?? '',
				resumeToken: this.resumeToken ?? '',
			});
			const ws = this.#runtime.webSocketFactory.create(url);
			this.#ws = ws;

			ws.addEventListener('open', () => {
				this.#emit({ type: EVENT_TYPE.open } satisfies RelayEvent);
				if (this.#autoSync) this.startSync();
				resolve();
			});
			ws.addEventListener('message', (ev) => this.#handleMessage(ev.data));

			ws.addEventListener('close', (ev) => {
				this.stopSync();
				this.#ws = null;
				this.#emit({ type: EVENT_TYPE.close, code: ev.code, reason: ev.reason } satisfies RelayEvent);
			});
			ws.addEventListener('error', () => {
				this.#emit(makeErrorMessage('websocket_error'));
				reject(new Error('WebSocket connection failed.'));
			});
		});
	}

	leave(): void {
		const ws = this.#ws;

		if (ws && ws.readyState === CC_WS_OPEN) {
			ws.send(JSON.stringify(makeLeaveMessage()));
		}

		this.memberId = null;
		this.resumeToken = null;

		this.stopSync();
		this.#ws = null;
		ws?.close();
	}

	sendData(payload: TPayload): void {
		this.#send(makeDataMessage(this.#runtime.clock.now(), payload));
	}

	approve(requestId: string): void {
		this.#send(makeApproveMessage(requestId));
	}

	syncOnce(): void {
		this.#send(makeSyncRequestMessage(this.#runtime.clock.now()));
	}

	startSync(): void {
		this.stopSync();
		this.syncOnce();
		this.#syncTimer = this.#runtime.timer.setInterval(() => this.syncOnce(), this.#syncIntervalMs);
	}

	stopSync(): void {
		if (this.#syncTimer !== null) {
			this.#runtime.timer.clearInterval(this.#syncTimer);
			this.#syncTimer = null;
		}
	}

	#send(value: unknown): void {
		if (!this.#ws || this.#ws.readyState !== CC_WS_OPEN) {
			throw new Error('WebSocket is not open.');
		}
		this.#ws.send(JSON.stringify(value));
	}

	#handleMessage(data: unknown): void {
		if (typeof data !== 'string') {
			this.#emit(makeErrorMessage('unsupported_message', 'Only JSON text messages are supported.'));
			return;
		}
		let msg: RelayEvent;
		try {
			msg = JSON.parse(data) as RelayEvent;
		} catch {
			this.#emit(makeErrorMessage('invalid_json', 'Received invalid JSON.'));
			return;
		}
		if (msg.type === EVENT_TYPE.joined) {
			this.memberId    = msg.memberId as string;
			this.resumeToken = msg.resumeToken as string;
			this.displayName = msg.displayName as string;
		}
		if (msg.type === EVENT_TYPE.syncResponse) {
			this.#send(makeSyncReportMessage(msg.clientSendTime, msg.serverRecvTime, msg.serverSendTime, this.#runtime.clock.now()));
			return;
		}
		if (msg.type === EVENT_TYPE.syncStatus) {
			this.rtt                = msg.rtt as number;
			this.offsetToServerTime = msg.offsetToServerTime as number;
		}
		this.#emit(msg as RelayEvent<TPayload>);
	}

	#emit(event: RelayEvent<TPayload>): void {
		this.#onEvent(event);
	}
}

export async function createRoom(serverUrl: string, options: CreateRoomOptions = {}, runtime: CCRuntime = browserRuntime): Promise<CreateRoomResult> {
	return runtime.http.postJson<CreateRoomOptions, CreateRoomResult>(joinUrl(serverUrl, ROUTE.rooms), {
		roomId       : options.roomId ?? null,
		roomMode     : options.roomMode ?? ROOM_MODE.broadcast,
		approvalRatio: normalizeApprovalRatio(options.approvalRatio),
	});
}

// -----------------------------------------------------------------------------

export function makeDataMessage<TPayload>(clientTime: number, payload: TPayload) {
	return { type: EVENT_TYPE.data, clientTime, payload } satisfies RelayEvent<TPayload>;
}

export function makeApproveMessage(requestId: string) {
	return { type: EVENT_TYPE.approve, requestId } satisfies RelayEvent;
}

export function makeLeaveMessage() {
	return { type: EVENT_TYPE.leave } satisfies RelayEvent;
}

export function makeSyncRequestMessage(clientSendTime: number) {
	return { type: EVENT_TYPE.syncRequest, clientSendTime } satisfies RelayEvent;
}

export function makeSyncReportMessage(
	clientSendTime: number,
	serverRecvTime: number,
	serverSendTime: number,
	clientRecvTime: number,
) {
	return {
		type: EVENT_TYPE.syncReport,
		clientSendTime,
		serverRecvTime,
		serverSendTime,
		clientRecvTime,
	} satisfies RelayEvent;
}

export function makeErrorMessage(code: string, message?: string) {
	return { type: EVENT_TYPE.error, code, message } satisfies RelayEvent;
}
