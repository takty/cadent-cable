/**
 * Cadent Cable - Types
 * Generic room-based WebSocket relay server for Bun.
 *
 * @author Takuto Yanagida
 * @version 2026-07-03
 */

import type { WS, TimeoutHandle } from ".";

export type AccessMode = "free" | "approval";

export type CreateRoomOptions = {
	roomId?       : string | null;
	accessMode?   : AccessMode;
	approvalRatio?: number;
};

export type CreateRoomResult = {
	ok           : true;
	roomId       : string;
	accessMode   : AccessMode;
	approvalRatio: number;
	creatorToken : string;
	joinUrl?     : string;
};

// ---

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

// ---

export type RelayEvent<TPayload = unknown> = { type: "open"; } |
	{ type: "open"; } |
	{ type: "close"; code: number; reason: string; } |
	{ type: "error"; code?: string; message?: string; } |

	// From client

	{ type: "data";       clientTime: number; payload: TPayload; } |
	{ type: "approve";    requestId: string; } |
	{ type: "sync";       clientSendTime: number; } |
	{ type: "syncResult", clientSendTime: number; serverRecvTime: number; serverSendTime: number; clientRecvTime: number; } |

	// From server

	{ type: "syncReply",  clientSendTime: number; serverRecvTime: number; serverSendTime: number; } |

	{ type: "joined";              serverTime: number; roomId: string; playerId: string; displayName: string; players: PlayerInfo[]; } |
	{ type: "pending";             serverTime: number; roomId: string; requestId: string; displayName: string; requiredApprovals: number; timeoutMs: number; } |
	{ type: "joinRequest";         serverTime: number; roomId: string; requestId: string; displayName: string; requiredApprovals: number; approvals: number; expiresAt: number; } |
	{ type: "joinRequestUpdated";  serverTime: number; roomId: string; requestId: string; approvals: number; requiredApprovals: number; } |
	{ type: "joinRequestExpired";  serverTime: number; roomId: string; requestId: string; displayName: string; reason: string; } |
	{ type: "joinRequestCanceled"; serverTime: number; roomId: string; requestId: string; displayName: string; } |
	{ type: "joinRejected";        serverTime: number; roomId: string; requestId: string; reason: string; } |
	{ type: "playerJoined";        serverTime: number; roomId: string; playerId: string; displayName: string; players: PlayerInfo[]; } |
	{ type: "playerLeft";          serverTime: number; roomId: string; playerId: string; displayName: string; } |
	{ type: "tick";                serverTime: number; roomId: string; tickSeq: number; messages: QueuedMessage<TPayload>[]; } |
	{ type: "heartbeat";           serverTime: number; roomId: string; tickSeq: number; players: PlayerInfo[]; } |
	{ type: "syncUpdated";         serverTime: number; rtt: number; offsetToServerTime: number; } |

	{ type: string;[key: string]: unknown; };

export type QueuedMessage<TPayload = unknown> = {
	from       : string;
	displayName: string;
	clientTime?: number;
	eventTime  : number;
	receivedAt : number;
	payload    : TPayload;
};

export type PlayerInfo = {
	playerId   : string;
	displayName: string;
};
