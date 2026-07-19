import { RelayConnection, type RelayConnectionOptions } from '../client';
import { EVENT_TYPE, type RelayEvent } from '../protocol';

// const SERVER_URL   = 'http://localhost:3000/cc';
const SERVER_URL   = 'https://lab.takty.net/api/cc';
const DISPLAY_NAME = 'controller';

type ButtonName = 'up' | 'down' | 'left' | 'right' | 'a' | 'b';

type ControllerState = {
	up    : boolean;
	down  : boolean;
	left  : boolean;
	right : boolean;
	a     : boolean;
	b     : boolean;
};

let conn: RelayConnection<ControllerState> | null = null;
let isConnected = false;

const buttonPointerMap = new Map<number, ButtonName>();
const buttonCounts     = new Map<ButtonName, number>();
const buttonEls        = new Map<ButtonName, HTMLButtonElement>();

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element not found: ${id}`);
	return el as T;
};

const roomIdEl  = $<HTMLInputElement>('room-id');
const connectEl = $<HTMLInputElement>('connect');
const statusEl  = $<HTMLDivElement>('status');

const params = new URLSearchParams(location.search);
const roomId = (params.get('roomId') ?? '').trim().toUpperCase();

roomIdEl.value = roomId || '';

setupButton('btn-u', 'up');
setupButton('btn-d', 'down');
setupButton('btn-l', 'left');
setupButton('btn-r', 'right');
setupButton('btn-a', 'a');
setupButton('btn-b', 'b');

window.addEventListener('blur', releaseAllButtons);
window.addEventListener('pagehide', () => {
	releaseAllButtons();
	conn?.leave();
});

connect();

connectEl.addEventListener('click', connect);

async function connect() {
	if (isConnected) {
		conn?.leave();
	}
	if (!roomIdEl.value) {
		setStatus('Room ID is missing.');
		return;
	}
	try {
		setStatus('Connecting...');
		conn = new RelayConnection<ControllerState>({
			serverUrl  : SERVER_URL,
			roomId     : roomIdEl.value,
			displayName: DISPLAY_NAME,
			autoSync   : false,
			onEvent    : handleRelayEvent,
		} satisfies RelayConnectionOptions<ControllerState>);
		await conn.join();
	} catch (e) {
		setStatus(errorMessage(e));
	}
}

function handleRelayEvent(ev: RelayEvent<ControllerState>) {
	switch (ev.type) {
		case EVENT_TYPE.open:
			setStatus('Connected. Waiting for join result...');
			break;
		case EVENT_TYPE.joined:
			isConnected = true;
			setButtonsEnabled(true);
			sendControllerState();
			setStatus('Ready.');
			break;
		case EVENT_TYPE.pending:
			setStatus(`Waiting for approval... (${ev.requiredApprovals} OK required)`);
			break;
		case EVENT_TYPE.joinRejected:
			isConnected = false;
			setButtonsEnabled(false);
			setStatus(`Join rejected: ${ev.reason}`);
			break;
		case EVENT_TYPE.roomClosed:
			isConnected = false;
			setButtonsEnabled(false);
			setStatus(`Room closed: ${ev.reason}`);
			break;
		case EVENT_TYPE.error:
			setStatus(`Error: ${ev.code ?? 'unknown'} ${ev.message ?? ''}`.trim());
			break;
		case EVENT_TYPE.close:
			isConnected = false;
			setButtonsEnabled(false);
			releaseAllButtons();
			setStatus(`Closed: ${ev.code} ${ev.reason}`.trim());
			break;
		case EVENT_TYPE.syncStatus:
		case EVENT_TYPE.heartbeat:
		case EVENT_TYPE.tick:
		case EVENT_TYPE.memberJoined:
		case EVENT_TYPE.memberLeft:
			break;
	}
}

function setupButton(id: string, button: ButtonName) {
	const el = $<HTMLButtonElement>(id);

	buttonEls.set(button, el);
	buttonCounts.set(button, 0);

	el.addEventListener('pointerdown', (ev) => {
		ev.preventDefault();
		if (!isConnected) return;
		if (buttonPointerMap.has(ev.pointerId)) return;

		buttonPointerMap.set(ev.pointerId, button);
		el.setPointerCapture(ev.pointerId);

		changeButtonCount(button, 1);
	});
	const end = (ev: PointerEvent) => {
		ev.preventDefault();

		const button = buttonPointerMap.get(ev.pointerId);
		if (!button) return;

		buttonPointerMap.delete(ev.pointerId);
		changeButtonCount(button, -1);
	};
	el.addEventListener('pointerup', end);
	el.addEventListener('pointercancel', end);
	el.addEventListener('lostpointercapture', end);
}

function changeButtonCount(button: ButtonName, delta: number) {
	const oldCount = buttonCounts.get(button) ?? 0;
	const newCount = Math.max(0, oldCount + delta);

	if (oldCount === newCount) return;

	buttonCounts.set(button, newCount);
	updateButtonView(button);

	const oldPressed = oldCount > 0;
	const newPressed = newCount > 0;

	if (oldPressed !== newPressed) {
		sendControllerState();
	}
}

function releaseAllButtons() {
	buttonPointerMap.clear();
	let changed = false;

	for (const button of buttonCounts.keys()) {
		const oldCount = buttonCounts.get(button) ?? 0;

		if (oldCount > 0) {
			buttonCounts.set(button, 0);
			updateButtonView(button);
			changed = true;
		}
	}
	if (changed) {
		sendControllerState();
	}
}

function createControllerState(): ControllerState {
	return {
		up    : isButtonPressed('up'),
		down  : isButtonPressed('down'),
		left  : isButtonPressed('left'),
		right : isButtonPressed('right'),
		a     : isButtonPressed('a'),
		b     : isButtonPressed('b'),
	};
}

function isButtonPressed(button: ButtonName): boolean {
	return (buttonCounts.get(button) ?? 0) > 0;
}

function sendControllerState() {
	if (!isConnected) return;
	try {
		conn?.sendData(createControllerState());
	} catch (e) {
		setStatus(errorMessage(e));
	}
}

function updateButtonView(button: ButtonName) {
	const el = buttonEls.get(button);
	if (!el) return;
	el.classList.toggle('pressed', isButtonPressed(button));
}

function setButtonsEnabled(enabled: boolean) {
	for (const el of buttonEls.values()) {
		el.disabled = !enabled;
	}
}

function setStatus(text: string) {
	statusEl.textContent = text;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

setButtonsEnabled(false);
setStatus('Not connected.');
