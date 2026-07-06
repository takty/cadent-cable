/**
 * Cadent Cable - Types
 * Generic room-based WebSocket relay server for Bun.
 *
 * @author Takuto Yanagida
 * @version 2026-07-06
 */

export type RoomMode = 'broadcast' | 'remote';

export type AccessMode = 'free' | 'approval';

export type ClientRole = 'player' | 'receiver' | 'controller';

export type JoinRequestStatus = 'created' | 'updated' | 'expired' | 'canceled';

export type CreateRoomOptions = {
	roomId?       : string | null;
	roomMode?     : RoomMode;
	accessMode?   : AccessMode;
	approvalRatio?: number;
};

export type CreateRoomResult = {
	ok           : true;
	roomId       : string;
	roomMode     : RoomMode;
	accessMode   : AccessMode;
	approvalRatio: number;
	ownerToken   : string;
	joinUrl?     : string;
	ownerJoinUrl?: string;
};

// -----------------------------------------------------------------------------

export type RelayEvent<TPayload = unknown> = { type: 'open'; } |
	{ type: 'open'; } |
	{ type: 'close'; code: number; reason: string; } |
	{ type: 'error'; code?: string; message?: string; } |

	// From client

	{ type: 'data';    clientTime: number; payload: TPayload; } |
	{ type: 'approve'; requestId: string; } |

	{ type: 'syncRequest'; clientSendTime: number; } |
	{ type: 'syncReport';  clientSendTime: number; serverRecvTime: number; serverSendTime: number; clientRecvTime: number; } |

	// From server

	{ type: 'joined';       serverTime: number; roomId: string; playerId: string; displayName: string; roomMode: RoomMode; accessMode: AccessMode; role: ClientRole; players: PlayerInfo[]; } |
	{ type: 'pending';      serverTime: number; roomId: string; requestId: string; displayName: string; requiredApprovals: number; timeoutMs: number; } |
	{ type: 'joinRequest';  serverTime: number; roomId: string; requestId: string; displayName: string; requiredApprovals: number; status: JoinRequestStatus; approvals: number; expiresAt: number; reason?: string; } |
	{ type: 'joinRejected'; serverTime: number; roomId: string; requestId: string; reason: string; } |
	{ type: 'playerJoined'; serverTime: number; roomId: string; playerId: string; displayName: string; players: PlayerInfo[]; } |
	{ type: 'playerLeft';   serverTime: number; roomId: string; playerId: string; displayName: string; } |
	{ type: 'tick';         serverTime: number; roomId: string; tickSeq: number; messages: QueuedMessage<TPayload>[]; } |
	{ type: 'heartbeat';    serverTime: number; roomId: string; tickSeq: number; players: PlayerInfo[]; } |
	{ type: 'roomClosed';   serverTime: number; roomId: string; reason: string; } |

	{ type: 'syncResponse', clientSendTime: number; serverRecvTime: number; serverSendTime: number; } |
	{ type: 'syncStatus';   serverTime: number; rtt: number; offsetToServerTime: number; };

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
	role       : ClientRole;
};

export type ViewPlayerInfo = {
	playerId   : string;
	displayName: string;
	role?      : PlayerInfo['role'];
};
