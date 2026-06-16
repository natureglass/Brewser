export type SwitchButtonLabel = 'A' | 'B' | 'X' | 'Y' | 'L' | 'R' | 'ZL' | 'ZR' | 'MINUS' | 'PLUS' | 'L_STICK' | 'R_STICK' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'HOME' | 'CAPTURE' | 'LEFT_SL' | 'LEFT_SR' | 'RIGHT_SL' | 'RIGHT_SR';
export type ButtonAction = '' | 'leftClick' | 'rightClick' | 'middleClick' | 'back' | 'forward' | 'reload' | 'home' | 'addressBar' | 'settings' | 'bookmark' | 'screenshot' | 'scrollUp' | 'scrollDown' | 'scrollLeft' | 'scrollRight' | 'exit';
/**
 * Replace the active button mapping. Called from the shell at boot
 * after `loadConfig()` finishes. `config.json buttonMapping` is
 * **action-keyed**: each entry says "this action should be triggered
 * by this Switch button."
 *
 * Schema:
 *
 *   "buttonMapping": {
 *       "leftClick": "A",
 *       "rightClick": "B",
 *       "back":      "L",
 *       …
 *   }
 *
 * Keys are action strings from `ButtonAction`; values are Switch
 * button labels from the `SwitchButtonLabel` set. An empty value
 * falls back to the engine default for that action; unrecognised
 * keys/values are dropped. Two actions assigned to the same button
 * are honoured in JSON-key order (the last one wins).
 */
export declare function setButtonMapping(userMapping: Record<string, unknown> | null | undefined): void;
/** Layer an action-keyed mapping (as authored in an app's
 * `manifest.json buttonMapping`) on top of the base shell mapping.
 * Called by the shell when navigating into an `brewser://apps/<group>/<id>/...`
 * page so the app gets its declared per-button semantics for the
 * duration of the navigation. Passing `null` is equivalent to
 * `clearAppButtonOverlay`. Same parser as the global config — see
 * `setButtonMapping` for the schema. */
export declare function setAppButtonOverlay(overlay: Record<string, unknown> | null | undefined): void;
/** Drop the active app overlay and revert to the base shell mapping.
 * Called when navigating away from an app page (back to the launcher,
 * settings, etc.). No-op when no overlay is active. */
export declare function clearAppButtonOverlay(): void;
/** What action is currently assigned to a Switch button? */
export declare function getActionForButton(label: SwitchButtonLabel): ButtonAction;
/** What Web Gamepad standard-layout index does this Switch label use?
 * Returns -1 for labels nxjs doesn't expose. */
export declare function getButtonIndexForLabel(label: SwitchButtonLabel): number;
/** Reverse lookup: which gamepad index currently serves the given
 * action? Returns -1 when no button is bound to that action. Used by
 * the mouse forwarder to poll the right indices for leftClick /
 * rightClick / middleClick regardless of how the user has mapped them. */
export declare function getButtonIndexForAction(action: ButtonAction): number;
/** Did the user map any button to a "mouse"-class action? Used by the
 * mouse forwarder to short-circuit polling when nothing is bound. */
export declare function hasAnyMouseBinding(): boolean;
/** Enumerate the active mapping. Useful for diagnostic logging or for
 * the shell to drive its rising-edge dispatch by iterating once over
 * a single table instead of N hardcoded checks. */
export declare function listMappedButtons(): {
    label: SwitchButtonLabel;
    idx: number;
    action: ButtonAction;
}[];
//# sourceMappingURL=button-router.d.ts.map