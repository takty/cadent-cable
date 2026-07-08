import { createRoom, RelayConnection, type RelayConnectionOptions } from '../client';
import { EVENT_TYPE, JOIN_REQUEST_STATUS, MEMBER_ROLE, type CreateRoomOptions, type MemberInfo, type QueuedMessage } from '../protocol';
import { type RelayEvent } from '../protocol';

// const SERVER_URL = 'http://localhost:3000/cc';
const SERVER_URL = 'http://10.13.106.1/api/cc';
const FLASH_MS   = 30;

type GamePayload = {
	kind: 'tap';
};

let conn: RelayConnection<GamePayload> | null = null;
let roomId     = '';
let ownerToken = '';
let myMemberId = '';

const members     = new Map<string, MemberInfo>();
const flashTimers = new Map<string, number>();

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element not found: ${id}`);
	return el as T;
};

const roomIdInput        = $<HTMLInputElement>('room-id');
const displayNameInput   = $<HTMLInputElement>('display-name');
const approvalRatioInput = $<HTMLInputElement>('approval-ratio');
const createButton       = $<HTMLButtonElement>('create-room');
const joinButton         = $<HTMLButtonElement>('join-room');
const tapButton          = $<HTMLButtonElement>('tap-button');
const leaveButton        = $<HTMLButtonElement>('leave-room');
const statusEl           = $<HTMLDivElement>('status');
const membersEl          = $<HTMLDivElement>('members');
const requestsEl         = $<HTMLDivElement>('requests');

createButton.addEventListener('click', async () => {
	try {
		setStatus('Creating room...');
		const result = await createRoom(SERVER_URL, {
			roomId       : roomIdInput.value.trim() || null,
			approvalRatio: Number(approvalRatioInput.value) || 0,
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
	conn?.leave();
	conn = null;
	myMemberId = '';
	members.clear();
	setConnected(false);
	renderMembers();
	setStatus('Disconnected.');
});

async function connect(options: { ownerToken?: string }) {
	const displayName = displayNameInput.value.trim();
	if (!roomId) throw new Error('Room ID is empty.');
	if (!displayName) throw new Error('Display name is empty.');

	conn?.leave();
	members.clear();
	renderMembers();
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
	await conn.join();
}

function handleRelayEvent(ev: RelayEvent<GamePayload>) {
	switch (ev.type) {
		case EVENT_TYPE.open:
			setStatus('Connected. Waiting for join result...');
			break;
		case EVENT_TYPE.joined:
			myMemberId = ev.memberId as string;
			setMembers(ev.members as MemberInfo[]);
			setConnected(true);
			setStatus(`Joined room ${ev.roomId} as ${ev.displayName}`);
			break;
		case EVENT_TYPE.pending:
			setStatus(`Waiting for approval... (${ev.requiredApprovals} OK required)`);
			break;
		case EVENT_TYPE.joinRequest:
			switch (ev.status) {
				case JOIN_REQUEST_STATUS.created:
					showJoinRequest(ev.requestId as string, ev.displayName as string, ev.approvals as number, ev.requiredApprovals as number);
					break;
				case JOIN_REQUEST_STATUS.updated:
					updateJoinRequest(ev.requestId as string, ev.approvals as number, ev.requiredApprovals as number);
					break;
				case JOIN_REQUEST_STATUS.expired:
				case JOIN_REQUEST_STATUS.canceled:
					removeJoinRequest(ev.requestId as string);
					break;
			}
			break;
		case EVENT_TYPE.joinRejected:
			setStatus(`Join rejected: ${ev.reason}`);
			setConnected(false);
			break;
		case EVENT_TYPE.memberJoined:
			setMembers(ev.members as MemberInfo[]);
			break;
		case EVENT_TYPE.memberLeft:
			members.delete(ev.memberId as string);
			renderMembers();
			break;
		case EVENT_TYPE.heartbeat:
			setMembers(ev.members as MemberInfo[]);
			break;
		case EVENT_TYPE.tick:
			for (const msg of ev.messages as QueuedMessage<GamePayload>[]) {
				if (!members.has(msg.from)) {
					members.set(msg.from, {
						memberId   : msg.from,
						displayName: msg.displayName,
						role       : MEMBER_ROLE.member
					});
				}
				if (msg.payload?.kind === 'tap') flashMember(msg.from);
			}
			break;
		case EVENT_TYPE.syncStatus:
			// The sample game does not display sync values, but the generic client keeps them.
			break;
		case EVENT_TYPE.error:
			setStatus(`Error: ${ev.code ?? 'unknown'} ${ev.message ?? ''}`.trim());
			break;
		case EVENT_TYPE.close:
			setConnected(false);
			setStatus(`Closed: ${ev.code} ${ev.reason}`.trim());
			break;
	}
}

function setMembers(list: MemberInfo[]) {
	members.clear();
	for (const p of list) members.set(p.memberId, p);
	renderMembers();
}

function renderMembers() {
	membersEl.textContent = '';
	for (const p of members.values()) {
		const row = document.createElement('div');
		row.className = 'member';
		row.dataset.memberId = p.memberId;

		const lamp = document.createElement('span');
		lamp.className = 'lamp';
		lamp.setAttribute('aria-hidden', 'true');

		const name = document.createElement('span');
		name.textContent = `${p.displayName}${p.memberId === myMemberId ? ' (you)' : ''}`;

		row.append(lamp, name);
		membersEl.append(row);
	}
}

function flashMember(memberId: string) {
	const row = membersEl.querySelector<HTMLElement>(`.member[data-member-id='${CSS.escape(memberId)}']`);
	if (row) {
		row.classList.add('on');
	}
	const old = flashTimers.get(memberId);
	if (old !== undefined) window.clearTimeout(old);

	const timer = window.setTimeout(() => {
		const current = membersEl.querySelector<HTMLElement>(`.member[data-member-id='${CSS.escape(memberId)}']`);
		if (current) {
			current.classList.remove('on');
		}
		flashTimers.delete(memberId);
	}, FLASH_MS);
	flashTimers.set(memberId, timer);
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
