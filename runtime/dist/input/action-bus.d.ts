/**
 * Generic-input actions owned by the runtime. The shell extends this
 * by emitting strings outside this set (see
 * `brewser/src/input/shell-actions.ts`).
 */
export type RuntimeButtonAction = 'leftClick' | 'rightClick' | 'middleClick' | 'scrollUp' | 'scrollDown' | 'scrollLeft' | 'scrollRight' | 'submit' | 'dismiss' | 'back' | 'forward';
export interface ActionContext {
    /** Switch button label (`A`, `B`, `ZR`, …) that triggered the
     * event, when the source was a controller rising edge. Absent when
     * the action came from another path (touch, keyboard, programmatic). */
    label?: string;
    /** Gamepad index 0-19 (Web Gamepad standard layout) when the source
     * was a controller rising edge. Absent otherwise. */
    buttonIndex?: number;
}
export type ActionHandler = (action: string, ctx: ActionContext) => void;
/**
 * Register a handler for the named action. Returns an unsubscribe
 * function so callers don't have to thread the same handler reference
 * around to remove it later.
 */
export declare function subscribeAction(name: string, handler: ActionHandler): () => void;
/**
 * Fire all handlers registered for the action. Handlers run in
 * registration order. Exceptions inside a handler are logged but
 * don't stop the rest of the chain — one bad subscriber shouldn't
 * swallow the event for the rest.
 */
export declare function emitAction(name: string, ctx?: ActionContext): void;
/** Has anyone registered a handler for this action? Useful for
 * short-circuiting expensive emit paths when nothing is listening. */
export declare function hasActionHandler(name: string): boolean;
/** Test-only / shutdown helper. Drops every subscriber. */
export declare function clearActionHandlers(): void;
//# sourceMappingURL=action-bus.d.ts.map