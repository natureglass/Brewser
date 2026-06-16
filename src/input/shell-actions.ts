import { subscribeAction, type ActionHandler } from '@switch-web/runtime';

// Shell-side action enum + subscription seam. The runtime's
// button-router (`@switch-web/runtime`) maps Switch buttons to action
// STRINGS; every rising edge fires `emitAction(actionName, ctx)` via
// the runtime's action bus. The runtime handles its own actions
// internally (mouse, scroll). The shell handles the chrome actions
// listed here by subscribing to the bus.
//
// Today most chrome actions still flow through the legacy
// `ControllerInput` discriminated union (see
// `@switch-web/runtime` controller-shortcuts.ts → `peekPendingInput`
// → `browser-shell.ts`). Phase 3 keeps that pipeline intact so this
// migration ships behaviourally identical; the bus runs IN PARALLEL,
// so shell code can opt subscriber-by-subscriber off the ControllerInput
// pull pattern over time without breaking anything else.

/** Chrome-only actions the shell knows how to handle. The buttonMapping
 * schema (`config.json buttonMapping`) accepts these strings as values;
 * the runtime treats them as opaque labels. */
export type ShellButtonAction =
	| 'reload'
	| 'home'
	| 'addressBar'
	| 'settings'
	| 'bookmark'
	| 'screenshot'
	| 'exit'
	| 'search';

/** Convenience wrapper around the runtime's `subscribeAction` that
 * narrows the name parameter to {@link ShellButtonAction}. Returns the
 * unsubscribe function (same contract as the underlying bus). */
export function subscribeShellAction(
	name: ShellButtonAction,
	handler: ActionHandler,
): () => void {
	return subscribeAction(name, handler);
}
