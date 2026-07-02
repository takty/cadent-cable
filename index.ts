/*
 * Generic room-based WebSocket relay server for Bun.
 *
 * - HTTP POST /rooms creates a room and returns { roomId, creatorToken }
 * - WebSocket /ws?roomId=...&displayName=...&creatorToken=... joins a room
 * - One WebSocket connection belongs to exactly one room
 * - Server relays JSON game payloads at 30Hz when data exists
 * - Server sends low-frequency heartbeats when no data exists
 * - Approval rooms require OK votes from active participants
 */

import type { Server, ServerWebSocket } from "bun";

type TimeoutHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

type AccessMode = "free" | "approval";
type ConnState = "active" | "pending";

type WSData = {
	connectionId: string;
	playerId?: string;
	roomId: string;
	displayName: string;
	state: ConnState;
	requestId?: string;
	offsetToServerTime?: number;
	rtt?: number;
};

type WS = ServerWebSocket<WSData>;

type Room = {
	roomId: string;
	accessMode: AccessMode;
	approvalRatio: number;
	creatorToken: string;
	creatorTokenUsed: boolean;
	active: Set<WS>;
	pending: Map<string, JoinRequest>;
	queue: QueuedMessage[];
	tickSeq: number;
	tickTimer: IntervalHandle;
	heartbeatTimer: IntervalHandle;
	emptyTimer?: TimeoutHandle;
	createdAt: number;
	lastTickSentAt: number;
};

type JoinRequest = {
	requestId: string;
	roomId: string;
	ws: WS;
	displayName: string;
	requiredApprovals: number;
	approvals: Set<string>;
	createdAt: number;
	expiresAt: number;
	timer: TimeoutHandle;
};

type QueuedMessage = {
	from: string;
	displayName: string;
	clientTime?: number;
	eventTime: number;
	receivedAt: number;
	payload: unknown;
};

const PORT = intEnv("PORT", 3000);
const JOIN_REQUEST_TIMEOUT_MS = intEnv("JOIN_REQUEST_TIMEOUT_MS", 30_000);
const ROOM_ID_LENGTH = intEnv("ROOM_ID_LENGTH", 6);
const HEARTBEAT_INTERVAL_MS = intEnv("HEARTBEAT_INTERVAL_MS", 1_000);
const ROOM_EMPTY_TTL_MS = intEnv("ROOM_EMPTY_TTL_MS", 60_000);
const TICK_RATE = intEnv("TICK_RATE", 30);
const TICK_INTERVAL_MS = Math.max(1, Math.round(1000 / TICK_RATE));
const WS_COMPRESSION = boolEnv("WS_COMPRESSION", false);

const ROOM_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_ID_MIN_LENGTH = 3;
const ROOM_ID_MAX_LENGTH = 32;
const DISPLAY_NAME_MAX_LENGTH = 32;

const rooms = new Map<string, Room>();

const server = Bun.serve<WSData>({
	port: PORT,

	async fetch(req, server) {
		const url = new URL(req.url);

		if (req.method === "GET" && url.pathname === "/health") {
			return jsonResponse({ ok: true, rooms: rooms.size, now: nowMs() });
		}

		if (req.method === "POST" && url.pathname === "/rooms") {
			return await handleCreateRoom(req);
		}

		if (url.pathname === "/ws") {
			return handleWebSocketUpgrade(req, server, url);
		}

		return jsonResponse({ ok: false, error: "not_found" }, 404);
	},

	websocket: {
		perMessageDeflate: WS_COMPRESSION,

		open(ws) {
			const room = rooms.get(ws.data.roomId);
			if (!room) {
				ws.send(JSON.stringify({ type: "error", code: "room_not_found" }));
				ws.close(1008, "room_not_found");
				return;
			}

			if (ws.data.state === "active") {
				activateConnection(room, ws);
				return;
			}

			createJoinRequest(room, ws);
		},

		message(ws, raw) {
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
				case "data":
					handleDataMessage(ws, msg);
					break;
				case "approve":
					handleApproval(ws, msg);
					break;
				case "sync":
					handleSync(ws, msg);
					break;
				case "syncResult":
					handleSyncResult(ws, msg);
					break;
				default:
					sendError(ws, "unknown_type", `Unknown message type: ${String(msg.type)}`);
			}
		},

		close(ws) {
			const room = rooms.get(ws.data.roomId);
			if (!room) return;

			if (ws.data.state === "active") {
				room.active.delete(ws);
				broadcastRoom(room, {
					type: "playerLeft",
					roomId: room.roomId,
					playerId: ws.data.playerId,
					displayName: ws.data.displayName,
					serverTime: nowMs(),
				});
				maybeScheduleEmptyRoomDeletion(room);
				return;
			}

			if (ws.data.requestId) {
				const req = room.pending.get(ws.data.requestId);
				if (req) {
					clearTimeout(req.timer);
					room.pending.delete(req.requestId);
					broadcastRoom(room, {
						type: "joinRequestCanceled",
						roomId: room.roomId,
						requestId: req.requestId,
						displayName: req.displayName,
						serverTime: nowMs(),
					});
				}
			}
		},
	},
});

console.log(`relay server listening on http://localhost:${server.port}`);
console.log(`TICK_RATE=${TICK_RATE}`);
console.log(`JOIN_REQUEST_TIMEOUT_MS=${JOIN_REQUEST_TIMEOUT_MS}`);
console.log(`HEARTBEAT_INTERVAL_MS=${HEARTBEAT_INTERVAL_MS}`);
console.log(`ROOM_EMPTY_TTL_MS=${ROOM_EMPTY_TTL_MS}`);
console.log(`ROOM_ID_LENGTH=${ROOM_ID_LENGTH}`);
console.log(`WS_COMPRESSION=${WS_COMPRESSION}`);

async function handleCreateRoom(req: Request): Promise<Response> {
	let body: any = {};
	try {
		body = await req.json();
	} catch {
		body = {};
	}

	const accessMode: AccessMode = body.accessMode === "approval" ? "approval" : "free";
	const approvalRatio = normalizeApprovalRatio(body.approvalRatio);

	let roomId: string;
	if (typeof body.roomId === "string" && body.roomId.trim() !== "") {
		const normalized = normalizeRoomId(body.roomId);
		const error = validateRoomId(normalized);
		if (error) return jsonResponse({ ok: false, error }, 400);
		if (rooms.has(normalized)) return jsonResponse({ ok: false, error: "room_id_already_exists" }, 409);
		roomId = normalized;
	} else {
		roomId = generateUniqueRoomId();
	}

	const room = createRoom(roomId, accessMode, approvalRatio);

	return jsonResponse({
		ok: true,
		roomId: room.roomId,
		accessMode: room.accessMode,
		approvalRatio: room.approvalRatio,
		creatorToken: room.creatorToken,
		joinUrl: `/ws?roomId=${encodeURIComponent(room.roomId)}&displayName=...&creatorToken=${encodeURIComponent(room.creatorToken)}`,
	});
}

function handleWebSocketUpgrade(req: Request, server: Server, url: URL): Response | undefined {
	const roomId = normalizeRoomId(url.searchParams.get("roomId") ?? "");
	const displayName = normalizeDisplayName(url.searchParams.get("displayName") ?? "");
	const creatorToken = url.searchParams.get("creatorToken") ?? "";

	const room = rooms.get(roomId);
	if (!room) return jsonResponse({ ok: false, error: "room_not_found" }, 404);

	const roomIdError = validateRoomId(roomId);
	if (roomIdError) return jsonResponse({ ok: false, error: roomIdError }, 400);

	const displayNameError = validateDisplayName(displayName);
	if (displayNameError) return jsonResponse({ ok: false, error: displayNameError }, 400);

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

	if (!ok) return jsonResponse({ ok: false, error: "websocket_upgrade_failed" }, 500);

	if (isCreator) room.creatorTokenUsed = true;
	return undefined;
}

function createRoom(roomId: string, accessMode: AccessMode, approvalRatio: number): Room {
	const room: Room = {
		roomId,
		accessMode,
		approvalRatio,
		creatorToken: createId("creator"),
		creatorTokenUsed: false,
		active: new Set(),
		pending: new Map(),
		queue: [],
		tickSeq: 0,
		tickTimer: undefined as unknown as Timer,
		heartbeatTimer: undefined as unknown as Timer,
		createdAt: nowMs(),
		lastTickSentAt: 0,
	};

	room.tickTimer = setInterval(() => flushRoomQueue(room), TICK_INTERVAL_MS);
	room.heartbeatTimer = setInterval(() => sendHeartbeat(room), HEARTBEAT_INTERVAL_MS);

	rooms.set(roomId, room);
	return room;
}

function activateConnection(room: Room, ws: WS): void {
	clearEmptyRoomDeletion(room);

	ws.data.state = "active";
	ws.data.playerId = createId("p");
	ws.data.requestId = undefined;

	room.active.add(ws);

	ws.send(JSON.stringify({
		type: "joined",
		roomId: room.roomId,
		playerId: ws.data.playerId,
		displayName: ws.data.displayName,
		accessMode: room.accessMode,
		serverTime: nowMs(),
		players: getPlayers(room),
	}));

	broadcastRoom(room, {
		type: "playerJoined",
		roomId: room.roomId,
		playerId: ws.data.playerId,
		displayName: ws.data.displayName,
		serverTime: nowMs(),
		players: getPlayers(room),
	});

	for (const req of room.pending.values()) {
		ws.send(JSON.stringify(joinRequestMessage(room, req)));
	}
}

function createJoinRequest(room: Room, ws: WS): void {
	const requestId = createId("req");
	const requiredApprovals = Math.max(1, Math.ceil(room.active.size * room.approvalRatio));
	const expiresAt = nowMs() + JOIN_REQUEST_TIMEOUT_MS;

	ws.data.requestId = requestId;

	const request: JoinRequest = {
		requestId,
		roomId: room.roomId,
		ws,
		displayName: ws.data.displayName,
		requiredApprovals,
		approvals: new Set(),
		createdAt: nowMs(),
		expiresAt,
		timer: setTimeout(() => rejectJoinRequest(room, requestId, "timeout"), JOIN_REQUEST_TIMEOUT_MS),
	};

	room.pending.set(requestId, request);

	ws.send(JSON.stringify({
		type: "pending",
		roomId: room.roomId,
		requestId,
		displayName: ws.data.displayName,
		requiredApprovals,
		timeoutMs: JOIN_REQUEST_TIMEOUT_MS,
		serverTime: nowMs(),
	}));

	broadcastRoom(room, joinRequestMessage(room, request));
}

function joinRequestMessage(room: Room, req: JoinRequest) {
	return {
		type: "joinRequest",
		roomId: room.roomId,
		requestId: req.requestId,
		displayName: req.displayName,
		requiredApprovals: req.requiredApprovals,
		approvals: req.approvals.size,
		expiresAt: req.expiresAt,
		serverTime: nowMs(),
	};
}

function handleApproval(ws: WS, msg: any): void {
	if (ws.data.state !== "active" || !ws.data.playerId) {
		sendError(ws, "not_active", "Only active players can approve join requests.");
		return;
	}

	const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
	const room = rooms.get(ws.data.roomId);
	const req = room?.pending.get(requestId);

	if (!room || !req) {
		sendError(ws, "join_request_not_found", "Join request not found.");
		return;
	}

	req.approvals.add(ws.data.playerId);

	broadcastRoom(room, {
		type: "joinRequestUpdated",
		roomId: room.roomId,
		requestId: req.requestId,
		approvals: req.approvals.size,
		requiredApprovals: req.requiredApprovals,
		serverTime: nowMs(),
	});

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
		type: "joinRejected",
		roomId: room.roomId,
		requestId,
		reason,
		serverTime: nowMs(),
	}));
	req.ws.close(1008, `join_rejected:${reason}`);

	broadcastRoom(room, {
		type: "joinRequestExpired",
		roomId: room.roomId,
		requestId,
		displayName: req.displayName,
		reason,
		serverTime: nowMs(),
	});
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

	const receivedAt = nowMs();
	const clientTime = typeof msg.clientTime === "number" && Number.isFinite(msg.clientTime)
		? msg.clientTime
		: undefined;
	const eventTime = clientTime !== undefined && ws.data.offsetToServerTime !== undefined
		? clientTime + ws.data.offsetToServerTime
		: receivedAt;

	room.queue.push({
		from: ws.data.playerId,
		displayName: ws.data.displayName,
		clientTime,
		eventTime,
		receivedAt,
		payload: msg.payload,
	});
}

function flushRoomQueue(room: Room): void {
	if (room.active.size === 0) return;
	if (room.queue.length === 0) return;

	const messages = room.queue.splice(0, room.queue.length);
	room.tickSeq += 1;
	room.lastTickSentAt = nowMs();

	broadcastRoom(room, {
		type: "tick",
		roomId: room.roomId,
		tickSeq: room.tickSeq,
		serverTime: room.lastTickSentAt,
		messages,
	});
}

function sendHeartbeat(room: Room): void {
	if (room.active.size === 0) return;
	if (room.queue.length > 0) return;

	const t = nowMs();
	if (t - room.lastTickSentAt < HEARTBEAT_INTERVAL_MS) return;

	broadcastRoom(room, {
		type: "heartbeat",
		roomId: room.roomId,
		tickSeq: room.tickSeq,
		serverTime: t,
		players: getPlayers(room),
	});
}

function handleSync(ws: WS, msg: any): void {
	const clientSendTime = Number(msg.clientSendTime);
	if (!Number.isFinite(clientSendTime)) {
		sendError(ws, "invalid_sync", "sync requires clientSendTime:number.");
		return;
	}

	const serverRecvTime = nowMs();
	const serverSendTime = nowMs();

	ws.send(JSON.stringify({
		type: "syncReply",
		clientSendTime,
		serverRecvTime,
		serverSendTime,
	}));
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
		type: "syncUpdated",
		rtt: ws.data.rtt,
		offsetToServerTime: ws.data.offsetToServerTime,
		serverTime: nowMs(),
	}));
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
		req.ws.send(JSON.stringify({ type: "roomClosed", roomId, reason, serverTime: nowMs() }));
		req.ws.close(1001, "room_closed");
	}

	for (const ws of room.active) {
		ws.send(JSON.stringify({ type: "roomClosed", roomId, reason, serverTime: nowMs() }));
		ws.close(1001, "room_closed");
	}

	rooms.delete(roomId);
}

function broadcastRoom(room: Room, message: unknown): void {
	const text = JSON.stringify(message);
	for (const ws of room.active) {
		ws.send(text);
	}
}

function sendError(ws: WS, code: string, message?: string): void {
	ws.send(JSON.stringify({ type: "error", code, message, serverTime: nowMs() }));
}

function getPlayers(room: Room) {
	return [...room.active].map((ws) => ({
		playerId: ws.data.playerId,
		displayName: ws.data.displayName,
	}));
}

function generateUniqueRoomId(): string {
	for (let i = 0; i < 1000; i++) {
		const id = randomCode(ROOM_ID_LENGTH);
		if (!rooms.has(id)) return id;
	}
	throw new Error("Could not generate unique roomId.");
}

function randomCode(length: number): string {
	let out = "";
	for (let i = 0; i < length; i++) {
		out += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
	}
	return out;
}

function normalizeRoomId(input: string): string {
	return input.trim().toUpperCase();
}

function validateRoomId(roomId: string): string | null {
	if (roomId.length < ROOM_ID_MIN_LENGTH) return "room_id_too_short";
	if (roomId.length > ROOM_ID_MAX_LENGTH) return "room_id_too_long";
	for (const ch of roomId) {
		if (!ROOM_ID_CHARS.includes(ch)) return "room_id_has_invalid_character";
	}
	return null;
}

function normalizeDisplayName(input: string): string {
	return input.trim();
}

function validateDisplayName(displayName: string): string | null {
	if (displayName.length < 1) return "display_name_empty";
	if (displayName.length > DISPLAY_NAME_MAX_LENGTH) return "display_name_too_long";
	return null;
}

function normalizeApprovalRatio(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
	if (value <= 0) return 0.5;
	if (value > 1) return 1;
	return value;
}

function createId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function nowMs(): number {
	return performance.now();
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

function intEnv(name: string, fallback: number): number {
	const value = Bun.env[name];
	if (value === undefined || value === "") return fallback;
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
	const value = Bun.env[name];
	if (value === undefined || value === "") return fallback;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
