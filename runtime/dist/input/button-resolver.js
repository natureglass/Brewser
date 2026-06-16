// Page-input modules in the runtime need a way to look up which
// gamepad button index corresponds to a logical action like
// 'leftClick' / 'rightClick' / 'middleClick'. The shell owns the
// user-configurable mapping (`romfs/config.json buttonMapping`) plus
// the resolution logic in `button-router.ts`. To avoid the runtime
// depending on shell internals, the runtime exposes this resolver
// injection point: the shell calls `setButtonIndexResolver` once at
// boot, and runtime code calls `getButtonIndexForAction` whenever it
// needs to translate an action name to a gamepad button index.
//
// Until a resolver is registered, every lookup returns -1 (no
// binding). That is a safe default — runtime code that polls a
// button at index -1 will just see "not pressed".
//
// Phase 3 will fold this into the action enum / event bus refactor;
// this minimal seam exists so the page-mouse-forwarder can move into
// the runtime without coupling to the shell's button-router file.
let resolver = () => -1;
export function setButtonIndexResolver(fn) {
    resolver = fn;
}
export function getButtonIndexForAction(action) {
    return resolver(action);
}
//# sourceMappingURL=button-resolver.js.map