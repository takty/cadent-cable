import { RelayConnection, type RelayConnectionOptions } from '../client';
import { type RelayEvent } from '../types';

// const SERVER_URL   = 'http://localhost:3000/cc';
const SERVER_URL   = 'http://10.13.106.1/api/cc';
const DISPLAY_NAME = 'controller';

type ButtonName = 'up' | 'down' | 'left' | 'right' | 'a' | 'b';

type RemotePayload = {
	kind  : 'buttonDown' | 'buttonUp';
	button: ButtonName;
};

let conn: RelayConnection<RemotePayload> | null = null;
let isConnected = false;

const buttonPointerMap = new Map<number, ButtonName>();
const buttonCounts     = new Map<ButtonName, number>();
const buttonEls        = new Map<ButtonName, HTMLButtonElement>();

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element not found: ${id}`);
	return el as T;
};

const roomIdEl = $<HTMLElement>('room-id');
const statusEl = $<HTMLDivElement>('status');

const params = new URLSearchParams(location.search);
const roomId = (params.get('roomId') ?? '').trim().toUpperCase();

roomIdEl.textContent = roomId || '-';

setupButton('btn-up', 'up');
setupButton('btn-down', 'down');
setupButton('btn-left', 'left');
setupButton('btn-right', 'right');
setupButton('btn-a', 'a');
setupButton('btn-b', 'b');

window.addEventListener('blur', releaseAllButtons);
window.addEventListener('pagehide', () => {
	releaseAllButtons();
	conn?.disconnect();
});

connect();

async function connect() {
	if (!roomId) {
		setStatus('Room ID is missing.');
		return;
	}
	try {
		setStatus('Connecting...');

		conn = new RelayConnection<RemotePayload>({
			serverUrl  : SERVER_URL,
			roomId,
			displayName: DISPLAY_NAME,
			autoSync   : false,
			onEvent    : handleRelayEvent,
		} satisfies RelayConnectionOptions<RemotePayload>);

		await conn.connect();
	} catch (e) {
		setStatus(errorMessage(e));
	}
}

function handleRelayEvent(ev: RelayEvent<RemotePayload>) {
	switch (ev.type) {
		case 'open':
			setStatus('Connected. Waiting for join result...');
			break;
		case 'joined':
			isConnected = true;
			setButtonsEnabled(true);
			setStatus('Ready.');
			break;
		case 'pending':
			setStatus(`Waiting for approval... (${ev.requiredApprovals} OK required)`);
			break;
		case 'joinRejected':
			isConnected = false;
			setButtonsEnabled(false);
			setStatus(`Join rejected: ${ev.reason}`);
			break;
		case 'roomClosed':
			isConnected = false;
			setButtonsEnabled(false);
			setStatus(`Room closed: ${ev.reason}`);
			break;
		case 'error':
			setStatus(`Error: ${ev.code ?? 'unknown'} ${ev.message ?? ''}`.trim());
			break;
		case 'close':
			isConnected = false;
			setButtonsEnabled(false);
			releaseAllButtons();
			setStatus(`Closed: ${ev.code} ${ev.reason}`.trim());
			break;
		case 'syncStatus':
		case 'heartbeat':
		case 'tick':
		case 'memberJoined':
		case 'memberLeft':
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

		const b = buttonPointerMap.get(ev.pointerId);
		if (!b) return;

		buttonPointerMap.delete(ev.pointerId);
		changeButtonCount(b, -1);
	};

	el.addEventListener('pointerup', end);
	el.addEventListener('pointercancel', end);
	el.addEventListener('lostpointercapture', end);
}

function changeButtonCount(button: ButtonName, delta: number) {
	const oldCount = buttonCounts.get(button) ?? 0;
	const newCount = Math.max(0, oldCount + delta);

	buttonCounts.set(button, newCount);
	updateButtonView(button);

	if (oldCount === 0 && newCount > 0) {
		sendButtonEvent('buttonDown', button);
	}
	if (oldCount > 0 && newCount === 0) {
		sendButtonEvent('buttonUp', button);
	}
}

function releaseAllButtons() {
	buttonPointerMap.clear();

	for (const button of buttonCounts.keys()) {
		const oldCount = buttonCounts.get(button) ?? 0;
		if (oldCount > 0) {
			buttonCounts.set(button, 0);
			updateButtonView(button);
			sendButtonEvent('buttonUp', button);
		}
	}
}

function sendButtonEvent(kind: RemotePayload['kind'], button: ButtonName) {
	if (!isConnected) return;

	try {
		conn?.sendData({ kind, button });
	} catch (e) {
		setStatus(errorMessage(e));
	}
}

function updateButtonView(button: ButtonName) {
	const el = buttonEls.get(button);
	if (!el) return;

	const count = buttonCounts.get(button) ?? 0;
	el.classList.toggle('pressed', count > 0);
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
