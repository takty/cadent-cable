import { RelayConnection, type RelayConnectionOptions } from '../client';
import { EVENT_TYPE, type RelayEvent } from '../protocol';

// const SERVER_URL   = 'http://localhost:3000/cc';
const SERVER_URL   = 'https://lab.takty.net/api/cc';
const DISPLAY_NAME = 'controller';

const FACE_BTNS = ['a', 'b', 'x', 'y'] as const;
const DIR_BITS  = {
	up   : 0b0001,
	down : 0b0010,
	left : 0b0100,
	right: 0b1000,
} as const;

type FaceBtnName = typeof FACE_BTNS[number];
type DirBtnName  = keyof typeof DIR_BITS;
type BtnName     = DirBtnName | FaceBtnName;
type ContState   = Record<BtnName, boolean>;

const DIRS = Object.keys(DIR_BITS) as DirBtnName[];

let conn: RelayConnection<ContState> | null = null;
let isConnected = false;

const dpadPtrMap = new Map<number, number>();
const facePtrMap = new Map<number, FaceBtnName | null>();
const btnKeyMap  = new Map<string, BtnName>();
const btnCounts  = new Map<BtnName, number>();
const btnEls     = new Map<BtnName, HTMLButtonElement>();

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element not found: ${id}`);
	return el as T;
};

const dpadEl   = $<HTMLDivElement>('dpad');
const faceEl   = $<HTMLDivElement>('face');
const statusEl = $<HTMLDivElement>('status');

const roomDlgEl = $<HTMLDialogElement>('room-id-dlg');
const roomIdEl  = $<HTMLInputElement>('room-id');
const connectEl = $<HTMLInputElement>('connect');

const scanEl    = $<HTMLButtonElement>('btn-st');
const scannerEl = $<HTMLDialogElement>('qr-scanner-dlg');
const videoEl   = $<HTMLVideoElement>('qr-scanner-video');
const canvasEl  = $<HTMLCanvasElement>('qr-scanner-canvas');
const messageEl = $<HTMLParagraphElement>('qr-scanner-message');

type QrCode = {
	data: string;
};
type JsQr = (
	data    : Uint8ClampedArray,
	width   : number,
	height  : number,
	options?: { inversionAttempts: 'dontInvert' },
) => QrCode | null;

const params = new URLSearchParams(location.search);
const roomId = (params.get('roomId') ?? '').trim().toUpperCase();

roomIdEl.value = roomId || '';

setupBtn('btn-u', 'up');
setupBtn('btn-d', 'down');
setupBtn('btn-l', 'left');
setupBtn('btn-r', 'right');
setupBtn('btn-a', 'a');
setupBtn('btn-b', 'b');
setupBtn('btn-x', 'x');
setupBtn('btn-y', 'y');
setupPtrCont(dpadEl, dpadPtrMap, 0, (ev) => getDpadMask(dpadEl, ev), setDpadPtrMask);
setupPtrCont(faceEl, facePtrMap, null, getFaceBtn, setFacePtrBtn);

window.addEventListener('blur', releaseAllBtns);
window.addEventListener('pagehide', () => {
	releaseAllBtns();
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
		conn = new RelayConnection<ContState>({
			serverUrl  : SERVER_URL,
			roomId     : roomIdEl.value,
			displayName: DISPLAY_NAME,
			autoSync   : false,
			onEvent    : handleRelayEvent,
		} satisfies RelayConnectionOptions<ContState>);
		await conn.join();
	} catch (e) {
		setStatus(errorMessage(e));
	}
}

function handleRelayEvent(ev: RelayEvent<ContState>) {
	switch (ev.type) {
		case EVENT_TYPE.open:
			setStatus('Connected. Waiting for join result...');
			break;
		case EVENT_TYPE.joined:
			isConnected = true;
			setBtnsEnabled(true);
			sendContState();
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
			setBtnsEnabled(false);
			setStatus(`Join rejected: ${ev.reason}`);
			break;
		case EVENT_TYPE.roomClosed:
			isConnected = false;
			setBtnsEnabled(false);
			setStatus(`Room closed: ${ev.reason}`);
			break;
		case EVENT_TYPE.error:
			setStatus(`Error: ${ev.code ?? 'unknown'} ${ev.message ?? ''}`.trim());
			break;
		case EVENT_TYPE.close:
			isConnected = false;
			setBtnsEnabled(false);
			releaseAllBtns();
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

function setupBtn(id: string, btn: BtnName) {
	const el = $<HTMLButtonElement>(id);

	btnEls.set(btn, el);
	btnCounts.set(btn, 0);
	el.addEventListener('keydown', (ev) => {
		if (ev.key !== 'Enter' && ev.key !== ' ') return;
		ev.preventDefault();
		if (!isConnected) return;

		const keyId = `${ev.code}:${ev.location}`;
		if (btnKeyMap.has(keyId)) return;

		btnKeyMap.set(keyId, btn);
		const changed = changeBtnCount(btn, 1);
		if (changed) sendContState();
	});
	el.addEventListener('keyup', (ev) => {
		if (ev.key !== 'Enter' && ev.key !== ' ') return;
		ev.preventDefault();

		const keyId = `${ev.code}:${ev.location}`;
		const pressedBtn = btnKeyMap.get(keyId);
		if (pressedBtn !== btn) return;

		btnKeyMap.delete(keyId);
		const changed = changeBtnCount(btn, -1);
		if (changed) sendContState();
	});
	el.addEventListener('blur', () => {
		let changed = false;
		for (const [keyId, pressedBtn] of btnKeyMap) {
			if (pressedBtn !== btn) continue;

			btnKeyMap.delete(keyId);
			changed = changeBtnCount(btn, -1) || changed;
		}
		if (changed) sendContState();
	});
}

function setupPtrCont<T>(el: HTMLElement, pointers: Map<number, T>, neutral: T, getValue: (ev: PointerEvent) => T, setValue: (pointerId: number, value: T) => boolean) {
	const update = (ev: PointerEvent) => {
		if (!pointers.has(ev.pointerId)) return;

		ev.preventDefault();
		if (setValue(ev.pointerId, getValue(ev))) {
			sendContState();
		}
	};
	el.addEventListener('pointerdown', (ev) => {
		if (!isConnected || pointers.has(ev.pointerId)) return;

		pointers.set(ev.pointerId, neutral);
		el.setPointerCapture(ev.pointerId);
		update(ev);
	});
	el.addEventListener('pointermove', update);

	const end = (ev: PointerEvent) => {
		if (!pointers.has(ev.pointerId)) return;

		ev.preventDefault();
		const changed = setValue(ev.pointerId, neutral);
		pointers.delete(ev.pointerId);

		if (changed) sendContState();
	};
	el.addEventListener('pointerup', end);
	el.addEventListener('pointercancel', end);
	el.addEventListener('lostpointercapture', end);
}

function getDpadMask(el: HTMLElement, ev: PointerEvent): number {
	const r = el.getBoundingClientRect();

	if (ev.clientX < r.left || ev.clientX > r.right ||
		ev.clientY < r.top || ev.clientY > r.bottom
	) {
		return 0;
	}
	const x = (ev.clientX - r.left) / r.width;
	const y = (ev.clientY - r.top) / r.height;

	let m = 0;
	if (x < 1 / 3) {
		m |= DIR_BITS.left;
	} else if (x > 2 / 3) {
		m |= DIR_BITS.right;
	}
	if (y < 1 / 3) {
		m |= DIR_BITS.up;
	} else if (y > 2 / 3) {
		m |= DIR_BITS.down;
	}
	return m;
}

function setDpadPtrMask(ptrId: number, newMask: number) {
	const oldMask = dpadPtrMap.get(ptrId) ?? 0;
	if (oldMask === newMask) return false;

	dpadPtrMap.set(ptrId, newMask);

	let ch = false;
	for (const d of DIRS) {
		const bit = DIR_BITS[d];
		if ((oldMask & bit) === (newMask & bit)) continue;
		ch = changeBtnCount(d, (newMask & bit) ? 1 : -1) || ch;
	}
	return ch;
}

function getFaceBtn(ev: PointerEvent): FaceBtnName | null {
	for (const b of FACE_BTNS) {
		const r = btnEls.get(b)?.getBoundingClientRect();
		if (!r) continue;

		if (
			ev.clientX >= r.left &&
			ev.clientX <= r.right &&
			ev.clientY >= r.top &&
			ev.clientY <= r.bottom
		) {
			return b;
		}
	}
	return null;
}

function setFacePtrBtn(ptrId: number, newBtn: FaceBtnName | null): boolean {
	const oldBtn = facePtrMap.get(ptrId) ?? null;
	if (oldBtn === newBtn) return false;

	facePtrMap.set(ptrId, newBtn);

	let ch = false;
	if (oldBtn) {
		ch = changeBtnCount(oldBtn, -1) || ch;
	}
	if (newBtn) {
		ch = changeBtnCount(newBtn, 1) || ch;
	}
	return ch;
}

function releaseAllBtns() {
	dpadPtrMap.clear();
	facePtrMap.clear();
	btnKeyMap.clear();

	let ch = false;
	for (const [btn, count] of btnCounts) {
		if (count > 0) {
			ch = changeBtnCount(btn, -count) || ch;
		}
	}
	if (ch) sendContState();
}

function changeBtnCount(btn: BtnName, delta: number): boolean {
	const oldCount = btnCounts.get(btn) ?? 0;
	const newCount = Math.max(0, oldCount + delta);

	if (oldCount === newCount) return false;

	btnCounts.set(btn, newCount);
	updateBtnView(btn);

	return (oldCount > 0) !== (newCount > 0);
}

function createContState(): ContState {
	return {
		up   : isBtnPressed('up'),
		down : isBtnPressed('down'),
		left : isBtnPressed('left'),
		right: isBtnPressed('right'),
		a    : isBtnPressed('a'),
		b    : isBtnPressed('b'),
		x    : isBtnPressed('x'),
		y    : isBtnPressed('y'),
	};
}

function isBtnPressed(btn: BtnName): boolean {
	return (btnCounts.get(btn) ?? 0) > 0;
}

function sendContState() {
	if (!isConnected) return;
	try {
		conn?.sendData(createContState());
	} catch (e) {
		setStatus(errorMessage(e));
	}
}

function updateBtnView(btn: BtnName) {
	const el = btnEls.get(btn);
	if (!el) return;
	el.classList.toggle('pressed', isBtnPressed(btn));
}

function setBtnsEnabled(enabled: boolean) {
	for (const el of btnEls.values()) {
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

setBtnsEnabled(false);
setStatus('Not connected.');
