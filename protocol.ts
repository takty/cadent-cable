/**
 * Cadent Cable - Protocol
 * Generic room-based WebSocket relay server for Bun.
 *
 * @author Takuto Yanagida
 * @version 2026-07-07
 */

export const ROUTE = {
	ws    : 'ws',
	rooms : 'rooms',
	health: 'health',
} as const;

export const ROOM_MODE = {
	broadcast: 'broadcast',
	remote   : 'remote',
} as const;

export const MEMBER_ROLE = {
	member    : 'member',
	receiver  : 'receiver',
	controller: 'controller',
} as const;

export const EVENT_TYPE = {
	open        : 'open',
	close       : 'close',
	error       : 'error',

	data        : 'data',
	approve     : 'approve',

	syncRequest : 'syncRequest',
	syncResponse: 'syncResponse',
	syncReport  : 'syncReport',
	syncStatus  : 'syncStatus',

	joined      : 'joined',
	pending     : 'pending',
	joinRequest : 'joinRequest',
	joinRejected: 'joinRejected',
	memberJoined: 'memberJoined',
	memberLeft  : 'memberLeft',
	tick        : 'tick',
	heartbeat   : 'heartbeat',
	roomClosed  : 'roomClosed',
} as const;

export const JOIN_REQUEST_STATUS = {
	created : 'created',
	updated : 'updated',
	expired : 'expired',
	canceled: 'canceled',
} as const;

export type RoomMode          = typeof ROOM_MODE[keyof typeof ROOM_MODE];
export type MemberRole        = typeof MEMBER_ROLE[keyof typeof MEMBER_ROLE];
export type EventType         = typeof EVENT_TYPE[keyof typeof EVENT_TYPE];
export type JoinRequestStatus = typeof JOIN_REQUEST_STATUS[keyof typeof JOIN_REQUEST_STATUS];

// -----------------------------------------------------------------------------

export type CreateRoomOptions = {
	roomId?       : string | null;
	roomMode?     : RoomMode;
	approvalRatio?: number;
};

export type CreateRoomResult = {
	ok           : true;
	roomId       : string;
	roomMode     : RoomMode;
	approvalRatio: number;
	ownerToken   : string;
	joinUrl?     : string;
	ownerJoinUrl?: string;
};

// -----------------------------------------------------------------------------

export type RelayEvent<TPayload = unknown> =
	{ type: typeof EVENT_TYPE.open; } |
	{ type: typeof EVENT_TYPE.close; code: number; reason: string; } |
	{ type: typeof EVENT_TYPE.error; code?: string; message?: string; } |

	// From client

	{ type: typeof EVENT_TYPE.data;    clientTime: number; payload: TPayload; } |
	{ type: typeof EVENT_TYPE.approve; requestId: string; } |

	{ type: typeof EVENT_TYPE.syncRequest; clientSendTime: number; } |
	{ type: typeof EVENT_TYPE.syncReport;  clientSendTime: number; serverRecvTime: number; serverSendTime: number; clientRecvTime: number; } |

	// From server

	{ type: typeof EVENT_TYPE.joined;       serverTime: number; roomId: string; memberId: string; displayName: string; roomMode: RoomMode; role: MemberRole; members: MemberInfo[]; } |
	{ type: typeof EVENT_TYPE.pending;      serverTime: number; roomId: string; requestId: string; displayName: string; requiredApprovals: number; timeoutMs: number; } |
	{ type: typeof EVENT_TYPE.joinRequest;  serverTime: number; roomId: string; requestId: string; displayName: string; requiredApprovals: number; status: JoinRequestStatus; approvals: number; expiresAt: number; reason?: string; } |
	{ type: typeof EVENT_TYPE.joinRejected; serverTime: number; roomId: string; requestId: string; reason: string; } |
	{ type: typeof EVENT_TYPE.memberJoined; serverTime: number; roomId: string; memberId: string; displayName: string; members: MemberInfo[]; } |
	{ type: typeof EVENT_TYPE.memberLeft;   serverTime: number; roomId: string; memberId: string; displayName: string; } |
	{ type: typeof EVENT_TYPE.tick;         serverTime: number; roomId: string; tickSeq: number; messages: QueuedMessage<TPayload>[]; } |
	{ type: typeof EVENT_TYPE.heartbeat;    serverTime: number; roomId: string; tickSeq: number; members: MemberInfo[]; } |
	{ type: typeof EVENT_TYPE.roomClosed;   serverTime: number; roomId: string; reason: string; } |

	{ type: typeof EVENT_TYPE.syncResponse; clientSendTime: number; serverRecvTime: number; serverSendTime: number; } |
	{ type: typeof EVENT_TYPE.syncStatus;   serverTime: number; rtt: number; offsetToServerTime: number; };

export type QueuedMessage<TPayload = unknown> = {
	from       : string;
	displayName: string;
	clientTime?: number;
	eventTime  : number;
	receivedAt : number;
	payload    : TPayload;
};

export type MemberInfo = {
	memberId   : string;
	displayName: string;
	role       : MemberRole;
};
