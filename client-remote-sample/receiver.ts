import { createRoom, RelayConnection, type RelayConnectionOptions } from '../client';
import { EVENT_TYPE, MEMBER_ROLE, MEMBER_STATE, ROOM_MODE, type CreateRoomOptions, type MemberInfo, type QueuedMessage, type RelayEvent } from '../protocol';

declare const QRCode: new (
	el: HTMLElement,
	options: { text: string; width: number; height: number; }
) => unknown;

// const SERVER_URL     = 'http://localhost:3000/cc';
const SERVER_URL     = 'https://lab.takty.net/api/cc';
const MOVE_SPEED     = 160; // px/sec
const CHARACTER_SIZE = 28;

type ButtonName = 'up' | 'down' | 'left' | 'right' | 'a' | 'b';

type RemotePayload = {
	kind  : 'buttonDown' | 'buttonUp';
	button: ButtonName;
};

type Character = {
	memberId  : string;
	no        : number;
	x         : number;
	y         : number;
	colorIndex: number;
	buttons   : Set<ButtonName>;
	el        : HTMLDivElement;
};

const COLORS = [
	'#e74c3c',
	'#3498db',
	'#2ecc71',
	'#f1c40f',
	'#9b59b6',
	'#e67e22',
];

let conn: RelayConnection<RemotePayload> | null = null;

let roomId      = '';
let ownerToken  = '';
let nextCharNo  = 1;
let lastFrameAt = 0;
let rafId       = 0;

const characters = new Map<string, Character>();

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element not found: ${id}`);
	return el as T;
};

const createButton       = $<HTMLButtonElement>('create-room');
const leaveButton        = $<HTMLButtonElement>('leave-room');
const statusEl           = $<HTMLDivElement>('status');
const roomIdEl           = $<HTMLElement>('room-id');
const controllerCountEl  = $<HTMLElement>('controller-count');
const qrEl               = $<HTMLDivElement>('qr');
const controllerUrlEl    = $<HTMLAnchorElement>('controller-url');
const playAreaEl         = $<HTMLDivElement>('play-area');

createButton.addEventListener('click', async () => {
	try {
		await startReceiver();
	} catch (e) {
		setStatus(errorMessage(e));
	}
});

leaveButton.addEventListener('click', () => {
	stopReceiver();
	setStatus('Disconnected.');
});

async function startReceiver() {
	stopReceiver();

	setStatus('Creating remote room...');

	const result = await createRoom(SERVER_URL, {
		roomMode     : ROOM_MODE.remote,
		approvalRatio: 0,
	} satisfies CreateRoomOptions);

	roomId     = result.roomId;
	ownerToken = result.ownerToken;

	roomIdEl.textContent = roomId;
	renderControllerUrl();

	setStatus('Connecting receiver...');

	conn = new RelayConnection<RemotePayload>({
		serverUrl  : SERVER_URL,
		roomId,
		displayName: 'receiver',
		ownerToken,
		autoSync   : false,
		onEvent    : handleRelayEvent,
	} satisfies RelayConnectionOptions<RemotePayload>);

	await conn.join();

	createButton.disabled = true;
	leaveButton.disabled  = false;

	startAnimation();
}

function stopReceiver() {
	conn?.leave();
	conn = null;

	roomId     = '';
	ownerToken = '';

	createButton.disabled = false;
	leaveButton.disabled  = true;

	roomIdEl.textContent        = '-';
	qrEl.textContent            = '';
	controllerUrlEl.textContent = '';
	controllerUrlEl.removeAttribute('href');

	for (const c of characters.values()) {
		c.el.remove();
	}
	characters.clear();
	updateControllerCount();

	if (rafId !== 0) {
		cancelAnimationFrame(rafId);
		rafId = 0;
	}
	lastFrameAt = 0;
}

function handleRelayEvent(ev: RelayEvent<RemotePayload>) {
	switch (ev.type) {
		case EVENT_TYPE.open:
			setStatus('Connected. Waiting for join result...');
			break;
		case EVENT_TYPE.joined:
			setStatus(`Receiver joined room ${ev.roomId}`);
			setCharactersFromMembers(ev.members as MemberInfo[]);
			break;
		case EVENT_TYPE.memberJoined:
		case EVENT_TYPE.memberUpdated:
			setCharactersFromMembers(ev.members as MemberInfo[]);
			break;
		case EVENT_TYPE.memberLeft:
			deleteCharacter(ev.memberId as string);
			updateControllerCount();
			break;
		case EVENT_TYPE.heartbeat:
			setCharactersFromMembers(ev.members as MemberInfo[]);
			break;
		case EVENT_TYPE.tick:
			handleTick(ev.messages as QueuedMessage<RemotePayload>[]);
			break;
		case EVENT_TYPE.roomClosed:
			stopReceiver();
			setStatus(`Room closed: ${ev.reason}`);
			break;
		case EVENT_TYPE.error:
			setStatus(`Error: ${ev.code ?? 'unknown'} ${ev.message ?? ''}`.trim());
			break;
		case EVENT_TYPE.close:
			stopReceiver();
			createButton.disabled = false;
			leaveButton.disabled  = true;
			setStatus(`Closed: ${ev.code} ${ev.reason}`.trim());
			break;
		case EVENT_TYPE.syncStatus:
			break;
	}
}

function handleTick(messages: QueuedMessage<RemotePayload>[]) {
	for (const msg of messages) {
		const payload = msg?.payload;
		if (!isRemotePayload(payload)) continue;

		const c = characters.get(msg.from) ?? createCharacter(msg.from);

		if (payload.kind === 'buttonDown') {
			if (payload.button === 'a') {
				c.colorIndex = (c.colorIndex + 1) % COLORS.length;
			}
			c.buttons.add(payload.button);
		} else {
			c.buttons.delete(payload.button);
		}
		renderCharacter(c);
	}
}

function isRemotePayload(v: unknown): v is RemotePayload {
	if (!v || typeof v !== 'object') return false;

	const p = v as Partial<RemotePayload>;
	return (p.kind === 'buttonDown' || p.kind === 'buttonUp') &&
		(p.button === 'up' ||
		 p.button === 'down' ||
		 p.button === 'left' ||
		 p.button === 'right' ||
		 p.button === 'a' ||
		 p.button === 'b');
}

function setCharactersFromMembers(list: MemberInfo[]) {
	const controllerIds = new Set<string>();

	for (const m of list) {
		if (m.role !== MEMBER_ROLE.controller) continue;
		controllerIds.add(m.memberId);
		const c = characters.get(m.memberId) ?? createCharacter(m.memberId);
		if (m.state === MEMBER_STATE.disconnected) {
			c.buttons.clear();
			renderCharacter(c);
		}
	}
	for (const id of [...characters.keys()]) {
		if (!controllerIds.has(id)) deleteCharacter(id);
	}
	updateControllerCount();
}

function createCharacter(memberId: string): Character {
	const no = nextCharNo++;
	const w  = Math.max(1, playAreaEl.clientWidth);
	const h  = Math.max(1, playAreaEl.clientHeight);

	const el = document.createElement('div');
	el.className = 'character';
	el.dataset.memberId = memberId;
	playAreaEl.append(el);

	const c: Character = {
		memberId,
		no,
		x         : (no * 53) % w,
		y         : (no * 97) % h,
		colorIndex: (no - 1) % COLORS.length,
		buttons   : new Set(),
		el,
	};
	characters.set(memberId, c);

	renderCharacter(c);
	updateControllerCount();

	return c;
}

function deleteCharacter(memberId: string) {
	const c = characters.get(memberId);
	if (!c) return;

	c.el.remove();
	characters.delete(memberId);
	updateControllerCount();
}

function startAnimation() {
	if (rafId !== 0) cancelAnimationFrame(rafId);

	lastFrameAt = performance.now();
	rafId = requestAnimationFrame(updateFrame);
}

function updateFrame(now: number) {
	const dt = Math.min((now - lastFrameAt) / 1000, 0.05);
	lastFrameAt = now;

	const w = Math.max(1, playAreaEl.clientWidth);
	const h = Math.max(1, playAreaEl.clientHeight);

	for (const c of characters.values()) {
		let dx = 0;
		let dy = 0;

		if (c.buttons.has('left'))  dx -= 1;
		if (c.buttons.has('right')) dx += 1;
		if (c.buttons.has('up'))    dy -= 1;
		if (c.buttons.has('down'))  dy += 1;

		if (dx !== 0 || dy !== 0) {
			const len = Math.hypot(dx, dy);
			dx /= len;
			dy /= len;

			c.x = wrap(c.x + dx * MOVE_SPEED * dt, w);
			c.y = wrap(c.y + dy * MOVE_SPEED * dt, h);

			renderCharacter(c);
		}
	}
	rafId = requestAnimationFrame(updateFrame);
}

function renderCharacter(c: Character) {
	const scale = c.buttons.has('b') ? 1.45 : 1;

	c.el.style.left            = `${c.x - CHARACTER_SIZE / 2}px`;
	c.el.style.top             = `${c.y - CHARACTER_SIZE / 2}px`;
	c.el.style.backgroundColor = COLORS[c.colorIndex] as string;
	c.el.style.transform       = `scale(${scale})`;
}

function wrap(v: number, max: number): number {
	const r = v % max;
	return r < 0 ? r + max : r;
}

function renderControllerUrl() {
	const url = new URL('./controller.html', location.href);
	url.searchParams.set('roomId', roomId);

	controllerUrlEl.href        = url.toString();
	controllerUrlEl.textContent = url.toString();

	qrEl.textContent = '';

	if (typeof QRCode === 'undefined') {
		qrEl.textContent = 'QR library is not loaded.';
		return;
	}
	new QRCode(qrEl, {
		text  : url.toString(),
		width : 192,
		height: 192,
	});
}

function updateControllerCount() {
	controllerCountEl.textContent = String(characters.size);
}

function setStatus(text: string) {
	statusEl.textContent = text;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

setStatus('Not connected.');
updateControllerCount();
