// Minimal Three.js r162 RGBELoader port — parses Radiance .hdr files.
//
// Scope: enough to load the `royal_esplanade_1k.hdr` style equirectangular
// HDR images that Three.js's `webgl_loader_gltf` demo uses for IBL.
// Outputs a DataTexture with HalfFloatType (Uint16Array of packed half-
// floats) by default, or FloatType (Float32Array) if requested.
//
// Adapted from upstream `three-r162/examples/jsm/loaders/RGBELoader.js`.
// Differences:
//   - No DataTextureLoader subclass; we wire .load() to fetch() directly.
//   - Uses globalThis.__THREE_R162_STAGED__ for THREE access (IIFE pattern).
//   - Drops the `_parser` indirection: parse() returns the texture directly.
//
// Usage:
//   const loader = new THREE.RGBELoader();
//   loader.setPath('brewser://path/');
//   loader.load('foo.hdr', (texture) => { scene.environment = texture; });

(function () {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) return;

	const RGBE_VALID_FORMAT = 2;
	const RGBE_VALID_DIMENSIONS = 4;

	function rgbeError(msg) { throw new Error('RGBELoader: ' + msg); }

	function fgets(buffer, consume) {
		const NL = 0x0a;
		let p = buffer.pos;
		let start = p;
		while (p < buffer.byteLength && buffer[p] !== NL) p++;
		if (p >= buffer.byteLength) return false;
		const len = p - start;
		// ASCII slice — Radiance headers are pure ASCII
		let s = '';
		for (let i = 0; i < len; i++) s += String.fromCharCode(buffer[start + i]);
		if (consume !== false) buffer.pos = p + 1;
		return s;
	}

	function readHeader(buffer) {
		const magic_token_re = /^#\?(\S+)/;
		const format_re = /^\s*FORMAT=(\S+)\s*$/;
		const dimensions_re = /^\s*\-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/;
		const header = { valid: 0, format: '', programtype: '', width: 0, height: 0 };
		let line;
		let m;
		buffer.pos = 0;
		if (!(line = fgets(buffer))) rgbeError('no header found');
		if (!(m = magic_token_re.exec(line))) rgbeError('bad initial token');
		header.programtype = m[1];
		// Read lines until BOTH FORMAT and DIMENSIONS are seen. Blank lines
		// are NOT terminators — Radiance puts the dimensions line AFTER a
		// blank separator, right before the binary data starts.
		while (true) {
			line = fgets(buffer);
			if (line === false) break;
			if ((m = format_re.exec(line))) {
				header.valid |= RGBE_VALID_FORMAT;
				header.format = m[1];
			}
			if ((m = dimensions_re.exec(line))) {
				header.valid |= RGBE_VALID_DIMENSIONS;
				header.height = parseInt(m[1]);
				header.width = parseInt(m[2]);
			}
			if ((header.valid & RGBE_VALID_FORMAT) &&
			    (header.valid & RGBE_VALID_DIMENSIONS)) break;
		}
		if (!(header.valid & RGBE_VALID_FORMAT)) rgbeError('missing FORMAT');
		if (header.format !== '32-bit_rle_rgbe') rgbeError('unsupported format ' + header.format);
		if (!(header.valid & RGBE_VALID_DIMENSIONS)) rgbeError('missing dimensions');
		return header;
	}

	// Decode RLE-encoded scanlines. The Radiance "new RLE" format is the
	// only one in practice; we don't support old-style. Each scanline:
	//   [0]=0x02, [1]=0x02, [2,3]=width (big-endian)
	// followed by 4 RLE-encoded channels (R, G, B, E).
	function decodeRGBE(buffer, w, h) {
		const out = new Uint8Array(w * h * 4);
		let pos = buffer.pos;
		const scanlineBuf = new Uint8Array(4 * w);
		for (let y = 0; y < h; y++) {
			if (pos + 4 > buffer.byteLength) rgbeError('truncated scanline header');
			const a = buffer[pos], b = buffer[pos + 1];
			const c = buffer[pos + 2], d = buffer[pos + 3];
			if (a !== 0x02 || b !== 0x02 || (c & 0x80) !== 0) {
				rgbeError('non-new-RLE scanline at y=' + y);
			}
			const declaredWidth = (c << 8) | d;
			if (declaredWidth !== w) rgbeError('scanline width mismatch');
			pos += 4;
			// Decode 4 channels RLE-compressed into scanlineBuf laid out
			// as [R0,R1,...,Rw-1, G0,..., B..., E...].
			let chanOffset = 0;
			for (let chan = 0; chan < 4; chan++) {
				let x = 0;
				while (x < w) {
					if (pos >= buffer.byteLength) rgbeError('RLE underflow');
					const count = buffer[pos++];
					if (count > 128) {
						// run of identical bytes
						const n = count - 128;
						if (pos >= buffer.byteLength) rgbeError('RLE run underflow');
						const v = buffer[pos++];
						for (let i = 0; i < n; i++) scanlineBuf[chanOffset + x + i] = v;
						x += n;
					} else {
						// literal bytes
						const n = count;
						if (pos + n > buffer.byteLength) rgbeError('RLE literal underflow');
						for (let i = 0; i < n; i++) scanlineBuf[chanOffset + x + i] = buffer[pos + i];
						pos += n;
						x += n;
					}
				}
				chanOffset += w;
			}
			// Interleave scanlineBuf back to per-pixel RGBE in `out`.
			const rowOff = y * w * 4;
			for (let x = 0; x < w; x++) {
				out[rowOff + x * 4 + 0] = scanlineBuf[x];
				out[rowOff + x * 4 + 1] = scanlineBuf[x + w];
				out[rowOff + x * 4 + 2] = scanlineBuf[x + 2 * w];
				out[rowOff + x * 4 + 3] = scanlineBuf[x + 3 * w];
			}
		}
		buffer.pos = pos;
		return out;
	}

	// Convert RGBE bytes (rgb + shared exponent) → float radiance values.
	function rgbeToFloat(rgbe, idx) {
		const e = rgbe[idx + 3];
		if (e === 0) return [0, 0, 0];
		const scale = Math.pow(2.0, e - 128) / 255.0;
		return [rgbe[idx] * scale, rgbe[idx + 1] * scale, rgbe[idx + 2] * scale];
	}

	class RGBELoader {
		constructor() {
			this.path = '';
			this.type = THREE.HalfFloatType;
		}
		setPath(p) { this.path = p; return this; }
		setType(t) { this.type = t; return this; }
		setDataType(t) { this.type = t; return this; }
		load(url, onLoad, onProgress, onError) {
			const fullUrl = this.path + url;
			fetch(fullUrl)
				.then((r) => {
					if (!r.ok) throw new Error('fetch ' + fullUrl + ': ' + r.status);
					return r.arrayBuffer();
				})
				.then((buf) => {
					try {
						const tex = this.parse(buf);
						onLoad && onLoad(tex);
					} catch (e) { onError && onError(e); }
				})
				.catch((e) => { if (onError) onError(e); });
		}
		parse(arrayBuffer) {
			const buffer = new Uint8Array(arrayBuffer);
			buffer.pos = 0;
			const header = readHeader(buffer);
			const w = header.width;
			const h = header.height;
			const rgbe = decodeRGBE(buffer, w, h);

			// Convert to half-float or float.
			let data;
			let textureType = this.type;
			if (textureType === THREE.HalfFloatType) {
				data = new Uint16Array(w * h * 4);
				const toHalf = THREE.DataUtils && THREE.DataUtils.toHalfFloat;
				if (typeof toHalf !== 'function') throw new Error('DataUtils.toHalfFloat missing');
				for (let i = 0; i < w * h; i++) {
					const e = rgbe[i * 4 + 3];
					if (e === 0) {
						data[i * 4 + 0] = 0;
						data[i * 4 + 1] = 0;
						data[i * 4 + 2] = 0;
						data[i * 4 + 3] = toHalf(1.0);
					} else {
						const s = Math.pow(2.0, e - 128) / 255.0;
						data[i * 4 + 0] = toHalf(rgbe[i * 4 + 0] * s);
						data[i * 4 + 1] = toHalf(rgbe[i * 4 + 1] * s);
						data[i * 4 + 2] = toHalf(rgbe[i * 4 + 2] * s);
						data[i * 4 + 3] = toHalf(1.0);
					}
				}
			} else {
				// FloatType
				data = new Float32Array(w * h * 4);
				for (let i = 0; i < w * h; i++) {
					const e = rgbe[i * 4 + 3];
					if (e === 0) {
						data[i * 4 + 3] = 1.0;
					} else {
						const s = Math.pow(2.0, e - 128) / 255.0;
						data[i * 4 + 0] = rgbe[i * 4 + 0] * s;
						data[i * 4 + 1] = rgbe[i * 4 + 1] * s;
						data[i * 4 + 2] = rgbe[i * 4 + 2] * s;
						data[i * 4 + 3] = 1.0;
					}
				}
				textureType = THREE.FloatType;
			}

			const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, textureType);
			tex.colorSpace = THREE.LinearSRGBColorSpace;
			tex.magFilter = THREE.LinearFilter;
			tex.minFilter = THREE.LinearFilter;
			tex.flipY = true;
			tex.generateMipmaps = false;
			tex.needsUpdate = true;
			return tex;
		}
	}

	THREE.RGBELoader = RGBELoader;
})();
