// Test-only shim: lets the exclusion test bundle src/forwarder/generate.ts
// without pulling the full @switch-web/runtime (which installs globals at import
// and won't load under Node). generate.ts only imports `{ pack }`, so this
// re-exports exactly that namespace from the platform-agnostic pack source.
export * as pack from '../../../brewser-runtime/src/pack/index.ts';
