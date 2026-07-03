/**
 * Cadent Cable - Server
 * Generic room-based WebSocket relay server for Bun.
 *
 * - HTTP POST /rooms creates a room and returns { roomId, creatorToken }
 * - WebSocket /ws?roomId=...&displayName=...&creatorToken=... joins a room
 * - One WebSocket connection belongs to exactly one room
 * - Server relays JSON game payloads at 30Hz when data exists
 * - Server sends low-frequency heartbeats when no data exists
 * - Approval rooms require OK votes from active participants
 *
 * @author Takuto Yanagida
 * @version 2026-07-03
 */

import type { Server, ServerWebSocket } from "bun";
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
import { getEnvBool, getEnvInt, getRouteName } from "./utils-server";
import type { AccessMode, CreateRoomOptions, CreateRoomResult, JoinRequest, PlayerInfo, QueuedMessage, RelayEvent } from "./types";

export type TimeoutHandle  = ReturnType<typeof setTimeout>;
type IntervalHandle        = ReturnType<typeof setInterval>;

type ConnState = "active" | "pending";

type WSData = {
	connectionId       : string;
	playerId?          : string;
	roomId             : string;
	displayName        : string;
	state              : ConnState;
	requestId?         : string;
	offsetToServerTime?: number;
	rtt?               : number;
};

export type WS = ServerWebSocket<WSData>;

type Room = {
	roomId          : string;
	accessMode      : AccessMode;
	approvalRatio   : number;
	creatorToken    : string;
	creatorTokenUsed: boolean;
	active          : Set<WS>;
	pending         : Map<string, JoinRequest>;
	queue           : QueuedMessage[];
	tickSeq         : number;
	tickTimer       : IntervalHandle;
	heartbeatTimer  : IntervalHandle;
	emptyTimer?     : TimeoutHandle;
	createdAt       : number;
	lastTickSentAt  : number;
};

const PORT                    = getEnvInt("PORT", 3000);
const JOIN_REQUEST_TIMEOUT_MS = getEnvInt("JOIN_REQUEST_TIMEOUT_MS", 30_000);
const ROOM_ID_LENGTH          = getEnvInt("ROOM_ID_LENGTH", 6);
const HEARTBEAT_INTERVAL_MS   = getEnvInt("HEARTBEAT_INTERVAL_MS", 1_000);
const ROOM_EMPTY_TTL_MS       = getEnvInt("ROOM_EMPTY_TTL_MS", 60_000);
const TICK_RATE               = getEnvInt("TICK_RATE", 30);
const TICK_INTERVAL_MS        = Math.max(1, Math.round(1000 / TICK_RATE));
const WS_COMPRESSION          = getEnvBool("WS_COMPRESSION", false);

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
	"Access-Control-Allow-Origin" : "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const rooms = new Map<string, Room>();

const server = Bun.serve<WSData>({
	port: PORT,

	async fetch(req, server) {
		if (req.method === "OPTIONS") {
			return new Response(null, {
				status : 204,
				headers: CORS_HEADERS,
			});
		}
		const url   = new URL(req.url);
		const route = getRouteName(url.pathname);

		if (req.method === "GET" && route === "health") {
			return jsonResponse({ ok: true, rooms: rooms.size, now: performance.now() }, CORS_HEADERS);
		}
		if (req.method === "POST" && route === "rooms") {
			return await handleCreateRoom(req);
		}
		if (route === "ws") {
			return handleWebSocketUpgrade(req, server, url);
		}
		return jsonResponse({ ok: false, error: "not_found" }, CORS_HEADERS, 404);
	},
	websocket: { perMessageDeflate: WS_COMPRESSION, open, message, close },
});

function open(ws: ServerWebSocket<WSData>) {
	const room = rooms.get(ws.data.roomId);
	if (!room) {
		sendError(ws, "room_not_found");
		ws.close(1008, "room_not_found");
		return;
	}
	if (ws.data.state === "active") {
		activateConnection(room, ws);
		return;
	}
	createJoinRequest(room, ws);
}

function message(ws: ServerWebSocket<WSData>, raw: string | Buffer<ArrayBuffer>) {
	if (typeof raw !== "string") {
		sendError(ws, "unsupported_message", "Only JSON text messages are supported in this implementation.");
		return;
	}
	let msg: any;
	try {
		msg = JSON.parse(raw);
	} catch {
		sendError(ws, "invalid_json", "Message must be valid JSON.");
		return;
	}
	if (!msg || typeof msg !== "object") {
		sendError(ws, "invalid_message", "Message must be a JSON object.");
		return;
	}
	switch (msg.type) {
		case "data"      : handleDataMessage(ws, msg); break;
		case "approve"   : handleApproval(ws, msg); break;
		case "sync"      : handleSync(ws, msg); break;
		case "syncResult": handleSyncResult(ws, msg); break;
		default          : sendError(ws, "unknown_type", `Unknown message type: ${String(msg.type)}`);
	}
}

function close(ws: ServerWebSocket<WSData>) {
	const room = rooms.get(ws.data.roomId);
	if (!room) return;

	if (ws.data.state === "active") {
		room.active.delete(ws);
		broadcastRoom(room, {
			type       : "playerLeft",
			roomId     : room.roomId,
			playerId   : ws.data.playerId,
			displayName: ws.data.displayName,
			serverTime : performance.now(),
		} satisfies RelayEvent);
		maybeScheduleEmptyRoomDeletion(room);
		return;
	}
	if (ws.data.requestId) {
		const req = room.pending.get(ws.data.requestId);
		if (req) {
			clearTimeout(req.timer);
			room.pending.delete(req.requestId);
			broadcastRoom(room, {
				type       : "joinRequestCanceled",
				roomId     : room.roomId,
				requestId  : req.requestId,
				displayName: req.displayName,
				serverTime : performance.now(),
			} satisfies RelayEvent);
		}
	}
}

// ---

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
	const mode: AccessMode = body.accessMode === "approval" ? "approval" : "free";
	const ratio            = normalizeApprovalRatio(body.approvalRatio);

	let roomId: string;
	if (typeof body.roomId === "string" && body.roomId.trim() !== "") {
		const norm  = normalizeId(body.roomId);
		const error = validateId(norm, ROOM_ID_VALIDATION_OPTS);
		if (error) {
			return jsonResponse({ ok: false, error }, CORS_HEADERS, 400);
		}
		if (rooms.has(norm)) {
			return jsonResponse({ ok: false, error: "room_id_already_exists" }, CORS_HEADERS, 409);
		}
		roomId = norm;
	} else {
		roomId = generateUniqueCode(ROOM_ID_LENGTH, ROOM_ID_CHARS, (id) => rooms.has(id));
	}
	const room = createRoom(roomId, mode, ratio);
	return jsonResponse({
		ok           : true,
		roomId       : room.roomId,
		accessMode   : room.accessMode,
		approvalRatio: room.approvalRatio,
		creatorToken : room.creatorToken,
		joinUrl      : buildWebSocketUrl(req.url, "/ws", {
			roomId      : room.roomId,
			displayName : "...",
			creatorToken: room.creatorToken,
		}, true),
	} satisfies CreateRoomResult, CORS_HEADERS);
}

function handleWebSocketUpgrade(req: Request, server: Server<WSData>, url: URL): Response | undefined {
	const roomId       = normalizeId(url.searchParams.get("roomId") ?? "");
	const displayName  = normalizeDisplayName(url.searchParams.get("displayName") ?? "");
	const creatorToken = url.searchParams.get("creatorToken") ?? "";

	const room = rooms.get(roomId);
	if (!room) return jsonResponse({ ok: false, error: "room_not_found" }, CORS_HEADERS, 404);

	const roomIdError = validateId(roomId, ROOM_ID_VALIDATION_OPTS);
	if (roomIdError) return jsonResponse({ ok: false, error: roomIdError }, CORS_HEADERS, 400);

	const displayNameError = validateDisplayName(displayName, DISPLAY_NAME_MAX_LENGTH);
	if (displayNameError) return jsonResponse({ ok: false, error: displayNameError }, CORS_HEADERS, 400);

	const isCreator = !room.creatorTokenUsed && creatorToken !== "" && creatorToken === room.creatorToken;
	const state: ConnState = isCreator || room.accessMode === "free" ? "active" : "pending";

	const ok = server.upgrade(req, {
		data: {
			connectionId: createId("c"),
			roomId,
			displayName,
			state,
		},
	});
	if (!ok) return jsonResponse({ ok: false, error: "websocket_upgrade_failed" }, CORS_HEADERS, 500);
	if (isCreator) room.creatorTokenUsed = true;
	return undefined;
}

function createRoom(roomId: string, accessMode: AccessMode, approvalRatio: number): Room {
	const room: Room = {
		roomId,
		accessMode,
		approvalRatio,
		creatorToken    : createId("creator"),
		creatorTokenUsed: false,
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

	ws.data.state     = "active";
	ws.data.playerId  = createId("p");
	ws.data.requestId = undefined;

	room.active.add(ws);

	ws.send(JSON.stringify({
		type       : "joined",
		roomId     : room.roomId,
		playerId   : ws.data.playerId,
		displayName: ws.data.displayName,
		accessMode : room.accessMode,
		serverTime : performance.now(),
		players    : getPlayers(room),
	} satisfies RelayEvent));

	broadcastRoom(room, {
		type       : "playerJoined",
		roomId     : room.roomId,
		playerId   : ws.data.playerId,
		displayName: ws.data.displayName,
		serverTime : performance.now(),
		players    : getPlayers(room),
	} satisfies RelayEvent);

	for (const req of room.pending.values()) {
		ws.send(JSON.stringify(joinRequestMessage(room, req)));
	}
}

function createJoinRequest(room: Room, ws: WS): void {
	const requestId         = createId("req");
	const requiredApprovals = Math.max(1, Math.ceil(room.active.size * room.approvalRatio));
	const expiresAt         = performance.now() + JOIN_REQUEST_TIMEOUT_MS;

	ws.data.requestId = requestId;

	const request: JoinRequest = {
		requestId,
		roomId     : room.roomId,
		ws,
		displayName: ws.data.displayName,
		requiredApprovals,
		approvals  : new Set(),
		createdAt  : performance.now(),
		expiresAt,
		timer      : setTimeout(() => rejectJoinRequest(room, requestId, "timeout"), JOIN_REQUEST_TIMEOUT_MS),
	};
	room.pending.set(requestId, request);

	ws.send(JSON.stringify({
		type       : "pending",
		serverTime : performance.now(),
		roomId     : room.roomId,
		requestId,
		displayName: ws.data.displayName,
		requiredApprovals,
		timeoutMs  : JOIN_REQUEST_TIMEOUT_MS,
	} satisfies RelayEvent));
	broadcastRoom(room, joinRequestMessage(room, request));
}

function joinRequestMessage(room: Room, req: JoinRequest): RelayEvent {
	return {
		type             : "joinRequest",
		serverTime       : performance.now(),
		roomId           : room.roomId,
		requestId        : req.requestId,
		displayName      : req.displayName,
		requiredApprovals: req.requiredApprovals,
		approvals        : req.approvals.size,
		expiresAt        : req.expiresAt,
	} satisfies RelayEvent;
}

function handleApproval(ws: WS, msg: any): void {
	if (ws.data.state !== "active" || !ws.data.playerId) {
		sendError(ws, "not_active", "Only active players can approve join requests.");
		return;
	}
	const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
	const room      = rooms.get(ws.data.roomId);
	const req       = room?.pending.get(requestId);

	if (!room || !req) {
		sendError(ws, "join_request_not_found", "Join request not found.");
		return;
	}
	req.approvals.add(ws.data.playerId);

	broadcastRoom(room, {
		type             : "joinRequestUpdated",
		serverTime       : performance.now(),
		roomId           : room.roomId,
		requestId        : req.requestId,
		approvals        : req.approvals.size,
		requiredApprovals: req.requiredApprovals,
	} satisfies RelayEvent);

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
		type      : "joinRejected",
		serverTime: performance.now(),
		roomId    : room.roomId,
		requestId,
		reason,
	} satisfies RelayEvent));
	req.ws.close(1008, `join_rejected:${reason}`);

	broadcastRoom(room, {
		type       : "joinRequestExpired",
		serverTime : performance.now(),
		roomId     : room.roomId,
		requestId,
		displayName: req.displayName,
		reason,
	} satisfies RelayEvent);
}

function handleDataMessage(ws: WS, msg: any): void {
	if (ws.data.state !== "active" || !ws.data.playerId) {
		sendError(ws, "not_active", "Only active players can send game data.");
		return;
	}
	const room = rooms.get(ws.data.roomId);
	if (!room) {
		sendError(ws, "room_not_found", "Room not found.");
		return;
	}
	const receivedAt = performance.now();
	const clientTime = typeof msg.clientTime === "number" && Number.isFinite(msg.clientTime)
		? msg.clientTime
		: undefined;
	const eventTime = clientTime !== undefined && ws.data.offsetToServerTime !== undefined
		? clientTime + ws.data.offsetToServerTime
		: receivedAt;

	room.queue.push({
		from       : ws.data.playerId,
		displayName: ws.data.displayName,
		clientTime,
		eventTime,
		receivedAt,
		payload    : msg.payload,
	} satisfies QueuedMessage);
}

function flushRoomQueue(room: Room): void {
	if (room.active.size === 0) return;
	if (room.queue.length === 0) return;

	const messages = room.queue.splice(0, room.queue.length) as QueuedMessage[];
	room.tickSeq += 1;
	room.lastTickSentAt = performance.now();

	broadcastRoom(room, {
		type      : "tick",
		serverTime: room.lastTickSentAt,
		roomId    : room.roomId,
		tickSeq   : room.tickSeq,
		messages,
	} satisfies RelayEvent);
}

function sendHeartbeat(room: Room): void {
	if (room.active.size === 0) return;
	if (room.queue.length > 0) return;

	const t = performance.now();
	if (t - room.lastTickSentAt < HEARTBEAT_INTERVAL_MS) return;

	broadcastRoom(room, {
		type      : "heartbeat",
		serverTime: t,
		roomId    : room.roomId,
		tickSeq   : room.tickSeq,
		players   : getPlayers(room),
	} satisfies RelayEvent);
}

function handleSync(ws: WS, msg: any): void {
	const clientSendTime = Number(msg.clientSendTime);
	if (!Number.isFinite(clientSendTime)) {
		sendError(ws, "invalid_sync", "sync requires clientSendTime:number.");
		return;
	}
	const serverRecvTime = performance.now();
	const serverSendTime = performance.now();

	ws.send(JSON.stringify({
		type: "syncReply",
		clientSendTime,
		serverRecvTime,
		serverSendTime,
	} satisfies RelayEvent));
}

function handleSyncResult(ws: WS, msg: any): void {
	const clientSendTime = Number(msg.clientSendTime);
	const clientRecvTime = Number(msg.clientRecvTime);
	const serverRecvTime = Number(msg.serverRecvTime);
	const serverSendTime = Number(msg.serverSendTime);

	if (![clientSendTime, clientRecvTime, serverRecvTime, serverSendTime].every(Number.isFinite)) {
		sendError(ws, "invalid_sync_result", "syncResult has invalid timestamp fields.");
		return;
	}
	const rtt = (clientRecvTime - clientSendTime) - (serverSendTime - serverRecvTime);
	const offset = ((serverRecvTime - clientSendTime) + (serverSendTime - clientRecvTime)) / 2;

	if (rtt < 0) {
		sendError(ws, "invalid_rtt", "Computed RTT is negative.");
		return;
	}
	if (ws.data.rtt === undefined || rtt <= ws.data.rtt) {
		ws.data.rtt = rtt;
		ws.data.offsetToServerTime = offset;
	}
	ws.send(JSON.stringify({
		type              : "syncUpdated",
		serverTime        : performance.now(),
		rtt               : ws.data.rtt,
		offsetToServerTime: ws.data.offsetToServerTime,
	} satisfies RelayEvent));
}

function maybeScheduleEmptyRoomDeletion(room: Room): void {
	if (room.active.size > 0) return;
	if (room.emptyTimer) return;

	room.emptyTimer = setTimeout(() => {
		if (room.active.size === 0) {
			deleteRoom(room.roomId, "empty_timeout");
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
			type      : "roomClosed",
			serverTime: performance.now(),
			roomId,
			reason,
		} satisfies RelayEvent));
		req.ws.close(1001, "room_closed");
	}
	for (const ws of room.active) {
		ws.send(JSON.stringify({
			type      : "roomClosed",
			serverTime: performance.now(),
			roomId,
			reason,
		} satisfies RelayEvent));
		ws.close(1001, "room_closed");
	}
	rooms.delete(roomId);
}

function broadcastRoom(room: Room, message: RelayEvent): void {
	const text = JSON.stringify(message);
	for (const ws of room.active) {
		ws.send(text);
	}
}

function sendError(ws: WS, code: string, message?: string): void {
	ws.send(JSON.stringify({
		type: "error",
		code,
		message,
	} satisfies RelayEvent));
}

function getPlayers(room: Room) {
	return [...room.active].map((ws) => ({
		playerId   : ws.data.playerId as string,
		displayName: ws.data.displayName,
	} satisfies PlayerInfo));
}
