/**
 * Tier-1 `MessageChannel` + `MessagePort` polyfill for brewser.
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
declare class PortMessageEvent {
    readonly type = "message";
    readonly data: unknown;
    readonly origin: string;
    readonly lastEventId: string;
    readonly source: unknown;
    readonly ports: MessagePort[];
    target: unknown;
    currentTarget: unknown;
    constructor(init: MessageEventInit);
}
type Listener = (ev: PortMessageEvent) => void;
export declare class MessagePort {
    _entangled: MessagePort | null;
    _queue: unknown[];
    _started: boolean;
    _closed: boolean;
    _listeners: Listener[];
    _onmessage: Listener | null;
    get onmessage(): Listener | null;
    set onmessage(handler: Listener | null);
    addEventListener(type: string, listener: Listener): void;
    removeEventListener(type: string, listener: Listener): void;
    dispatchEvent(ev: PortMessageEvent): boolean;
    postMessage(message: unknown, _transfer?: unknown[]): void;
    start(): void;
    close(): void;
    _flushQueue(): void;
}
export declare class MessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;
    constructor();
}
/**
 * Define `globalThis.MessageChannel` + `globalThis.MessagePort`. Call
 * once at app startup. Idempotent.
 */
export declare function installMessageChannel(): void;
export {};
//# sourceMappingURL=message-channel.d.ts.map