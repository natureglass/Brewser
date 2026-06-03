/**
 * Tier-1 `MessageChannel` + `MessagePort` polyfill for switch-web-browser.
 *
 * Both ports live in the same JS context (single QuickJS isolate, no
 * Workers), so we implement the entanglement by direct reference:
 * `port.postMessage(x)` enqueues x on the *other* port and schedules
 * a microtask flush. Once the receiving port is "started" (via an
 * `addEventListener('message', …)` OR an `onmessage = …` assignment OR
 * an explicit `.start()` call) all queued messages dispatch.
 *
 * Tier-1 limitations:
 * - **No real structured clone.** The message reference is passed
 *   through as-is. The same JS context owns both ends so this is
 *   actually safer than JSON.parse(JSON.stringify(...)) — Date/Map/Set/
 *   typed arrays/Functions all survive. Trade-off: a real browser would
 *   deep-copy so mutations on one side don't leak to the other; here
 *   they do. Don't mutate sent objects.
 * - **No transferables.** The optional `transfer` arg to `postMessage`
 *   is ignored. ArrayBuffers/MessagePorts can't be "moved" — they're
 *   just shared by reference. Same caveat as above.
 * - **No `messageerror` event** (would fire on clone failure; we don't clone).
 * - **No `BroadcastChannel`** sibling — separate polyfill if needed.
 */

type MessageEventInit = {
	data: unknown;
	origin?: string;
	lastEventId?: string;
	source?: unknown;
	ports?: MessagePort[];
};

class PortMessageEvent {
	readonly type = 'message';
	readonly data: unknown;
	readonly origin: string;
	readonly lastEventId: string;
	readonly source: unknown;
	readonly ports: MessagePort[];
	target: unknown = null;
	currentTarget: unknown = null;
	constructor(init: MessageEventInit) {
		this.data = init.data;
		this.origin = init.origin ?? '';
		this.lastEventId = init.lastEventId ?? '';
		this.source = init.source ?? null;
		this.ports = init.ports ?? [];
	}
}

type Listener = (ev: PortMessageEvent) => void;

function schedule(fn: () => void): void {
	if (typeof queueMicrotask === 'function') queueMicrotask(fn);
	else Promise.resolve().then(fn);
}

export class MessagePort {
	_entangled: MessagePort | null = null;
	_queue: unknown[] = [];
	_started = false;
	_closed = false;
	_listeners: Listener[] = [];
	_onmessage: Listener | null = null;

	get onmessage(): Listener | null {
		return this._onmessage;
	}
	set onmessage(handler: Listener | null) {
		this._onmessage = handler;
		// Per spec: assigning a handler to MessagePort.onmessage implicitly
		// starts the port. This is the most-relied-on convenience in real
		// game / library code (Tone.js, RxJS schedulers, etc.).
		if (handler) this.start();
	}

	addEventListener(type: string, listener: Listener): void {
		if (type !== 'message') return; // Tier-1: only 'message' supported
		if (this._listeners.indexOf(listener) >= 0) return;
		this._listeners.push(listener);
		// addEventListener('message', …) also implicitly starts the port,
		// per the same spec rule that `onmessage = …` does.
		this.start();
	}

	removeEventListener(type: string, listener: Listener): void {
		if (type !== 'message') return;
		const i = this._listeners.indexOf(listener);
		if (i >= 0) this._listeners.splice(i, 1);
	}

	dispatchEvent(ev: PortMessageEvent): boolean {
		ev.target = this;
		ev.currentTarget = this;
		for (const l of this._listeners.slice()) { try { l(ev); } catch { /* ignore */ } }
		if (this._onmessage) { try { this._onmessage(ev); } catch { /* ignore */ } }
		return true;
	}

	postMessage(message: unknown, _transfer?: unknown[]): void {
		if (this._closed) return;
		const target = this._entangled;
		if (!target || target._closed) return;
		// No structured clone for Tier-1. Same-context shared references
		// are actually fine; library code rarely mutates after send.
		target._queue.push(message);
		// Schedule a dispatch on the target. If the target isn't started
		// yet, the message sits in its queue until it starts.
		schedule(() => target._flushQueue());
	}

	start(): void {
		if (this._started || this._closed) return;
		this._started = true;
		// Flush anything that arrived before start() was called.
		schedule(() => this._flushQueue());
	}

	close(): void {
		this._closed = true;
		this._queue.length = 0;
	}

	_flushQueue(): void {
		if (!this._started || this._closed) return;
		while (this._queue.length > 0) {
			const msg = this._queue.shift();
			const ev = new PortMessageEvent({ data: msg });
			this.dispatchEvent(ev);
		}
	}
}

export class MessageChannel {
	readonly port1: MessagePort;
	readonly port2: MessagePort;
	constructor() {
		this.port1 = new MessagePort();
		this.port2 = new MessagePort();
		this.port1._entangled = this.port2;
		this.port2._entangled = this.port1;
	}
}

let installed = false;

/**
 * Define `globalThis.MessageChannel` + `globalThis.MessagePort`. Call
 * once at app startup. Idempotent.
 */
export function installMessageChannel(): void {
	if (installed) return;
	installed = true;
	Object.defineProperty(globalThis, 'MessageChannel', {
		value: MessageChannel, writable: true, configurable: true,
	});
	Object.defineProperty(globalThis, 'MessagePort', {
		value: MessagePort, writable: true, configurable: true,
	});
}
