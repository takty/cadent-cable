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
 * @version 2026-07-08
 */

import type { Server, ServerWebSocket } from 'bun';
import {
	ROUTE,
	ROOM_MODE,
	MEMBER_ROLE,
	MEMBER_STATE,
	EVENT_TYPE,
	JOIN_REQUEST_STATUS,
	type RoomMode,
	type MemberRole,
	type MemberState,
	type JoinRequestStatus,
	type CreateRoomOptions,
	type CreateRoomResult,
	type RelayEvent,
	type QueuedMessage,
	type MemberInfo,
} from './protocol';
import {
	DEFAULT_ID_CHARS,
	normalizeId,
	validateId,
	normalizeDisplayName,
	validateDisplayName,
	normalizeApprovalRatio,
	buildWebSocketUrl,
} from './utils';
import {
	getEnvInt,
	getEnvBool,
	getRouteName,
	getEndpointBaseUrl,
	jsonResponse,
	createId,
	generateUniqueCode,
} from './utils-server';

export type TimeoutHandle = ReturnType<typeof setTimeout>;
type IntervalHandle       = ReturnType<typeof setInterval>;

type ConnState = 'active' | 'pending';

type Member = {
	memberId   : string;
	resumeToken: string;
	displayName: string;
	role       : MemberRole;
	state      : MemberState;
	ws?        : WS;
	resumeTimer?: TimeoutHandle;
};

type WSData = {
	connectionId       : string;
	memberId?          : string;
	resumeToken?       : string;
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
	receiver?     : Member;
	members       : Map<string, Member>;
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
const MEMBER_RESUME_TTL_MS       = getEnvInt('MEMBER_RESUME_TTL_MS', 10_000);
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

		if (req.method === 'GET' && route === ROUTE.health) {
			return jsonResponse({ ok: true, rooms: rooms.size, now: performance.now() }, CORS_HEADERS);
		}
		if (req.method === 'POST' && route === ROUTE.rooms) {
			return await handleCreateRoom(req);
		}
		if (route === ROUTE.ws) {
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
		case EVENT_TYPE.data       : handleDataMessage(ws, msg); break;
		case EVENT_TYPE.approve    : handleApproval(ws, msg); break;
		case EVENT_TYPE.leave      : handleLeave(ws); break;
		case EVENT_TYPE.syncRequest: handleSync(ws, msg); break;
		case EVENT_TYPE.syncReport : handleSyncResult(ws, msg); break;
		default                    : sendError(ws, 'unknown_type', `Unknown message type: ${String(msg.type)}`);
	}
}

function close(ws: ServerWebSocket<WSData>) {
	const room = rooms.get(ws.data.roomId);
	if (!room) return;

	if (ws.data.state === 'active' && ws.data.memberId) {
		const member = room.members.get(ws.data.memberId);
		if (!member || member.ws !== ws) return;

		markMemberDisconnected(room, member);
		return;
	}

	if (ws.data.requestId) {
		cancelJoinRequest(room, ws);
	}
}

function markMemberDisconnected(room: Room, member: Member): void {
	member.ws    = undefined;
	member.state = MEMBER_STATE.disconnected;

	if (member.resumeTimer) clearTimeout(member.resumeTimer);
	member.resumeTimer = setTimeout(() => {
		member.resumeTimer = undefined;
		if (member.state === MEMBER_STATE.disconnected) {
			removeMember(room, member, 'resume_timeout');
		}
	}, MEMBER_RESUME_TTL_MS);

	dispatchEvent(room, memberUpdatedMessage(room, member));
}

function cancelJoinRequest(room: Room, ws: WS): void {
	if (!ws.data.requestId) return;

	const req = room.pending.get(ws.data.requestId);
	if (!req) return;

	clearTimeout(req.timer);
	room.pending.delete(req.requestId);
	dispatchEvent(room, joinRequestMessage(room, req, JOIN_REQUEST_STATUS.canceled));
}

// -----------------------------------------------------------------------------

console.log(`relay server listening on http://localhost:${server.port}`);
console.log(`TICK_RATE=${TICK_RATE}`);
console.log(`JOIN_REQUEST_TIMEOUT_MS=${JOIN_REQUEST_TIMEOUT_MS}`);
console.log(`HEARTBEAT_INTERVAL_MS=${HEARTBEAT_INTERVAL_MS}`);
console.log(`ROOM_EMPTY_TTL_MS=${ROOM_EMPTY_TTL_MS}`);
console.log(`MEMBER_RESUME_TTL_MS=${MEMBER_RESUME_TTL_MS}`);
console.log(`ROOM_ID_LENGTH=${ROOM_ID_LENGTH}`);
console.log(`WS_COMPRESSION=${WS_COMPRESSION}`);

async function handleCreateRoom(req: Request): Promise<Response> {
	let body: CreateRoomOptions = {};
	try {
		body = await req.json() as CreateRoomOptions;
	} catch {
		body = {};
	}
	const rMode: RoomMode = body.roomMode === ROOM_MODE.remote ? ROOM_MODE.remote : ROOM_MODE.broadcast;
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
		joinUrl      : buildWebSocketUrl(base, ROUTE.ws, {
			roomId     : room.roomId,
			displayName: '...',
		}, true),
		ownerJoinUrl : buildWebSocketUrl(base, ROUTE.ws, {
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
	const memberId    = url.searchParams.get('memberId') ?? '';
	const resumeToken = url.searchParams.get('resumeToken') ?? '';

	const room = rooms.get(roomId);
	if (!room) return jsonResponse({ ok: false, error: 'room_not_found' }, CORS_HEADERS, 404);

	const roomIdError = validateId(roomId, ROOM_ID_VALIDATION_OPTS);
	if (roomIdError) return jsonResponse({ ok: false, error: roomIdError }, CORS_HEADERS, 400);

	const displayNameError = validateDisplayName(displayName, DISPLAY_NAME_MAX_LENGTH);
	if (displayNameError) return jsonResponse({ ok: false, error: displayNameError }, CORS_HEADERS, 400);

	const isResume = memberId !== '' || resumeToken !== '';
	let role         : MemberRole;
	let state        : ConnState;
	let wsMemberId   : string | undefined;
	let wsResumeToken: string | undefined;

	if (isResume) {
		if (memberId === '' || resumeToken === '') {
			return jsonResponse({ ok: false, error: 'invalid_resume' }, CORS_HEADERS, 400);
		}
		const member = room.members.get(memberId);
		if (!member || member.resumeToken !== resumeToken) {
			return jsonResponse({ ok: false, error: 'invalid_resume' }, CORS_HEADERS, 400);
		}
		if (member.role === MEMBER_ROLE.receiver && ownerToken !== room.ownerToken) {
			return jsonResponse({ ok: false, error: 'invalid_resume' }, CORS_HEADERS, 400);
		}
		if (member.state !== MEMBER_STATE.disconnected) {
			return jsonResponse({ ok: false, error: 'invalid_resume' }, CORS_HEADERS, 400);
		}
		role          = member.role;
		state         = 'active';
		wsMemberId    = member.memberId;
		wsResumeToken = member.resumeToken;
	} else {
		const isOwner    = ownerToken !== '' && ownerToken === room.ownerToken;
		const isReceiver = room.roomMode === ROOM_MODE.remote && isOwner;

		role = room.roomMode === ROOM_MODE.remote
			? (isReceiver ? MEMBER_ROLE.receiver : MEMBER_ROLE.controller)
			: MEMBER_ROLE.member;
		state = isOwner || room.approvalRatio === 0
			? 'active'
			: 'pending';
	}
	const ok = server.upgrade(req, {
		data: {
			connectionId: createId('c'),
			memberId    : wsMemberId,
			resumeToken : wsResumeToken,
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
		members       : new Map(),
		pending       : new Map(),
		queue         : [],
		tickSeq       : 0,
		tickTimer     : undefined as unknown as IntervalHandle,
		heartbeatTimer: undefined as unknown as IntervalHandle,
		createdAt     : performance.now(),
		lastTickSentAt: 0,
	};
	room.tickTimer      = setInterval(() => flushRoomQueue(room), TICK_INTERVAL_MS);
	room.heartbeatTimer = setInterval(() => sendHeartbeat(room), HEARTBEAT_INTERVAL_MS);

	rooms.set(roomId, room);
	maybeScheduleEmptyRoomDeletion(room);
	return room;
}

function activateConnection(room: Room, ws: WS): void {
	clearEmptyRoomDeletion(room);

	const resumed = ws.data.memberId !== undefined && room.members.has(ws.data.memberId);
	const oldState = resumed ? room.members.get(ws.data.memberId as string)?.state : undefined;
	const oldDisplayName = resumed ? room.members.get(ws.data.memberId as string)?.displayName : undefined;

	const member = resumed
		? room.members.get(ws.data.memberId as string) as Member
		: createMember(ws);

	if (member.resumeTimer) {
		clearTimeout(member.resumeTimer);
		member.resumeTimer = undefined;
	}

	member.displayName = ws.data.displayName;
	member.state       = MEMBER_STATE.connected;
	member.ws          = ws;

	ws.data.memberId    = member.memberId;
	ws.data.resumeToken = member.resumeToken;
	ws.data.state       = 'active';
	ws.data.requestId   = undefined;

	if (room.roomMode === ROOM_MODE.remote && member.role === MEMBER_ROLE.receiver) {
		const prev = room.receiver;
		room.receiver = member;

		if (prev && prev !== member) {
			removeMember(room, prev, 'receiver_replaced');
			if (prev.ws) {
				sendError(prev.ws, 'receiver_replaced', 'Another receiver has connected.');
				prev.ws.close(1000, 'receiver_replaced');
			}
		}
	}

	const members = room.roomMode === ROOM_MODE.remote && member.role === MEMBER_ROLE.controller
		? []
		: getMembers(room);

	send(ws, {
		type       : EVENT_TYPE.joined,
		serverTime : performance.now(),
		roomId     : room.roomId,
		roomMode   : room.roomMode,
		memberId   : member.memberId,
		resumeToken: member.resumeToken,
		resumed,
		displayName: member.displayName,
		role       : member.role,
		members,
	} satisfies RelayEvent);

	if (resumed) {
		if (oldState !== member.state || oldDisplayName !== member.displayName) {
			dispatchEvent(room, memberUpdatedMessage(room, member));
		}
		return;
	}

	if (room.roomMode === ROOM_MODE.remote) {
		if (member.role === MEMBER_ROLE.controller) {
			sendToReceiver(room, {
				type       : EVENT_TYPE.memberJoined,
				serverTime : performance.now(),
				roomId     : room.roomId,
				memberId   : member.memberId,
				displayName: member.displayName,
				members    : getMembers(room),
			} satisfies RelayEvent);
		}
		if (member.role === MEMBER_ROLE.receiver) {
			for (const req of room.pending.values()) {
				send(ws, joinRequestMessage(room, req, JOIN_REQUEST_STATUS.created));
			}
		}
		return;
	}

	sendToRoom(room, {
		type       : EVENT_TYPE.memberJoined,
		serverTime : performance.now(),
		roomId     : room.roomId,
		memberId   : member.memberId,
		displayName: member.displayName,
		members,
	} satisfies RelayEvent);

	for (const req of room.pending.values()) {
		send(ws, joinRequestMessage(room, req, JOIN_REQUEST_STATUS.created));
	}
}

function createMember(ws: WS): Member {
	const member: Member = {
		memberId   : createId('m'),
		resumeToken: createId('resume'),
		displayName: ws.data.displayName,
		role       : ws.data.role,
		state      : MEMBER_STATE.connected,
		ws,
	};
	const room = rooms.get(ws.data.roomId);
	if (!room) throw new Error('Room not found.');
	room.members.set(member.memberId, member);
	return member;
}

function memberUpdatedMessage(room: Room, member: Member): RelayEvent {
	return {
		type       : EVENT_TYPE.memberUpdated,
		serverTime : performance.now(),
		roomId     : room.roomId,
		memberId   : member.memberId,
		displayName: member.displayName,
		state      : member.state,
		members    : getMembers(room),
	} satisfies RelayEvent;
}

// -----------------------------------------------------------------------------

function createJoinRequest(room: Room, ws: WS): void {
	const approverCount = room.roomMode === ROOM_MODE.remote
		? (isReceiverConnected(room) ? 1 : 0)
		: getConnectedMembers(room).length;

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

	send(ws, {
		type       : EVENT_TYPE.pending,
		serverTime : performance.now(),
		roomId     : room.roomId,
		requestId,
		displayName: ws.data.displayName,
		requiredApprovals,
		timeoutMs  : JOIN_REQUEST_TIMEOUT_MS,
	} satisfies RelayEvent);

	dispatchEvent(room, joinRequestMessage(room, req, JOIN_REQUEST_STATUS.created));
}

function getConnectedMembers(room: Room): Member[] {
	return [...room.members.values()].filter((m) => m.state === MEMBER_STATE.connected && m.ws);
}

function isReceiverConnected(room: Room): boolean {
	return !!room.receiver && room.receiver.state === MEMBER_STATE.connected && !!room.receiver.ws;
}

function joinRequestMessage(room: Room, req: JoinRequest, status: JoinRequestStatus, reason?: string): RelayEvent {
	return {
		type             : EVENT_TYPE.joinRequest,
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
	if (room.roomMode === ROOM_MODE.remote && ws.data.role !== MEMBER_ROLE.receiver) {
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

	dispatchEvent(room, joinRequestMessage(room, req, JOIN_REQUEST_STATUS.updated));

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

	send(req.ws, {
		type      : EVENT_TYPE.joinRejected,
		serverTime: performance.now(),
		roomId    : room.roomId,
		requestId,
		reason,
	} satisfies RelayEvent);
	req.ws.close(1008, `join_rejected:${reason}`);

	dispatchEvent(room, joinRequestMessage(room, req, JOIN_REQUEST_STATUS.expired, reason));
}

function handleLeave(ws: WS): void {
	const room = rooms.get(ws.data.roomId);
	if (!room) return;

	if (ws.data.state === 'pending') {
		cancelJoinRequest(room, ws);
		ws.close(1000, 'leave');
		return;
	}

	if (ws.data.state !== 'active' || !ws.data.memberId) {
		ws.close(1000, 'leave');
		return;
	}

	const member = room.members.get(ws.data.memberId);
	if (member && member.ws === ws) {
		removeMember(room, member, 'leave');
	}

	ws.close(1000, 'leave');
}

function removeMember(room: Room, member: Member, reason: string): void {
	if (member.resumeTimer) {
		clearTimeout(member.resumeTimer);
		member.resumeTimer = undefined;
	}

	const ws = member.ws;
	member.ws = undefined;

	if (room.receiver === member) {
		room.receiver = undefined;
	}
	room.members.delete(member.memberId);

	dispatchEvent(room, {
		type       : EVENT_TYPE.memberLeft,
		serverTime : performance.now(),
		roomId     : room.roomId,
		memberId   : member.memberId,
		displayName: member.displayName,
	} satisfies RelayEvent);

	if (ws && reason !== 'leave') {
		ws.close(1000, reason);
	}

	maybeScheduleEmptyRoomDeletion(room);
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
	if (room.roomMode === ROOM_MODE.remote) {
		if (ws.data.role === MEMBER_ROLE.receiver) {
			sendError(ws, 'receiver_cannot_send_data', 'Receiver cannot send data in remote mode.');
			return;
		}
		if (!isReceiverConnected(room)) {
			return;
		}
	}
	if (!Object.hasOwn(msg, 'payload')) {
		sendError(ws, 'invalid_data_message', 'data requires payload.');
		return;
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

	if (room.roomMode === ROOM_MODE.remote) {
		if (!isReceiverConnected(room)) {
			room.queue.splice(0, room.queue.length);
			return;
		}
	} else {
		if (getConnectedMembers(room).length === 0) return;
	}

	const messages = room.queue.splice(0, room.queue.length) as QueuedMessage[];
	messages.sort((a, b) => a.eventTime - b.eventTime || a.receivedAt - b.receivedAt);
	room.tickSeq += 1;
	room.lastTickSentAt = performance.now();

	dispatchEvent(room, {
		type      : EVENT_TYPE.tick,
		serverTime: room.lastTickSentAt,
		roomId    : room.roomId,
		tickSeq   : room.tickSeq,
		messages,
	} satisfies RelayEvent);
}

function sendHeartbeat(room: Room): void {
	if (room.roomMode === ROOM_MODE.remote) {
		if (!isReceiverConnected(room)) return;
	} else {
		if (getConnectedMembers(room).length === 0) return;
	}
	if (room.queue.length > 0) return;

	const t = performance.now();
	if (t - room.lastTickSentAt < HEARTBEAT_INTERVAL_MS) return;

	dispatchEvent(room, {
		type      : EVENT_TYPE.heartbeat,
		serverTime: t,
		roomId    : room.roomId,
		tickSeq   : room.tickSeq,
		members   : getMembers(room),
	} satisfies RelayEvent);
}

// -----------------------------------------------------------------------------

function handleSync(ws: WS, msg: any): void {
	const clientSendTime = typeof msg.clientSendTime === 'number' ? msg.clientSendTime : Number.NaN;
	if (!Number.isFinite(clientSendTime)) {
		sendError(ws, 'invalid_sync_request', 'syncRequest requires clientSendTime:number.');
		return;
	}
	const serverRecvTime = performance.now();
	const serverSendTime = performance.now();

	send(ws, { type: EVENT_TYPE.syncResponse, clientSendTime, serverRecvTime, serverSendTime } satisfies RelayEvent);
}

function handleSyncResult(ws: WS, msg: any): void {
	const clientSendTime = typeof msg.clientSendTime === 'number' ? msg.clientSendTime : Number.NaN;
	const clientRecvTime = typeof msg.clientRecvTime === 'number' ? msg.clientRecvTime : Number.NaN;
	const serverRecvTime = typeof msg.serverRecvTime === 'number' ? msg.serverRecvTime : Number.NaN;
	const serverSendTime = typeof msg.serverSendTime === 'number' ? msg.serverSendTime : Number.NaN;

	if (![clientSendTime, clientRecvTime, serverRecvTime, serverSendTime].every(Number.isFinite)) {
		sendError(ws, 'invalid_sync_report', 'syncReport has invalid timestamp fields.');
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
	send(ws, {
		type              : EVENT_TYPE.syncStatus,
		serverTime        : performance.now(),
		rtt               : ws.data.rtt,
		offsetToServerTime: ws.data.offsetToServerTime as number,
	} satisfies RelayEvent);
}

// -----------------------------------------------------------------------------

function maybeScheduleEmptyRoomDeletion(room: Room): void {
	if (room.members.size > 0) return;
	if (room.emptyTimer) return;

	room.emptyTimer = setTimeout(() => {
		room.emptyTimer = undefined;

		if (room.members.size === 0) {
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

	for (const member of room.members.values()) {
		if (member.resumeTimer) clearTimeout(member.resumeTimer);
	}

	for (const req of room.pending.values()) {
		clearTimeout(req.timer);
		send(req.ws, {
			type      : EVENT_TYPE.roomClosed,
			serverTime: performance.now(),
			roomId,
			reason,
		} satisfies RelayEvent);
		req.ws.close(1001, 'room_closed');
	}

	sendToRoom(room, {
		type      : EVENT_TYPE.roomClosed,
		serverTime: performance.now(),
		roomId,
		reason,
	} satisfies RelayEvent);

	for (const member of room.members.values()) {
		member.ws?.close(1001, 'room_closed');
	}

	rooms.delete(roomId);
}

// -----------------------------------------------------------------------------

function dispatchEvent(room: Room, ev: RelayEvent): void {
	if (room.roomMode === ROOM_MODE.remote) {
		sendToReceiver(room, ev);
	} else {
		sendToRoom(room, ev);
	}
}

function sendToReceiver(room: Room, ev: RelayEvent): void {
	if (!isReceiverConnected(room)) return;
	send(room.receiver!.ws as WS, ev);
}

function sendToRoom(room: Room, ev: RelayEvent): void {
	const str = JSON.stringify(ev);
	for (const member of room.members.values()) {
		if (member.state === MEMBER_STATE.connected && member.ws) {
			member.ws.send(str);
		}
	}
}

function sendError(ws: WS, code: string, message?: string): void {
	send(ws, { type: EVENT_TYPE.error, code, message });
}

function send(ws: WS, ev: RelayEvent): void {
	ws.send(JSON.stringify(ev));
}

// -----------------------------------------------------------------------------

function getMembers(room: Room) {
	return [...room.members.values()].map((member) => ({
		memberId   : member.memberId,
		displayName: member.displayName,
		role       : member.role,
		state      : member.state,
	} satisfies MemberInfo));
}
