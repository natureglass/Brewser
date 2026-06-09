// Central button-action router. Both the shell-shortcut layer in
// `controller-shortcuts.ts` and the software-cursor layer in
// `page-mouse-forwarder.ts` consult THIS module to decide what each
// joycon button does. Without a single source of truth the two layers
// were racing — pressing Switch's A button (gamepad index 1) fired
// BOTH the shell's old "back" action (which had been wired via
// COMBO_BUTTONS.b = 1) AND the mouse layer's left-click, so every A
// press would left-click the page AND immediately navigate back.
//
// The user-facing config knob lives at `romfs/config.json`'s
// `buttonMapping` object. Keys are Switch face / shoulder labels
// (`"A"`, `"B"`, `"X"`, `"Y"`, `"L"`, `"R"`, `"ZL"`, `"ZR"`,
// `"MINUS"`, `"PLUS"`, `"L_STICK"`, `"R_STICK"`, `"UP"`, `"DOWN"`,
// `"LEFT"`, `"RIGHT"`). Values are action strings from the
// `ButtonAction` enum below. An empty string in the config means
// "use the engine default" — the table in `DEFAULT_ACTIONS` then wins.
//
// Face button labelling — labels follow Xbox / Web-Gamepad-action
// convention (south=A, east=B, west=X, north=Y), NOT the physical
// labels printed on a Switch joycon (south=B, east=A, west=Y, north=X).
// The user's `config.json buttonMapping` thinks of the primary
// "click / confirm" button as `"A"` (matching how the rest of the
// world labels primary buttons), and the secondary "back / cancel"
// button as `"B"`. Citron's input mapping follows the same convention,
// so a user pressing their "A" key fires gamepad index 0 and our
// `leftClick="A"` mapping lands on that index. A real-Switch-hardware
// user who wants Nintendo-style labels can flip these two entries
// (or swap `leftClick`/`rightClick` values in their config).

export type SwitchButtonLabel =
	| 'A' | 'B' | 'X' | 'Y'
	| 'L' | 'R' | 'ZL' | 'ZR'
	| 'MINUS' | 'PLUS'
	| 'L_STICK' | 'R_STICK'
	| 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'
	| 'HOME' | 'CAPTURE'
	| 'LEFT_SL' | 'LEFT_SR' | 'RIGHT_SL' | 'RIGHT_SR';

export type ButtonAction =
	| ''            // unbound
	| 'leftClick'   // mouse: primary click
	| 'rightClick'  // mouse: secondary click (browser context menu)
	| 'middleClick' // mouse: middle click
	| 'back'        // shell: navigate back
	| 'forward'     // shell: navigate forward
	| 'reload'      // shell: reload current page
	| 'home'        // shell: navigate to home URL
	| 'addressBar'  // shell: open URL bar
	| 'settings'    // shell: open settings page
	| 'bookmark'    // shell: toggle bookmark for current page
	| 'screenshot'  // shell: capture PNG screenshot
	| 'scrollUp'    // shell: scroll content up one D-pad step
	| 'scrollDown'  // shell: scroll content down one D-pad step
	| 'scrollLeft'  // (reserved — not yet implemented)
	| 'scrollRight' // (reserved — not yet implemented)
	| 'exit';       // shell: quit the app

/**
 * Switch face/shoulder label → Web Gamepad standard-layout index. Must
 * match `gamepad.c standard_button_masks` in nxjs (the source of truth).
 */
const BUTTON_INDEX_MAP: Record<SwitchButtonLabel, number> = {
	// Face buttons. Web Gamepad standard: 0 = south, 1 = east,
	// 2 = west, 3 = north. Labels follow Xbox / action-faithful
	// convention (south = "A" = primary, east = "B" = secondary), not
	// the physical labels on a Switch joycon. See header comment above
	// for the why.
	A: 0,
	B: 1,
	X: 2,
	Y: 3,
	// Shoulders + triggers.
	L: 4,
	R: 5,
	ZL: 6,
	ZR: 7,
	// System.
	MINUS: 8,
	PLUS: 9,
	// Stick clicks.
	L_STICK: 10,
	R_STICK: 11,
	// D-pad.
	UP: 12,
	DOWN: 13,
	LEFT: 14,
	RIGHT: 15,
	// Sideways / single-joycon SL/SR. Live in nxjs's
	// `standard_button_masks` at indices 16-19 — delivered through
	// the normal padGetButtons path.
	LEFT_SL: 16,
	LEFT_SR: 17,
	RIGHT_SL: 18,
	RIGHT_SR: 19,
	// Capture button. Delivered via libnx's applet message system
	// (`AppletHookType_OnCaptureButtonShortPressed`) — nxjs's
	// gamepad.c reads a transient flag set by the applet hook and
	// exposes it through buttons[20].pressed.
	CAPTURE: 20,
	// HOME button. Exposed for completeness but currently inert: on
	// hbmenu-loaded NRO apps the HOME button is intercepted by the
	// loader before our applet hook would run, so this button always
	// reads as released. Mapping to HOME is therefore a no-op until
	// nxjs grows a `hidsysAcquireHomeButtonEventHandle`-based wiring.
	HOME: 21,
};

/**
 * Engine defaults. Used when `config.json buttonMapping.X` is an empty
 * string (or missing). The user-confirmed mappings from the cursor
 * wiring round (A=left, B=right, ZR=middle) are kept; everything else
 * preserves the prior shell shortcuts that aren't taken by mouse
 * actions.
 */
const DEFAULT_ACTIONS: Partial<Record<SwitchButtonLabel, ButtonAction>> = {
	A: 'leftClick',
	B: 'rightClick',
	X: 'forward',
	Y: 'reload',
	// L and R inherit the shell-side actions that used to live on
	// Switch's A (back) and ZR (addressBar) — those buttons are now
	// taken by the mouse layer, so we relocate the navigation
	// shortcuts to the shoulder buttons. Users can remap in
	// config.json.
	L: 'back',
	R: 'addressBar',
	ZR: 'middleClick',
	MINUS: 'screenshot',
	UP: 'scrollUp',
	DOWN: 'scrollDown',
	// ZL, PLUS, L_STICK, R_STICK, LEFT, RIGHT — unbound by default.
};

const ALL_LABELS: SwitchButtonLabel[] = [
	'A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR',
	'MINUS', 'PLUS', 'L_STICK', 'R_STICK',
	'UP', 'DOWN', 'LEFT', 'RIGHT',
	'HOME', 'CAPTURE',
	'LEFT_SL', 'LEFT_SR', 'RIGHT_SL', 'RIGHT_SR',
];

// Active mapping. Defaults applied on module load; replaced by
// `setButtonMapping` once the shell has loaded config.json.
const mapping: Record<SwitchButtonLabel, ButtonAction> = (() => {
	const m: Record<SwitchButtonLabel, ButtonAction> = {} as Record<SwitchButtonLabel, ButtonAction>;
	for (const label of ALL_LABELS) m[label] = DEFAULT_ACTIONS[label] ?? '';
	return m;
})();

/** Reverse index for quick "which physical button serves action X?" lookups. */
const actionToLabel = new Map<ButtonAction, SwitchButtonLabel>();
function rebuildActionToLabelIndex(): void {
	actionToLabel.clear();
	for (const label of ALL_LABELS) {
		const action = mapping[label];
		if (action && !actionToLabel.has(action)) {
			actionToLabel.set(action, label);
		}
	}
}
rebuildActionToLabelIndex();

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
export function setButtonMapping(userMapping: Record<string, unknown> | null | undefined): void {
	for (const label of ALL_LABELS) {
		mapping[label] = DEFAULT_ACTIONS[label] ?? '';
	}
	if (userMapping && typeof userMapping === 'object') {
		applyActionKeyed(userMapping);
	}
	rebuildActionToLabelIndex();
	console.debug('[button-router] mapping=' + JSON.stringify(mapping));
}

function applyActionKeyed(userMapping: Record<string, unknown>): void {
	// Build a reverse map (action → default-LABEL) so empty values
	// in the user's config fall back to the engine default for that
	// action without recomputing per entry.
	const defaultLabelForAction = new Map<ButtonAction, SwitchButtonLabel>();
	for (const label of ALL_LABELS) {
		const action = DEFAULT_ACTIONS[label];
		if (action && !defaultLabelForAction.has(action)) {
			defaultLabelForAction.set(action, label);
		}
	}
	for (const key of Object.keys(userMapping)) {
		if (!isValidAction(key)) continue;
		const action = key as ButtonAction;
		if (action === '') continue;
		const raw = userMapping[key];
		if (typeof raw !== 'string') continue;
		let label: SwitchButtonLabel;
		if (raw === '') {
			// Empty value → use the engine default for this action.
			const defLabel = defaultLabelForAction.get(action);
			if (!defLabel) continue; // action has no default → leave unbound
			label = defLabel;
		} else {
			const candidate = raw.toUpperCase().replace(/[\s-]/g, '_') as SwitchButtonLabel;
			if (!(candidate in BUTTON_INDEX_MAP)) continue;
			label = candidate;
		}
		// Clear any other label currently bound to this action so we
		// don't end up with two buttons firing the same action.
		for (const l of ALL_LABELS) {
			if (mapping[l] === action) mapping[l] = '';
		}
		mapping[label] = action;
	}
}

const VALID_ACTIONS: ReadonlySet<ButtonAction> = new Set<ButtonAction>([
	'', 'leftClick', 'rightClick', 'middleClick',
	'back', 'forward', 'reload', 'home', 'addressBar', 'settings',
	'bookmark', 'screenshot',
	'scrollUp', 'scrollDown', 'scrollLeft', 'scrollRight',
	'exit',
]);
function isValidAction(s: string): s is ButtonAction {
	return VALID_ACTIONS.has(s as ButtonAction);
}

/** What action is currently assigned to a Switch button? */
export function getActionForButton(label: SwitchButtonLabel): ButtonAction {
	return mapping[label] ?? '';
}

/** What Web Gamepad standard-layout index does this Switch label use?
 * Returns -1 for labels nxjs doesn't expose. */
export function getButtonIndexForLabel(label: SwitchButtonLabel): number {
	return BUTTON_INDEX_MAP[label] ?? -1;
}

/** Reverse lookup: which gamepad index currently serves the given
 * action? Returns -1 when no button is bound to that action. Used by
 * the mouse forwarder to poll the right indices for leftClick /
 * rightClick / middleClick regardless of how the user has mapped them. */
export function getButtonIndexForAction(action: ButtonAction): number {
	const label = actionToLabel.get(action);
	if (!label) return -1;
	return BUTTON_INDEX_MAP[label] ?? -1;
}

/** Did the user map any button to a "mouse"-class action? Used by the
 * mouse forwarder to short-circuit polling when nothing is bound. */
export function hasAnyMouseBinding(): boolean {
	return actionToLabel.has('leftClick')
		|| actionToLabel.has('rightClick')
		|| actionToLabel.has('middleClick');
}

/** Enumerate the active mapping. Useful for diagnostic logging or for
 * the shell to drive its rising-edge dispatch by iterating once over
 * a single table instead of N hardcoded checks. */
export function listMappedButtons(): { label: SwitchButtonLabel; idx: number; action: ButtonAction }[] {
	const out: { label: SwitchButtonLabel; idx: number; action: ButtonAction }[] = [];
	for (const label of ALL_LABELS) {
		const action = mapping[label];
		if (!action) continue;
		const idx = BUTTON_INDEX_MAP[label];
		if (idx < 0) continue;
		out.push({ label, idx, action });
	}
	return out;
}
