import {
	getInputChecked,
	getInputValue,
	getLiveRoot,
	type LiveElement,
} from '@switch-web/runtime';

/**
 * Walk the live root collecting every `[data-setting="<key>"]` widget
 * and return the staged value per key, clamped + coerced to match
 * `loadConfig`'s parser. Radios with the same key collapse to the
 * single checked one's value; unknown keys are dropped. Numeric
 * out-of-range inputs are clamped (not rejected) so a type-in like
 * `9999` in `wwwRenderChunkMs` saves as `1000`.
 */
export function readStagedSettings(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const visit = (el: LiveElement): void => {
		const key = el.getAttribute('data-setting');
		if (key) captureStaged(out, key, el);
		for (const c of el.children) visit(c);
	};
	visit(getLiveRoot());
	return out;
}

/** Inspect a single `[data-setting]` widget and record its staged
 * value into `out`. Extracted from {@link readStagedSettings} so unit
 * tests can drive it without building a fake live root. */
export function captureStaged(out: Record<string, unknown>, key: string, el: LiveElement): void {
	const tag = el.tagName;
	const type = (el.getAttribute('type') ?? '').toLowerCase();
	// Radio groups: only the checked one contributes. An
	// already-recorded value for the same key (from an earlier
	// sibling radio) wins, so the first checked radio in document
	// order is the staged choice.
	if (tag === 'INPUT' && type === 'radio') {
		if (getInputChecked(el) && !(key in out)) out[key] = getInputValue(el);
		return;
	}
	if (tag === 'INPUT' && type === 'checkbox') {
		out[key] = getInputChecked(el);
		return;
	}
	// Numeric inputs: parse + clamp to the same bounds loadConfig
	// uses, so the on-disk value is always valid even if the user
	// type-ins something outside the range.
	if (tag === 'INPUT' && type === 'number') {
		const raw = parseFloat(getInputValue(el));
		if (!Number.isFinite(raw)) return;
		const min = parseFloat(el.getAttribute('min') ?? '');
		const max = parseFloat(el.getAttribute('max') ?? '');
		let v = raw;
		if (Number.isFinite(min)) v = Math.max(min, v);
		if (Number.isFinite(max)) v = Math.min(max, v);
		// maxHistory in particular must be an integer; trunc when
		// the field exposes an integer-shaped range (min/max both
		// integers and no step="0.xxx" overriding the default 1).
		if (Number.isInteger(min) && Number.isInteger(max)) v = Math.trunc(v);
		out[key] = v;
		return;
	}
	// <select> + plain text inputs: pass the raw string through.
	out[key] = getInputValue(el);
}

/** True when the Settings page's `[data-action="save-settings"]`
 * widget is currently disabled. Settings.html's inline diff script
 * toggles the `disabled` attribute when there are no staged edits,
 * but `findTapIntent` dispatches actions regardless of disabled
 * state — so the shell guards the actual save here to avoid an
 * unnecessary config.json rewrite. */
export function isSaveButtonDisabled(): boolean {
	const find = (el: LiveElement): LiveElement | null => {
		if (el.getAttribute('data-action') === 'save-settings') return el;
		for (const c of el.children) {
			const found = find(c);
			if (found) return found;
		}
		return null;
	};
	const btn = find(getLiveRoot());
	return !!btn && btn.hasAttribute('disabled');
}
