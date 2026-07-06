/**
 * Cadent Cable - Server
 * Generic room-based WebSocket relay server for Bun.
 *
 * - HTTP POST /rooms creates a room and returns { roomId, ownerToken }
 * - WebSocket /ws?roomId=...&displayName=...&ownerToken=... joins a room
 * - One WebSocket connection belongs to exactly one room
 * - Server relays JSON game payloads at 30Hz when data exists
 * - Server sends low-frequency heartbeats when no data exists
 * - Approval rooms require OK votes from active participants
 *
 * @author Takuto Yanagida
 * @version 2026-07-06
 */

import type { Server, ServerWebSocket } from 'bun';
import {
	DEFAULT_ID_CHARS,
	createId,
	generateUniqueCode,
	jsonResponse,
	normalizeApprovalRatio,
	normalizeDisplayName,
	normalizeId,
	validateDisplayName,
	validateId,
	buildWebSocketUrl,
} from './utils';
import { getEnvBool, getEnvInt, getRouteName, getEndpointBaseUrl } from './utils-server';
import type { RoomMode, MemberRole, JoinRequestStatus, CreateRoomOptions, CreateRoomResult, MemberInfo, QueuedMessage, RelayEvent } from './types';

export type TimeoutHandle  = ReturnType<typeof setTimeout>;
type IntervalHandle        = ReturnType<typeof setInterval>;

type ConnState = 'active' | 'pending';

type WSData = {
	connectionId       : string;
	memberId?          : string;
	roomId             : string;
	displayName        : string;
	state              : ConnState;
	role               : MemberRole;
	requestId?         : string;
	offsetToServerTime?: number;
	rtt?               : number;
};

export type WS = ServerWebSocket<WSData>;

export type JoinRequest = {
	requestId        : string;
	roomId           : string;
	ws               : WS;
	displayName      : string;
	requiredApprovals: number;
	approvals        : Set<string>;
	createdAt        : number;
	expiresAt        : number;
	timer            : TimeoutHandle;
};

type Room = {
	roomId        : string;
	roomMode      : RoomMode;
	approvalRatio : number;
	ownerToken    : string;
	receiver?     : WS;
	active        : Set<WS>;
	pending       : Map<string, JoinRequest>;
	queue         : QueuedMessage[];
	tickSeq       : number;
	tickTimer     : IntervalHandle;
	heartbeatTimer: IntervalHandle;
	emptyTimer?   : TimeoutHandle;
	createdAt     : number;
	lastTickSentAt: number;
};

const PORT                       = getEnvInt('PORT', 3000);
const JOIN_REQUEST_TIMEOUT_MS    = getEnvInt('JOIN_REQUEST_TIMEOUT_MS', 30_000);
const ROOM_ID_LENGTH             = getEnvInt('ROOM_ID_LENGTH', 6);
const HEARTBEAT_INTERVAL_MS      = getEnvInt('HEARTBEAT_INTERVAL_MS', 1_000);
const ROOM_EMPTY_TTL_MS          = getEnvInt('ROOM_EMPTY_TTL_MS', 60_000);
const TICK_RATE                  = getEnvInt('TICK_RATE', 30);
const TICK_INTERVAL_MS           = Math.max(1, Math.round(1000 / TICK_RATE));
const WS_COMPRESSION             = getEnvBool('WS_COMPRESSION', false);
const EVENT_TIME_MAX_BACKDATE_MS = getEnvInt('EVENT_TIME_MAX_BACKDATE_MS', 200);
const EVENT_TIME_MAX_FUTURE_MS   = getEnvInt('EVENT_TIME_MAX_FUTURE_MS', 50);

const ROOM_ID_CHARS           = DEFAULT_ID_CHARS;
const ROOM_ID_MIN_LENGTH      = 3;
const ROOM_ID_MAX_LENGTH      = 32;
const DISPLAY_NAME_MAX_LENGTH = 32;

const ROOM_ID_VALIDATION_OPTS = {
	chars : ROOM_ID_CHARS,
	minLen: ROOM_ID_MIN_LENGTH,
	maxLen: ROOM_ID_MAX_LENGTH,
};

const CORS_HEADERS = {
	'Access-Control-Allow-Origin' : '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

const rooms = new Map<string, Room>();

const server = Bun.serve<WSData>({
	port: PORT,

	async fetch(req, server) {
		if (req.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}
		const url   = new URL(req.url);
		const route = getRouteName(url.pathname);

		if (req.method === 'GET' && route === 'health') {
			return jsonResponse({ ok: true, rooms: rooms.size, now: performance.now() }, CORS_HEADERS);
		}
		if (req.method === 'POST' && route === 'rooms') {
			return await handleCreateRoom(req);
		}
		if (route === 'ws') {
			return handleWebSocketUpgrade(req, server, url);
		}
		return jsonResponse({ ok: false, error: 'not_found' }, CORS_HEADERS, 404);
	},
	websocket: { perMessageDeflate: WS_COMPRESSION, open, message, close },
});

function open(ws: ServerWebSocket<WSData>) {
	const room = rooms.get(ws.data.roomId);
	if (!room) {
		sendError(ws, 'room_not_found');
		ws.close(1008, 'room_not_found');
		return;
	}
	if (ws.data.state === 'active') {
		activateConnection(room, ws);
		return;
	}
	createJoinRequest(room, ws);
}

function message(ws: ServerWebSocket<WSData>, raw: string | Buffer<ArrayBuffer>) {
	if (typeof raw !== 'string') {
		sendError(ws, 'unsupported_message', 'Only JSON text messages are supported in this implementation.');
		return;
	}
	let msg: any;
	try {
		msg = JSON.parse(raw);
	} catch {
		sendError(ws, 'invalid_json', 'Message must be valid JSON.');
		return;
	}
	if (!msg || typeof msg !== 'object') {
		sendError(ws, 'invalid_message', 'Message must be a JSON object.');
		return;
	}
	switch (msg.type) {
		case 'data'       : handleDataMessage(ws, msg); break;
		case 'approve'    : handleApproval(ws, msg); break;
		case 'syncRequest': handleSync(ws, msg); break;
		case 'syncReport' : handleSyncResult(ws, msg); break;
		default           : sendError(ws, 'unknown_type', `Unknown message type: ${String(msg.type)}`);
	}
}

function close(ws: ServerWebSocket<WSData>) {
	const room = rooms.get(ws.data.roomId);
	if (!room) return;

	if (ws.data.state === 'active') {
		room.active.delete(ws);

		if (room.roomMode === 'remote') {
			if (ws.data.role === 'receiver') {
				if (room.receiver === ws) {
					room.receiver = undefined;
				}
			} else {
				sendToReceiver(room, {
					type       : 'memberLeft',
					serverTime : performance.now(),
					roomId     : room.roomId,
					memberId   : ws.data.memberId as string,
					displayName: ws.data.displayName,
				} satisfies RelayEvent);
			}
			maybeScheduleEmptyRoomDeletion(room);
			return;
		}

		sendToRoom(room, {
			type       : 'memberLeft',
			serverTime : performance.now(),
			roomId     : room.roomId,
			memberId   : ws.data.memberId as string,
			displayName: ws.data.displayName,
		} satisfies RelayEvent);
		maybeScheduleEmptyRoomDeletion(room);
		return;
	}
	if (ws.data.requestId) {
		const req = room.pending.get(ws.data.requestId);
		if (req) {
			clearTimeout(req.timer);
			room.pending.delete(req.requestId);
			dispatchEvent(room, joinRequestMessage(room, req, 'canceled'));
		}
	}
}

// -----------------------------------------------------------------------------

console.log(`relay server listening on http://localhost:${server.port}`);
console.log(`TICK_RATE=${TICK_RATE}`);
console.log(`JOIN_REQUEST_TIMEOUT_MS=${JOIN_REQUEST_TIMEOUT_MS}`);
console.log(`HEARTBEAT_INTERVAL_MS=${HEARTBEAT_INTERVAL_MS}`);
console.log(`ROOM_EMPTY_TTL_MS=${ROOM_EMPTY_TTL_MS}`);
console.log(`ROOM_ID_LENGTH=${ROOM_ID_LENGTH}`);
console.log(`WS_COMPRESSION=${WS_COMPRESSION}`);

async function handleCreateRoom(req: Request): Promise<Response> {
	let body: CreateRoomOptions = {};
	try {
		body = await req.json() as CreateRoomOptions;
	} catch {
		body = {};
	}
	const rMode: RoomMode = body.roomMode   === 'remote'   ? 'remote'   : 'broadcast';
	const ratio           = normalizeApprovalRatio(body.approvalRatio);

	let roomId: string;
	if (typeof body.roomId === 'string' && body.roomId.trim() !== '') {
		const norm  = normalizeId(body.roomId);
		const error = validateId(norm, ROOM_ID_VALIDATION_OPTS);
		if (error) {
			return jsonResponse({ ok: false, error }, CORS_HEADERS, 400);
		}
		if (rooms.has(norm)) {
			return jsonResponse({ ok: false, error: 'room_id_already_exists' }, CORS_HEADERS, 409);
		}
		roomId = norm;
	} else {
		roomId = generateUniqueCode(ROOM_ID_LENGTH, ROOM_ID_CHARS, (id) => rooms.has(id));
	}
	const room = createRoom(roomId, rMode, ratio);
	const base = getEndpointBaseUrl(req.url);

	return jsonResponse({
		ok           : true,
		roomId       : room.roomId,
		roomMode     : room.roomMode,
		approvalRatio: room.approvalRatio,
		ownerToken   : room.ownerToken,
		joinUrl      : buildWebSocketUrl(base, 'ws', {
			roomId     : room.roomId,
			displayName: '...',
		}, true),
		ownerJoinUrl : buildWebSocketUrl(base, 'ws', {
			roomId     : room.roomId,
			displayName: '...',
			ownerToken : room.ownerToken,
		}, true),
	} satisfies CreateRoomResult, CORS_HEADERS);
}

function handleWebSocketUpgrade(req: Request, server: Server<WSData>, url: URL): Response | undefined {
	const roomId      = normalizeId(url.searchParams.get('roomId') ?? '');
	const displayName = normalizeDisplayName(url.searchParams.get('displayName') ?? '');
	const ownerToken  = url.searchParams.get('ownerToken') ?? '';

	const room = rooms.get(roomId);
	if (!room) return jsonResponse({ ok: false, error: 'room_not_found' }, CORS_HEADERS, 404);

	const roomIdError = validateId(roomId, ROOM_ID_VALIDATION_OPTS);
	if (roomIdError) return jsonResponse({ ok: false, error: roomIdError }, CORS_HEADERS, 400);

	const displayNameError = validateDisplayName(displayName, DISPLAY_NAME_MAX_LENGTH);
	if (displayNameError) return jsonResponse({ ok: false, error: displayNameError }, CORS_HEADERS, 400);

	const isOwner               = ownerToken !== '' && ownerToken === room.ownerToken;
	const role : MemberRole = room.roomMode === 'remote' ? (isOwner ? 'receiver' : 'controller') : 'member';
	const state: ConnState      = isOwner || room.approvalRatio === 0 ? 'active' : 'pending';

	const ok = server.upgrade(req, {
		data: {
			connectionId: createId('c'),
			roomId,
			displayName,
			state,
			role,
		},
	});
	if (!ok) return jsonResponse({ ok: false, error: 'websocket_upgrade_failed' }, CORS_HEADERS, 500);
	return undefined;
}

function createRoom(roomId: string, roomMode: RoomMode, approvalRatio: number): Room {
	const room: Room = {
		roomId,
		roomMode,
		approvalRatio,
		ownerToken    : createId('owner'),
		active          : new Set(),
		pending         : new Map(),
		queue           : [],
		tickSeq         : 0,
		tickTimer       : undefined as unknown as IntervalHandle,
		heartbeatTimer  : undefined as unknown as IntervalHandle,
		createdAt       : performance.now(),
		lastTickSentAt  : 0,
	};
	room.tickTimer      = setInterval(() => flushRoomQueue(room), TICK_INTERVAL_MS);
	room.heartbeatTimer = setInterval(() => sendHeartbeat(room), HEARTBEAT_INTERVAL_MS);

	rooms.set(roomId, room);
	return room;
}

function activateConnection(room: Room, ws: WS): void {
	clearEmptyRoomDeletion(room);

	ws.data.state     = 'active';
	ws.data.memberId  = createId('p');
	ws.data.requestId = undefined;

	if (room.roomMode === 'remote' && ws.data.role === 'receiver') {
		const prev = room.receiver;
		room.receiver = ws;

		if (prev && prev !== ws && room.active.has(prev)) {
			sendError(prev, 'receiver_replaced', 'Another receiver has connected.');
			room.active.delete(prev);
			prev.close(1000, 'receiver_replaced');
		}
	}

	room.active.add(ws);
	const members = room.roomMode === 'remote' && ws.data.role === 'controller' ? [] : getMembers(room);

	ws.send(JSON.stringify({
		type       : 'joined',
		serverTime : performance.now(),
		roomId     : room.roomId,
		roomMode   : room.roomMode,
		memberId   : ws.data.memberId,
		displayName: ws.data.displayName,
		role       : ws.data.role,
		members,
	} satisfies RelayEvent));

	if (room.roomMode === 'remote') {
		if (ws.data.role === 'controller') {
			sendToReceiver(room, {
				type       : 'memberJoined',
				serverTime : performance.now(),
				roomId     : room.roomId,
				memberId   : ws.data.memberId,
				displayName: ws.data.displayName,
				members,
			} satisfies RelayEvent);
		}

		if (ws.data.role === 'receiver') {
			for (const req of room.pending.values()) {
				ws.send(JSON.stringify(joinRequestMessage(room, req, 'created')));
			}
		}
		return;
	}

	sendToRoom(room, {
		type       : 'memberJoined',
		serverTime : performance.now(),
		roomId     : room.roomId,
		memberId   : ws.data.memberId,
		displayName: ws.data.displayName,
		members,
	} satisfies RelayEvent);

	for (const req of room.pending.values()) {
		ws.send(JSON.stringify(joinRequestMessage(room, req, 'created')));
	}
}

// -----------------------------------------------------------------------------

function createJoinRequest(room: Room, ws: WS): void {
	const approverCount = room.roomMode === 'remote' ? (room.receiver ? 1 : 0) : room.active.size;

	const requestId         = createId('req');
	const requiredApprovals = Math.max(1, Math.ceil(approverCount * room.approvalRatio));
	const expiresAt         = performance.now() + JOIN_REQUEST_TIMEOUT_MS;

	ws.data.requestId = requestId;

	const req: JoinRequest = {
		requestId,
		roomId     : room.roomId,
		ws,
		displayName: ws.data.displayName,
		requiredApprovals,
		approvals  : new Set(),
		createdAt  : performance.now(),
		expiresAt,
		timer      : setTimeout(() => rejectJoinRequest(room, requestId, 'timeout'), JOIN_REQUEST_TIMEOUT_MS),
	};
	room.pending.set(requestId, req);

	ws.send(JSON.stringify({
		type       : 'pending',
		serverTime : performance.now(),
		roomId     : room.roomId,
		requestId,
		displayName: ws.data.displayName,
		requiredApprovals,
		timeoutMs  : JOIN_REQUEST_TIMEOUT_MS,
	} satisfies RelayEvent));

	dispatchEvent(room, joinRequestMessage(room, req, 'created'));
}

function joinRequestMessage(room: Room, req: JoinRequest, status: JoinRequestStatus, reason?: string): RelayEvent {
	return {
		type             : 'joinRequest',
		status,
		serverTime       : performance.now(),
		roomId           : room.roomId,
		requestId        : req.requestId,
		displayName      : req.displayName,
		requiredApprovals: req.requiredApprovals,
		approvals        : req.approvals.size,
		expiresAt        : req.expiresAt,
		reason,
	} satisfies RelayEvent;
}

function handleApproval(ws: WS, msg: any): void {
	if (ws.data.state !== 'active' || !ws.data.memberId) {
		sendError(ws, 'not_active', 'Only active members can approve join requests.');
		return;
	}
	const room = rooms.get(ws.data.roomId);
	if (!room) {
		sendError(ws, 'room_not_found', 'Room not found.');
		return;
	}
	if (room.roomMode === 'remote' && ws.data.role !== 'receiver') {
		sendError(ws, 'not_receiver', 'Only the receiver can approve join requests in remote mode.');
		return;
	}

	const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
	const req       = room?.pending.get(requestId);

	if (!req) {
		sendError(ws, 'join_request_not_found', 'Join request not found.');
		return;
	}
	req.approvals.add(ws.data.memberId);

	dispatchEvent(room, joinRequestMessage(room, req, 'updated'));

	if (req.approvals.size >= req.requiredApprovals) {
		acceptJoinRequest(room, req.requestId);
	}
}

function acceptJoinRequest(room: Room, requestId: string): void {
	const req = room.pending.get(requestId);
	if (!req) return;

	clearTimeout(req.timer);
	room.pending.delete(requestId);
	activateConnection(room, req.ws);
}

function rejectJoinRequest(room: Room, requestId: string, reason: string): void {
	const req = room.pending.get(requestId);
	if (!req) return;

	clearTimeout(req.timer);
	room.pending.delete(requestId);

	req.ws.send(JSON.stringify({
		type      : 'joinRejected',
		serverTime: performance.now(),
		roomId    : room.roomId,
		requestId,
		reason,
	} satisfies RelayEvent));
	req.ws.close(1008, `join_rejected:${reason}`);

	dispatchEvent(room, joinRequestMessage(room, req, 'expired', reason));
}

// -----------------------------------------------------------------------------

function handleDataMessage(ws: WS, msg: any): void {
	if (ws.data.state !== 'active' || !ws.data.memberId) {
		sendError(ws, 'not_active', 'Only active members can send game data.');
		return;
	}
	const room = rooms.get(ws.data.roomId);
	if (!room) {
		sendError(ws, 'room_not_found', 'Room not found.');
		return;
	}
	if (room.roomMode === 'remote') {
		if (ws.data.role === 'receiver') {
			sendError(ws, 'receiver_cannot_send_data', 'Receiver cannot send data in remote mode.');
			return;
		}
		if (!room.receiver || !room.active.has(room.receiver)) {
			return;
		}
	}
	const receivedAt = performance.now();
	const clientTime = typeof msg.clientTime === 'number' && Number.isFinite(msg.clientTime)
		? msg.clientTime
		: undefined;
	const rawEventTime = clientTime !== undefined && ws.data.offsetToServerTime !== undefined
		? clientTime + ws.data.offsetToServerTime
		: receivedAt;
	const eventTime = Math.min(
		Math.max(rawEventTime, receivedAt - EVENT_TIME_MAX_BACKDATE_MS),
		receivedAt + EVENT_TIME_MAX_FUTURE_MS
	);
	room.queue.push({
		from       : ws.data.memberId,
		displayName: ws.data.displayName,
		clientTime,
		eventTime,
		receivedAt,
		payload    : msg.payload,
	} satisfies QueuedMessage);
}

function flushRoomQueue(room: Room): void {
	if (room.queue.length === 0) return;

	if (room.roomMode === 'remote') {
		if (!room.receiver || !room.active.has(room.receiver)) {
			room.queue.splice(0, room.queue.length);
			return;
		}
	} else {
		if (room.active.size === 0) return;
	}

	const messages = room.queue.splice(0, room.queue.length) as QueuedMessage[];
	messages.sort((a, b) => a.eventTime - b.eventTime || a.receivedAt - b.receivedAt);
	room.tickSeq += 1;
	room.lastTickSentAt = performance.now();

	dispatchEvent(room, {
		type      : 'tick',
		serverTime: room.lastTickSentAt,
		roomId    : room.roomId,
		tickSeq   : room.tickSeq,
		messages,
	} satisfies RelayEvent);
}

function sendHeartbeat(room: Room): void {
	if (room.roomMode === 'remote') {
		if (!room.receiver || !room.active.has(room.receiver)) return;
	} else {
		if (room.active.size === 0) return;
	}
	if (room.queue.length > 0) return;

	const t = performance.now();
	if (t - room.lastTickSentAt < HEARTBEAT_INTERVAL_MS) return;

	dispatchEvent(room, {
		type      : 'heartbeat',
		serverTime: t,
		roomId    : room.roomId,
		tickSeq   : room.tickSeq,
		members   : getMembers(room),
	} satisfies RelayEvent);
}

// -----------------------------------------------------------------------------

function handleSync(ws: WS, msg: any): void {
	const clientSendTime = Number(msg.clientSendTime);
	if (!Number.isFinite(clientSendTime)) {
		sendError(ws, 'invalid_sync', 'sync requires clientSendTime:number.');
		return;
	}
	const serverRecvTime = performance.now();
	const serverSendTime = performance.now();

	ws.send(JSON.stringify({ type: 'syncResponse', clientSendTime, serverRecvTime, serverSendTime } satisfies RelayEvent));
}

function handleSyncResult(ws: WS, msg: any): void {
	const clientSendTime = Number(msg.clientSendTime);
	const clientRecvTime = Number(msg.clientRecvTime);
	const serverRecvTime = Number(msg.serverRecvTime);
	const serverSendTime = Number(msg.serverSendTime);

	if (![clientSendTime, clientRecvTime, serverRecvTime, serverSendTime].every(Number.isFinite)) {
		sendError(ws, 'invalid_sync_result', 'syncResult has invalid timestamp fields.');
		return;
	}
	const rtt    = (clientRecvTime - clientSendTime) - (serverSendTime - serverRecvTime);
	const offset = ((serverRecvTime - clientSendTime) + (serverSendTime - clientRecvTime)) / 2;

	if (rtt < 0) {
		sendError(ws, 'invalid_rtt', 'Computed RTT is negative.');
		return;
	}
	if (ws.data.rtt === undefined || rtt <= ws.data.rtt) {
		ws.data.rtt                = rtt;
		ws.data.offsetToServerTime = offset;
	}
	ws.send(JSON.stringify({
		type              : 'syncStatus',
		serverTime        : performance.now(),
		rtt               : ws.data.rtt,
		offsetToServerTime: ws.data.offsetToServerTime as number,
	} satisfies RelayEvent));
}

// -----------------------------------------------------------------------------

function maybeScheduleEmptyRoomDeletion(room: Room): void {
	if (room.active.size > 0) return;
	if (room.emptyTimer) return;

	room.emptyTimer = setTimeout(() => {
		if (room.active.size === 0) {
			deleteRoom(room.roomId, 'empty_timeout');
		}
	}, ROOM_EMPTY_TTL_MS);
}

function clearEmptyRoomDeletion(room: Room): void {
	if (!room.emptyTimer) return;
	clearTimeout(room.emptyTimer);
	room.emptyTimer = undefined;
}

function deleteRoom(roomId: string, reason: string): void {
	const room = rooms.get(roomId);
	if (!room) return;

	clearInterval(room.tickTimer);
	clearInterval(room.heartbeatTimer);
	if (room.emptyTimer) clearTimeout(room.emptyTimer);

	for (const req of room.pending.values()) {
		clearTimeout(req.timer);
		req.ws.send(JSON.stringify({
			type      : 'roomClosed',
			serverTime: performance.now(),
			roomId,
			reason,
		} satisfies RelayEvent));
		req.ws.close(1001, 'room_closed');
	}
	sendToRoom(room, {
		type      : 'roomClosed',
		serverTime: performance.now(),
		roomId,
		reason,
	} satisfies RelayEvent);
	for (const ws of room.active) {
		ws.close(1001, 'room_closed');
	}
	rooms.delete(roomId);
}

// -----------------------------------------------------------------------------

function dispatchEvent(room: Room, ev: RelayEvent): void {
	if (room.roomMode === 'remote') {
		sendToReceiver(room, ev);
	} else {
		sendToRoom(room, ev);
	}
}

function sendToReceiver(room: Room, ev: RelayEvent): void {
	if (!room.receiver || !room.active.has(room.receiver)) return;
	send(room.receiver, ev);
}

function sendToRoom(room: Room, ev: RelayEvent): void {
	const str = JSON.stringify(ev);
	for (const ws of room.active) {
		ws.send(str);
	}
}

function sendError(ws: WS, code: string, message?: string): void {
	send(ws, { type: 'error', code, message });
}

function send(ws: WS, ev: RelayEvent): void {
	ws.send(JSON.stringify(ev));
}

// -----------------------------------------------------------------------------

function getMembers(room: Room) {
	return [...room.active].map((ws) => ({
		memberId   : ws.data.memberId as string,
		displayName: ws.data.displayName,
		role       : ws.data.role,
	} satisfies MemberInfo));
}
