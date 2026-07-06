import { createRoom, RelayConnection, type RelayConnectionOptions } from '../client';
import { type CreateRoomOptions, type PlayerInfo, type ViewPlayerInfo, type QueuedMessage } from '../types';
import { type RelayEvent } from '../types';

const SERVER_URL = 'http://localhost:3000/cadent-cable';
// const SERVER_URL = 'http://10.13.106.132:3000/cadent-cable';
const FLASH_MS   = 30;

type GamePayload = {
	kind: 'tap';
};

let conn: RelayConnection<GamePayload> | null = null;
let roomId     = '';
let ownerToken = '';
let myPlayerId = '';

const players     = new Map<string, ViewPlayerInfo>();
const flashTimers = new Map<string, number>();

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element not found: ${id}`);
	return el as T;
};

const roomIdInput        = $<HTMLInputElement>('room-id');
const displayNameInput   = $<HTMLInputElement>('display-name');
const accessModeInput    = $<HTMLSelectElement>('access-mode');
const approvalRatioInput = $<HTMLInputElement>('approval-ratio');
const createButton       = $<HTMLButtonElement>('create-room');
const joinButton         = $<HTMLButtonElement>('join-room');
const tapButton          = $<HTMLButtonElement>('tap-button');
const leaveButton        = $<HTMLButtonElement>('leave-room');
const statusEl           = $<HTMLDivElement>('status');
const playersEl          = $<HTMLDivElement>('players');
const requestsEl         = $<HTMLDivElement>('requests');

createButton.addEventListener('click', async () => {
	try {
		setStatus('Creating room...');
		const result = await createRoom(SERVER_URL, {
			roomId       : roomIdInput.value.trim() || null,
			accessMode   : accessModeInput.value === 'approval' ? 'approval' : 'free',
			approvalRatio: Number(approvalRatioInput.value) || 0.5,
		} satisfies CreateRoomOptions);
		roomId            = result.roomId;
		ownerToken        = result.ownerToken;
		roomIdInput.value = roomId;

		setStatus(`Room created: ${roomId}`);
		await connect({ ownerToken });
	} catch (e) {
		setStatus(errorMessage(e));
	}
});

joinButton.addEventListener('click', async () => {
	try {
		roomId     = roomIdInput.value.trim().toUpperCase();
		ownerToken = '';
		await connect({});
	} catch (e) {
		setStatus(errorMessage(e));
	}
});

tapButton.addEventListener('pointerdown', () => {
	conn?.sendData({ kind: 'tap' });
});

leaveButton.addEventListener('click', () => {
	conn?.disconnect();
	conn = null;
	myPlayerId = '';
	players.clear();
	setConnected(false);
	renderPlayers();
	setStatus('Disconnected.');
});

async function connect(options: { ownerToken?: string }) {
	const displayName = displayNameInput.value.trim();
	if (!roomId) throw new Error('Room ID is empty.');
	if (!displayName) throw new Error('Display name is empty.');

	conn?.disconnect();
	players.clear();
	renderPlayers();
	setConnected(false);
	setStatus('Connecting...');

	conn = new RelayConnection<GamePayload>({
		serverUrl     : SERVER_URL,
		roomId,
		displayName,
		ownerToken    : options.ownerToken,
		autoSync      : true,
		syncIntervalMs: 3000,
		onEvent       : handleRelayEvent,
	} satisfies RelayConnectionOptions<GamePayload>);
	await conn.connect();
}

function handleRelayEvent(ev: RelayEvent<GamePayload>) {
	switch (ev.type) {
		case 'open':
			setStatus('Connected. Waiting for join result...');
			break;
		case 'joined':
			myPlayerId = ev.playerId as string;
			setPlayers(ev.players as PlayerInfo[]);
			setConnected(true);
			setStatus(`Joined room ${ev.roomId} as ${ev.displayName}`);
			break;
		case 'pending':
			setStatus(`Waiting for approval... (${ev.requiredApprovals} OK required)`);
			break;
		case 'joinRequest':
			switch (ev.status) {
				case 'created':
					showJoinRequest(ev.requestId as string, ev.displayName as string, ev.approvals as number, ev.requiredApprovals as number);
					break;
				case 'updated':
					updateJoinRequest(ev.requestId as string, ev.approvals as number, ev.requiredApprovals as number);
					break;
				case 'expired':
				case 'canceled':
					removeJoinRequest(ev.requestId as string);
					break;
			}
			break;
		case 'joinRejected':
			setStatus(`Join rejected: ${ev.reason}`);
			setConnected(false);
			break;
		case 'playerJoined':
			setPlayers(ev.players as PlayerInfo[]);
			break;
		case 'playerLeft':
			players.delete(ev.playerId as string);
			renderPlayers();
			break;
		case 'heartbeat':
			setPlayers(ev.players as PlayerInfo[]);
			break;
		case 'tick':
			for (const msg of ev.messages as QueuedMessage<GamePayload>[]) {
				if (!players.has(msg.from)) {
					players.set(msg.from, { playerId: msg.from, displayName: msg.displayName });
				}
				if (msg.payload?.kind === 'tap') flashPlayer(msg.from);
			}
			break;
		case 'syncStatus':
			// The sample game does not display sync values, but the generic client keeps them.
			break;
		case 'error':
			setStatus(`Error: ${ev.code ?? 'unknown'} ${ev.message ?? ''}`.trim());
			break;
		case 'close':
			setConnected(false);
			setStatus(`Closed: ${ev.code} ${ev.reason}`.trim());
			break;
	}
}

function setPlayers(list: PlayerInfo[]) {
	players.clear();
	for (const p of list) players.set(p.playerId, p);
	renderPlayers();
}

function renderPlayers() {
	playersEl.textContent = '';
	for (const p of players.values()) {
		const row = document.createElement('div');
		row.className = 'player';
		row.dataset.playerId = p.playerId;

		const lamp = document.createElement('span');
		lamp.className = 'lamp';
		lamp.setAttribute('aria-hidden', 'true');

		const name = document.createElement('span');
		name.textContent = `${p.displayName}${p.playerId === myPlayerId ? ' (you)' : ''}`;

		row.append(lamp, name);
		playersEl.append(row);
	}
}

function flashPlayer(playerId: string) {
	const row = playersEl.querySelector<HTMLElement>(`.player[data-player-id='${CSS.escape(playerId)}']`);
	if (row) {
		row.classList.add('on');
	}
	const old = flashTimers.get(playerId);
	if (old !== undefined) window.clearTimeout(old);

	const timer = window.setTimeout(() => {
		const current = playersEl.querySelector<HTMLElement>(`.player[data-player-id='${CSS.escape(playerId)}']`);
		if (current) {
			current.classList.remove('on');
		}
		flashTimers.delete(playerId);
	}, FLASH_MS);
	flashTimers.set(playerId, timer);
}

function showJoinRequest(requestId: string, displayName: string, approvals: number, requiredApprovals: number) {
	if (document.getElementById(`req-${requestId}`)) return;

	const box = document.createElement('div');
	box.className = 'request';
	box.id = `req-${requestId}`;

	const text = document.createElement('span');
	text.textContent = `${displayName} wants to join. OK: ${approvals}/${requiredApprovals}`;

	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = 'OK';
	button.addEventListener('click', () => {
		conn?.approve(requestId);
		button.disabled = true;
	});

	box.append(text, button);
	requestsEl.append(box);
}

function updateJoinRequest(requestId: string, approvals: number, requiredApprovals: number) {
	const box = document.getElementById(`req-${requestId}`);
	if (!box) return;
	const text = box.querySelector('span');
	if (text) text.textContent = text.textContent?.replace(/OK: \d+\/\d+/, `OK: ${approvals}/${requiredApprovals}`) ?? '';
}

function removeJoinRequest(requestId: string) {
	document.getElementById(`req-${requestId}`)?.remove();
}

function setConnected(connected: boolean) {
	tapButton.disabled   = !connected;
	leaveButton.disabled = !connected;
}

function setStatus(text: string) {
	statusEl.textContent = text;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

setConnected(false);
setStatus('Not connected.');
