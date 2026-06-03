// r184-nxjs-bridge.js — shims that make Three.js r184 IIFE work on nx.js.
//
// Three issues need bridging before any r184 demo can render. Load this
// script BEFORE three-latest.iife.js so the heartbeat starts as early
// as possible.
//
// ──── 1. r184 instanceof WebGLRenderingContext throw ───────────────────
// `THREE.WebGLRenderer` throws "WebGL 1 is not supported since r163."
// whenever `context instanceof WebGLRenderingContext` is truthy. On
// nx.js there is exactly ONE WebGL class — WebGLRenderingContext — and
// the WebGL 2 context inherits from it, so a perfectly-valid `webgl2`
// context still trips the check. r184 references the symbol nowhere
// else, so we temporarily undefine the global for the duration of
// `new THREE.WebGLRenderer(...)` via `bypassWebGL1Check(fn)`.
//
// ──── 2. nx.js Image events suppressed under r184 ──────────────────────
// `new Image()`'s `onload` / `onerror` events never fire after the
// r184 IIFE has loaded — the pixels DO arrive (img.complete becomes
// true, img.naturalWidth > 0), but the event-dispatch mechanism stays
// silent. `loadImageBypass(url)` does the Image setup AND polls for
// completion via setInterval, returning a Promise that resolves once
// pixels are ready. Decoded RGBA bytes come back in the resolved value
// so callers can build a DataTexture without another OffscreenCanvas
// dance.
//
// ──── 3. Page event loop stalls without rAF queued ────────────────────
// Under r184, nx.js's JS event loop appears to only tick when
// requestAnimationFrame has a pending callback. setTimeout /
// setInterval queued before any rAF is alive never fire — including
// the very poll loop from issue #2. We start a no-op rAF heartbeat at
// load time so timers from issues #2 + status canvas refresh + any
// other delay-based code can actually fire from the first frame.
//
// Usage:
//   <script src="brewser://apps/ThreeJSDemos/libs/r184-nxjs-bridge.js"></script>
//   <script src="brewser://apps/ThreeJSDemos/libs/three-latest.iife.js"></script>
//   <script>
//     // ... inside async run() ...
//     const img = await loadImageBypass(
//       'sdmc:/.../assets/crate.png');
//     const tex = new THREE.DataTexture(
//       img.pixels, img.width, img.height,
//       THREE.RGBAFormat, THREE.UnsignedByteType);
//     tex.colorSpace = THREE.SRGBColorSpace;
//     tex.needsUpdate = true;
//     // ...
//     bypassWebGL1Check(() => {
//       renderer = new THREE.WebGLRenderer({ canvas, context, ... });
//     });
//   </script>

(function () {

	// ──── Issue 3: rAF heartbeat ──────────────────────────────────────
	globalThis.__r184Heartbeat = 0;
	(function heartbeat() {
		globalThis.__r184Heartbeat = ( globalThis.__r184Heartbeat | 0 ) + 1;
		requestAnimationFrame( heartbeat );
	})();

	// ──── Issue 2: Image load bypass ─────────────────────────────────
	// Returns Promise<{ width, height, pixels, image }>.
	// `pixels` is a Uint8Array of RGBA bytes ready to feed into a
	// DataTexture. `image` is the underlying HTMLImageElement for
	// callers that want it (e.g. setBackground with a stretched
	// CanvasTexture).
	globalThis.loadImageBypass = function ( url, opts ) {
		opts = opts || {};
		const timeoutMs = opts.timeoutMs || 30000;
		const pollIntervalMs = opts.pollIntervalMs || 100;
		return new Promise( ( resolve, reject ) => {
			let settled = false;
			const img = new Image();

			function finishResolve() {
				try {
					const w = img.naturalWidth || img.width;
					const h = img.naturalHeight || img.height;
					if ( ! w || ! h ) throw new Error( 'image has zero dimensions: ' + url );
					const off = new OffscreenCanvas( w, h );
					const oc = off.getContext( '2d' );
					oc.drawImage( img, 0, 0 );
					const pixels = new Uint8Array(
						oc.getImageData( 0, 0, w, h ).data.buffer );
					resolve( { width: w, height: h, pixels: pixels, image: img } );
				} catch ( e ) {
					reject( e );
				}
			}

			img.onload = () => {
				if ( settled ) return;
				settled = true;
				finishResolve();
			};
			img.onerror = ( e ) => {
				if ( settled ) return;
				settled = true;
				reject( new Error( 'image onerror: ' + url +
					( e && e.message ? ' (' + e.message + ')' : '' ) ) );
			};
			img.src = url;

			// Poll fallback (Issue 2). Fires only when settled is still
			// false — onload/onerror set settled first if they happen
			// to fire.
			const maxPolls = Math.ceil( timeoutMs / pollIntervalMs );
			let polls = 0;
			const ih = setInterval( () => {
				polls ++;
				if ( settled ) { clearInterval( ih ); return; }
				const w = img.naturalWidth || img.width || 0;
				if ( img.complete && w > 0 ) {
					clearInterval( ih );
					settled = true;
					finishResolve();
					return;
				}
				if ( polls >= maxPolls ) {
					clearInterval( ih );
					if ( ! settled ) {
						settled = true;
						reject( new Error( 'image load timeout (' +
							timeoutMs + 'ms): ' + url ) );
					}
				}
			}, pollIntervalMs );
		} );
	};

	// ──── Issue 1: WebGLRenderingContext instanceof bypass ────────────
	// Run `fn` with globalThis.WebGLRenderingContext temporarily
	// undefined. r184's WebGLRenderer ctor checks
	// `typeof WebGLRenderingContext !== 'undefined' && context
	// instanceof WebGLRenderingContext` and throws if true — undefining
	// the global makes the first clause false so the throw doesn't
	// fire. Restored in a finally block so any later code that needed
	// the symbol still sees it.
	globalThis.bypassWebGL1Check = function ( fn ) {
		const _save = globalThis.WebGLRenderingContext;
		globalThis.WebGLRenderingContext = undefined;
		try {
			return fn();
		} finally {
			globalThis.WebGLRenderingContext = _save;
		}
	};

})();
