import { RelayConnection, type RelayConnectionOptions } from '../client';
import { EVENT_TYPE, type RelayEvent } from '../protocol';

// const SERVER_URL   = 'http://localhost:3000/cc';
const SERVER_URL   = 'https://lab.takty.net/api/cc';
const DISPLAY_NAME = 'controller';

type ButtonName = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'x' | 'y';

type DirectionButtonName = 'up' | 'down' | 'left' | 'right';

const DIRECTION_BITS: Record<DirectionButtonName, number> = {
	up   : 0b0001,
	down : 0b0010,
	left : 0b0100,
	right: 0b1000,
};

const DIRECTIONS: readonly DirectionButtonName[] = [
	'up',
	'down',
	'left',
	'right',
];

type ControllerState = {
	up    : boolean;
	down  : boolean;
	left  : boolean;
	right : boolean;
	a     : boolean;
	b     : boolean;
	x     : boolean;
	y     : boolean;
};

let conn: RelayConnection<ControllerState> | null = null;
let isConnected = false;
let lastSentControllerState: ControllerState | null = null;

const buttonPointerMap = new Map<number, ButtonName>();
const dpadPointerMap   = new Map<number, number>();
const buttonKeyMap     = new Map<string, ButtonName>();
const buttonCounts     = new Map<ButtonName, number>();
const buttonEls        = new Map<ButtonName, HTMLButtonElement>();

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element not found: ${id}`);
	return el as T;
};

const roomIdEl  = $<HTMLInputElement>('room-id');
const roomDlgEl = $<HTMLDialogElement>('room-id-dlg');
const connectEl = $<HTMLInputElement>('connect');
const statusEl  = $<HTMLDivElement>('status');
const scanEl    = $<HTMLButtonElement>('btn-st');
const scannerEl = $<HTMLDialogElement>('qr-scanner-dlg');
const videoEl   = $<HTMLVideoElement>('qr-scanner-video');
const canvasEl  = $<HTMLCanvasElement>('qr-scanner-canvas');
const messageEl = $<HTMLParagraphElement>('qr-scanner-message');
const dpadEl    = $<HTMLDivElement>('dpad');

type QrCode = {
	data: string;
};

type JsQr = (
	data: Uint8ClampedArray,
	width: number,
	height: number,
	options?: { inversionAttempts: 'dontInvert' },
) => QrCode | null;

const params = new URLSearchParams(location.search);
const roomId = (params.get('roomId') ?? '').trim().toUpperCase();

roomIdEl.value = roomId || '';

setupButton('btn-u', 'up');
setupButton('btn-d', 'down');
setupButton('btn-l', 'left');
setupButton('btn-r', 'right');
setupButton('btn-a', 'a');
setupButton('btn-b', 'b');
setupButton('btn-x', 'x');
setupButton('btn-y', 'y');
setupDpad(dpadEl);

window.addEventListener('blur', releaseAllButtons);
window.addEventListener('pagehide', () => {
	releaseAllButtons();
	closeQrScanner();
	conn?.leave();
});

connect();

connectEl.addEventListener('click', connect);
scanEl.addEventListener('click', openQrScanner);
scannerEl.addEventListener('click', closeQrScanner);
scannerEl.addEventListener('cancel', closeQrScanner);

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
			if (roomDlgEl.matches(':popover-open')) {
				roomDlgEl.hidePopover();
			}
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

		if (isDirectionButton(button)) {
			if (dpadPointerMap.has(ev.pointerId)) return;

			el.setPointerCapture(ev.pointerId);
			setDpadPointerMask(
				ev.pointerId,
				DIRECTION_BITS[button],
			);
			return;
		}

		if (buttonPointerMap.has(ev.pointerId)) return;

		buttonPointerMap.set(ev.pointerId, button);
		el.setPointerCapture(ev.pointerId);

		const changed = changeButtonCount(button, 1);
		if (changed) sendControllerState();
	});

	const end = (ev: PointerEvent) => {
		ev.preventDefault();

		if (isDirectionButton(button)) {
			if (!dpadPointerMap.has(ev.pointerId)) return;

			setDpadPointerMask(ev.pointerId, 0);
			dpadPointerMap.delete(ev.pointerId);
			return;
		}

		const pressedButton = buttonPointerMap.get(ev.pointerId);
		if (!pressedButton) return;

		buttonPointerMap.delete(ev.pointerId);

		const changed = changeButtonCount(pressedButton, -1);
		if (changed) sendControllerState();
	};

	el.addEventListener('pointerup', end);
	el.addEventListener('pointercancel', end);
	el.addEventListener('lostpointercapture', end);

	el.addEventListener('keydown', (ev) => {
		if (ev.key !== 'Enter' && ev.key !== ' ') return;
		ev.preventDefault();
		if (!isConnected) return;

		const keyId = `${ev.code}:${ev.location}`;
		if (buttonKeyMap.has(keyId)) return;

		buttonKeyMap.set(keyId, button);
		const changed = changeButtonCount(button, 1);
		if (changed) sendControllerState();
	});
	el.addEventListener('keyup', (ev) => {
		if (ev.key !== 'Enter' && ev.key !== ' ') return;
		ev.preventDefault();

		const keyId = `${ev.code}:${ev.location}`;
		const pressedButton = buttonKeyMap.get(keyId);
		if (pressedButton !== button) return;

		buttonKeyMap.delete(keyId);
		const changed = changeButtonCount(button, -1);
		if (changed) sendControllerState();
	});
	el.addEventListener('blur', () => {
		let changed = false;
		for (const [keyId, pressedButton] of buttonKeyMap) {
			if (pressedButton !== button) continue;

			buttonKeyMap.delete(keyId);
			changed = changeButtonCount(button, -1) || changed;
		}
		if (changed) sendControllerState();
	});
}

function isDirectionButton(button: ButtonName): button is DirectionButtonName {
	return (
		button === 'up' ||
		button === 'down' ||
		button === 'left' ||
		button === 'right'
	);
}

function setDpadPointerMask(pointerId: number, newMask: number) {
	const oldMask = dpadPointerMap.get(pointerId) ?? 0;

	if (oldMask === newMask) return;

	for (const direction of DIRECTIONS) {
		const bit = DIRECTION_BITS[direction];

		const oldPressed = (oldMask & bit) !== 0;
		const newPressed = (newMask & bit) !== 0;

		if (oldPressed === newPressed) continue;

		changeButtonCount(direction, newPressed ? 1 : -1);
	}
	dpadPointerMap.set(pointerId, newMask);
}

function setupDpad(el: HTMLDivElement) {
	el.addEventListener('pointerdown', (ev) => {
		ev.preventDefault();
		if (!isConnected) return;

		if (!dpadPointerMap.has(ev.pointerId)) {
			el.setPointerCapture(ev.pointerId);
		}
		setDpadPointerMask(ev.pointerId, getDpadMask(el, ev));
		sendControllerStateIfChanged();
	});
	el.addEventListener('pointermove', (ev) => {
		if (!dpadPointerMap.has(ev.pointerId)) return;

		ev.preventDefault();

		setDpadPointerMask(ev.pointerId, getDpadMask(el, ev));
		sendControllerStateIfChanged();
	});
	const end = (ev: PointerEvent) => {
		ev.preventDefault();

		if (dpadPointerMap.has(ev.pointerId)) {
			setDpadPointerMask(ev.pointerId, 0);
			dpadPointerMap.delete(ev.pointerId);
		}
		sendControllerStateIfChanged();
	};

	el.addEventListener('pointerup', end);
	el.addEventListener('pointercancel', end);
	el.addEventListener('lostpointercapture', end);
}

function getDpadMask(el: HTMLElement, ev: PointerEvent): number {
	const rect = el.getBoundingClientRect();

	const x = (ev.clientX - rect.left) / rect.width;
	const y = (ev.clientY - rect.top) / rect.height;

	let mask = 0;

	if (x < 1 / 3) {
		mask |= DIRECTION_BITS.left;
	} else if (x > 2 / 3) {
		mask |= DIRECTION_BITS.right;
	}
	if (y < 1 / 3) {
		mask |= DIRECTION_BITS.up;
	} else if (y > 2 / 3) {
		mask |= DIRECTION_BITS.down;
	}
	return mask;
}

function controllerStatesEqual(a: ControllerState, b: ControllerState): boolean {
	return (
		a.up === b.up &&
		a.down === b.down &&
		a.left === b.left &&
		a.right === b.right &&
		a.a === b.a &&
		a.b === b.b &&
		a.x === b.x &&
		a.y === b.y
	);
}

function changeButtonCount(button: ButtonName, delta: number): boolean {
	const oldCount = buttonCounts.get(button) ?? 0;
	const newCount = Math.max(0, oldCount + delta);

	if (oldCount === newCount) return false;

	buttonCounts.set(button, newCount);
	updateButtonView(button);

	const oldPressed = oldCount > 0;
	const newPressed = newCount > 0;

	return oldPressed !== newPressed;
}

function releaseAllButtons() {
	buttonPointerMap.clear();
	dpadPointerMap.clear();
	buttonKeyMap.clear();
	let changed = false;

	for (const button of buttonCounts.keys()) {
		const oldCount = buttonCounts.get(button) ?? 0;

		if (oldCount > 0) {
			changed = changeButtonCount(button, -oldCount) || changed;
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
		x     : isButtonPressed('x'),
		y     : isButtonPressed('y'),
	};
}

function isButtonPressed(button: ButtonName): boolean {
	return (buttonCounts.get(button) ?? 0) > 0;
}

function sendControllerState(
	state: ControllerState = createControllerState(),
) {
	if (!isConnected) return;

	try {
		conn?.sendData(state);
		lastSentControllerState = state;
	} catch (e) {
		setStatus(errorMessage(e));
	}
}

function sendControllerStateIfChanged() {
	const state = createControllerState();

	if (
		lastSentControllerState &&
		controllerStatesEqual(lastSentControllerState, state)
	) {
		return;
	}

	sendControllerState(state);
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

async function openQrScanner() {
	const jsQR = (window as typeof window & { jsQR?: JsQr }).jsQR;
	if (!jsQR) {
		setStatus('QR scanner could not be loaded.');
		return;
	}
	if (!navigator.mediaDevices?.getUserMedia) {
		setStatus('Camera access is not supported by this browser.');
		return;
	}

	if (scannerEl.open) return;
	messageEl.textContent = 'Show the QR code to the camera.';
	scannerEl.showModal();

	try {
		// The dialog remains viewport-sized when the Fullscreen API is unavailable.
		await scannerEl.requestFullscreen?.().catch(() => undefined);
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: { facingMode: { ideal: 'environment' } },
		});
		if (!scannerEl.open) {
			stream.getTracks().forEach((track) => track.stop());
			return;
		}

		videoEl.srcObject = stream;
		await videoEl.play();
		const context = canvasEl.getContext('2d', { willReadFrequently: true });
		if (!context) {
			throw new Error('Canvas is not supported by this browser.');
		}

		const scan = () => {
			if (!scannerEl.open) return;
			try {
				if (videoEl.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
					canvasEl.width  = videoEl.videoWidth;
					canvasEl.height = videoEl.videoHeight;
					context.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

					const image = context.getImageData(0, 0, canvasEl.width, canvasEl.height);
					const result = jsQR(image.data, image.width, image.height, {
						inversionAttempts: 'dontInvert',
					});
					const destination = result && toSafeWebUrl(result.data);
					if (destination) {
						closeQrScanner();
						location.assign(destination);
						return;
					}
					if (result) {
						messageEl.textContent = 'This is not a QR code for a web URL.';
					}
				}
			} catch (e) {
				closeQrScanner();
				setStatus(`QR scan failed: ${errorMessage(e)}`);
				return;
			}
			requestAnimationFrame(scan);
		};
		requestAnimationFrame(scan);
	} catch (e) {
		closeQrScanner();
		setStatus(`Could not open camera: ${errorMessage(e)}`);
	}
}

function closeQrScanner() {
	const stream = videoEl.srcObject;
	if (stream instanceof MediaStream) {
		stream.getTracks().forEach((track) => track.stop());
	}
	videoEl.srcObject = null;
	if (document.fullscreenElement === scannerEl) {
		void document.exitFullscreen().catch(() => undefined);
	}
	if (scannerEl.open) {
		scannerEl.close();
	}
}

function toSafeWebUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

setButtonsEnabled(false);
setStatus('Not connected.');
