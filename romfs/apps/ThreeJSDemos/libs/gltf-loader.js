// Minimal Three.js r162 GLTFLoader port for switch-web-browser.
//
// Scope: enough of the glTF 2.0 spec to load DamagedHelmet (P1b) plus
// rigged + animated models like Soldier.glb (P26 — milestone #26).
// Specifically supports:
//
//   - External `.bin` buffers (uri-referenced)
//   - Standard accessor types: SCALAR / VEC2 / VEC3 / VEC4 (+ MAT2/3/4 size)
//   - Component types: BYTE, UNSIGNED_BYTE, SHORT, UNSIGNED_SHORT,
//     UNSIGNED_INT, FLOAT
//   - Standard primitive attributes: POSITION, NORMAL, TANGENT,
//     TEXCOORD_0/1, COLOR_0, JOINTS_0, WEIGHTS_0
//   - Indexed primitives (TRIANGLES; mode 4)
//   - Materials: MeshStandardMaterial with all standard PBR channels
//     (baseColor + metallicRoughness + normal + occlusion + emissive)
//   - Textures via Image+OffscreenCanvas+DataTexture (sdmc:// path; the
//     standard per-demo deviation — nx.js's Image bypasses fetch and
//     rejects brewser:// per [[nxjs-image-bypasses-global-fetch]])
//   - Node transforms (matrix or TRS)
//   - Scene composition (single scene; uses default scene)
//   - **Skins**: joints array + inverseBindMatrices → THREE.Skeleton;
//     primitives with JOINTS_0+WEIGHTS_0 attributes become SkinnedMesh
//     bound to the skin's skeleton ([[swb-threejs-webgl-animation-skinning-blending]])
//   - **Animations**: channels + samplers → AnimationClip with
//     VectorKeyframeTrack / QuaternionKeyframeTrack / NumberKeyframeTrack
//
// Does NOT (yet) support:
//   - GLB binary container (offline-pre-extract via Node script instead)
//   - Embedded base64 buffers / images
//   - Morph target animations (path === 'weights')
//   - Sparse accessors
//   - Cameras / lights in glTF nodes
//   - CUBICSPLINE interpolation (falls back to LINEAR — close enough)
//   - KHR_* extensions (silently ignored; base material params used)
//
// Usage:
//   const loader = new THREE.GLTFLoader();
//   loader.setPath('brewser://apps/ThreeJSDemos/foo/assets/');
//   loader.setSdmcImagePath('sdmc:/.../foo/assets/');
//   loader.load('foo.gltf', (gltf) => {
//       scene.add(gltf.scene);
//       const mixer = new THREE.AnimationMixer(gltf.scene);
//       mixer.clipAction(gltf.animations[0]).play();
//   });

(function () {
	// Prefer r184 (latest) if loaded; fall back to r162 baseline. WebGL 2
	// demos run on r184 to avoid the r162-cap-only path; classic WebGL 1
	// demos stay on r162.
	const THREE = globalThis.__THREE_R184_STAGED__ ||
	              globalThis.__THREE_R162_STAGED__;
	if (!THREE) return;

	const COMPONENT_TYPES = {
		5120: Int8Array,
		5121: Uint8Array,
		5122: Int16Array,
		5123: Uint16Array,
		5125: Uint32Array,
		5126: Float32Array,
	};

	const TYPE_NUM_COMPONENTS = {
		SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4,
		MAT2: 4, MAT3: 9, MAT4: 16,
	};

	const ATTRIB_MAP = {
		POSITION: 'position',
		NORMAL: 'normal',
		TANGENT: 'tangent',
		TEXCOORD_0: 'uv',
		TEXCOORD_1: 'uv1',
		COLOR_0: 'color',
		JOINTS_0: 'skinIndex',
		WEIGHTS_0: 'skinWeight',
	};

	const SKIN_ATTRS = new Set(['JOINTS_0', 'WEIGHTS_0']);

	const PATH_TO_PROPERTY = {
		translation: 'position',
		rotation: 'quaternion',
		scale: 'scale',
		weights: 'morphTargetInfluences',
	};

	function loadImageAsDataTexture(srcUrl, opts) {
		opts = opts || {};
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				try {
					const off = new OffscreenCanvas(img.width, img.height);
					const ctx = off.getContext('2d');
					ctx.drawImage(img, 0, 0);
					const id = ctx.getImageData(0, 0, img.width, img.height);
					const tex = new THREE.DataTexture(
						new Uint8Array(id.data.buffer),
						img.width, img.height,
						THREE.RGBAFormat, THREE.UnsignedByteType,
					);
					tex.colorSpace = opts.colorSpace || THREE.NoColorSpace;
					tex.flipY = false;
					tex.wrapS = opts.wrapS || THREE.RepeatWrapping;
					tex.wrapT = opts.wrapT || THREE.RepeatWrapping;
					tex.minFilter = opts.minFilter || THREE.LinearMipmapLinearFilter;
					tex.magFilter = opts.magFilter || THREE.LinearFilter;
					tex.generateMipmaps = true;
					tex.needsUpdate = true;
					resolve(tex);
				} catch (e) { reject(e); }
			};
			img.onerror = () => reject(new Error('image load failed: ' + srcUrl));
			img.src = srcUrl;
		});
	}

	const COMPONENT_DV_READ = {
		5120: 'getInt8',
		5121: 'getUint8',
		5122: 'getInt16',
		5123: 'getUint16',
		5125: 'getUint32',
		5126: 'getFloat32',
	};

	function accessorTypedArray(json, accessorIndex, buffers, bufferViews) {
		const acc = json.accessors[accessorIndex];
		const bv = bufferViews[acc.bufferView];
		const ArrayType = COMPONENT_TYPES[acc.componentType];
		const numComponents = TYPE_NUM_COMPONENTS[acc.type];
		const bytesPerElement = ArrayType.BYTES_PER_ELEMENT;
		const itemBytes = numComponents * bytesPerElement;
		const stride = bv.byteStride || itemBytes;
		const baseOffset = (acc.byteOffset || 0) + bv.byteOffset;
		// Fast path: tightly packed (e.g. POSITION in a bufferView whose
		// byteLength == count × itemBytes).
		if (stride === itemBytes) {
			return new ArrayType(buffers[bv.buffer], baseOffset, acc.count * numComponents);
		}
		// Interleaved path: bufferView packs multiple attributes (e.g.
		// JOINTS_0 + WEIGHTS_0 with stride=32, offsets 0 and 16). The naive
		// flat-typed-array view would mis-read padding bytes as data and
		// produce garbage joint indices — see Soldier.glb's mesh 0 where
		// JOINTS_0 max value spiked to 255 from the misalignment.
		// De-interleave into a tight array via DataView reads.
		const dv = new DataView(buffers[bv.buffer], baseOffset, stride * (acc.count - 1) + itemBytes);
		const out = new ArrayType(acc.count * numComponents);
		const readMethod = COMPONENT_DV_READ[acc.componentType];
		for (let v = 0; v < acc.count; v++) {
			const srcRowOff = v * stride;
			const dstRowOff = v * numComponents;
			for (let c = 0; c < numComponents; c++) {
				out[dstRowOff + c] = dv[readMethod](srcRowOff + c * bytesPerElement, true);
			}
		}
		return out;
	}

	function makeBufferAttribute(json, accessorIndex, buffers, bufferViews) {
		const acc = json.accessors[accessorIndex];
		const numComponents = TYPE_NUM_COMPONENTS[acc.type];
		const data = accessorTypedArray(json, accessorIndex, buffers, bufferViews);
		return new THREE.BufferAttribute(data, numComponents, acc.normalized || false);
	}

	function buildNodeTree(json, idx, nodes) {
		const obj = nodes[idx];
		const nj = json.nodes[idx];
		if (nj.children) {
			for (const ci of nj.children) {
				obj.add(buildNodeTree(json, ci, nodes));
			}
		}
		return obj;
	}

	function buildAnimationClip(anim, json, buffers, bufferViews, nodes) {
		const tracks = [];
		for (const channel of anim.channels) {
			const target = channel.target;
			if (target.node === undefined) continue;
			const targetNode = nodes[target.node];
			if (!targetNode || !targetNode.name) continue;
			const sampler = anim.samplers[channel.sampler];
			const timesArr = accessorTypedArray(json, sampler.input, buffers, bufferViews);
			const valuesArr = accessorTypedArray(json, sampler.output, buffers, bufferViews);
			const property = PATH_TO_PROPERTY[target.path];
			if (!property) continue;
			const trackName = targetNode.name + '.' + property;
			// Most gltf samplers are LINEAR. CUBICSPLINE encoding interleaves
			// 3× values (in/value/out tangents); for simplicity we treat it
			// as LINEAR which produces a smoother-than-step result. Sufficient
			// for the Soldier demo.
			const interp = THREE.InterpolateLinear;
			let TrackType;
			if (target.path === 'rotation') {
				TrackType = THREE.QuaternionKeyframeTrack;
			} else if (target.path === 'weights') {
				TrackType = THREE.NumberKeyframeTrack;
			} else {
				TrackType = THREE.VectorKeyframeTrack;
			}
			try {
				tracks.push(new TrackType(
					trackName, Array.from(timesArr), Array.from(valuesArr), interp,
				));
			} catch (e) {
				// Skip malformed tracks rather than aborting the whole clip
				// (e.g., a target node whose name didn't resolve).
			}
		}
		return new THREE.AnimationClip(anim.name || 'clip', -1, tracks);
	}

	class GLTFLoader {
		constructor() {
			this.path = '';
			this.sdmcImagePath = null;
			// Optional: when set, load the .gltf JSON and external .bin
			// buffers via `Switch.readFile` from this sdmc:/ prefix
			// instead of `globalThis.fetch(brewser://...)`. Required for
			// r184 demos to dodge [[r184-fetch-hang]] — loading the r184
			// IIFE breaks all subsequent brewser:// fetches.
			this.sdmcModelPath = null;
		}
		setPath(p) { this.path = p; return this; }
		setSdmcImagePath(p) { this.sdmcImagePath = p; return this; }
		setSdmcModelPath(p) { this.sdmcModelPath = p; return this; }
		load(url, onLoad, onProgress, onError) {
			if (this.sdmcModelPath) {
				// Switch.readFile path (no fetch).
				const sdmcUrl = this.sdmcModelPath + url;
				Switch.readFile(sdmcUrl).then((buf) => {
					const text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
					const json = JSON.parse(text);
					return this.parse(json, this.path, onLoad, onError);
				}).catch((e) => { if (onError) onError(e); });
				return;
			}
			const fullUrl = this.path + url;
			fetch(fullUrl)
				.then((r) => {
					if (!r.ok) throw new Error('fetch ' + fullUrl + ': ' + r.status);
					return r.json();
				})
				.then((json) => this.parse(json, this.path, onLoad, onError))
				.catch((e) => { if (onError) onError(e); });
		}
		async parse(json, basePath, onLoad, onError) {
			try {
				const sdmcBase = this.sdmcImagePath || basePath;

				// 1. Load external buffers — Switch.readFile when
				// sdmcModelPath is set ([[r184-fetch-hang]] dodge),
				// else legacy fetch path.
				const buffers = await Promise.all(
					(json.buffers || []).map(async (b) => {
						if (!b.uri) throw new Error('GLTFLoader: embedded buffers not supported (pre-extract GLB offline)');
						if (this.sdmcModelPath) {
							const buf = await Switch.readFile(this.sdmcModelPath + b.uri);
							return buf instanceof ArrayBuffer
								? buf
								: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
						}
						const r = await fetch(basePath + b.uri);
						if (!r.ok) throw new Error('GLTFLoader: buffer fetch failed ' + b.uri);
						return await r.arrayBuffer();
					}),
				);

				// 2. Bufferviews (lightweight wrappers).
				const bufferViews = (json.bufferViews || []).map((bv) => ({
					buffer: bv.buffer,
					byteOffset: bv.byteOffset || 0,
					byteLength: bv.byteLength,
					byteStride: bv.byteStride || 0,
				}));

				// 3. Load images concurrently.
				const imgPromises = (json.images || []).map((im) => {
					if (!im.uri) {
						return Promise.reject(new Error('GLTFLoader: embedded images not supported (pre-extract offline)'));
					}
					return loadImageAsDataTexture(sdmcBase + im.uri);
				});
				const imageTextures = await Promise.all(imgPromises);

				// 4. Textures (per-use clones to allow independent colorSpace).
				const textures = (json.textures || []).map((t) => {
					const baseTex = imageTextures[t.source];
					if (!baseTex) return null;
					const tex = baseTex.clone();
					tex.image = baseTex.image;
					tex.needsUpdate = true;
					if (t.sampler !== undefined && json.samplers) {
						const s = json.samplers[t.sampler];
						if (s.wrapS) tex.wrapS = s.wrapS === 33071 ? THREE.ClampToEdgeWrapping : (s.wrapS === 33648 ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping);
						if (s.wrapT) tex.wrapT = s.wrapT === 33071 ? THREE.ClampToEdgeWrapping : (s.wrapT === 33648 ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping);
					}
					return tex;
				});

				// 5. Materials. Default: MeshStandardMaterial (PBR).
				const materials = (json.materials || []).map((m) => {
					const params = {};
					const pbr = m.pbrMetallicRoughness;
					if (pbr) {
						if (pbr.baseColorFactor) {
							params.color = new THREE.Color(
								pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2],
							);
							if (pbr.baseColorFactor[3] !== undefined && pbr.baseColorFactor[3] < 1) {
								params.opacity = pbr.baseColorFactor[3];
								params.transparent = true;
							}
						}
						if (pbr.metallicFactor !== undefined) params.metalness = pbr.metallicFactor;
						if (pbr.roughnessFactor !== undefined) params.roughness = pbr.roughnessFactor;
						if (pbr.baseColorTexture) {
							const ti = pbr.baseColorTexture.index;
							params.map = textures[ti];
							if (textures[ti]) textures[ti].colorSpace = THREE.SRGBColorSpace;
						}
						if (pbr.metallicRoughnessTexture) {
							const ti = pbr.metallicRoughnessTexture.index;
							params.metalnessMap = textures[ti];
							params.roughnessMap = textures[ti];
						}
					}
					if (m.normalTexture) {
						params.normalMap = textures[m.normalTexture.index];
						if (m.normalTexture.scale !== undefined) {
							params.normalScale = new THREE.Vector2(m.normalTexture.scale, m.normalTexture.scale);
						}
					}
					if (m.occlusionTexture) {
						params.aoMap = textures[m.occlusionTexture.index];
						if (m.occlusionTexture.strength !== undefined) {
							params.aoMapIntensity = m.occlusionTexture.strength;
						}
					}
					if (m.emissiveTexture) {
						params.emissiveMap = textures[m.emissiveTexture.index];
						if (textures[m.emissiveTexture.index]) {
							textures[m.emissiveTexture.index].colorSpace = THREE.SRGBColorSpace;
						}
						if (!m.emissiveFactor) params.emissive = new THREE.Color(0xffffff);
					}
					if (m.emissiveFactor) {
						params.emissive = new THREE.Color(
							m.emissiveFactor[0], m.emissiveFactor[1], m.emissiveFactor[2],
						);
					}
					params.side = m.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
					if (m.alphaMode === 'BLEND') params.transparent = true;
					else if (m.alphaMode === 'MASK') params.alphaTest = m.alphaCutoff !== undefined ? m.alphaCutoff : 0.5;
					if (m.name) params.name = m.name;
					return new THREE.MeshStandardMaterial(params);
				});

				// 6. Identify bone nodes (members of any skin's joints array).
				const boneNodeIndices = new Set();
				for (const skin of (json.skins || [])) {
					for (const j of skin.joints) boneNodeIndices.add(j);
				}

				// 7. Pre-allocate node objects. Bones are THREE.Bone, others
				//    are Object3D (or Group when they own a mesh).
				const nodes = (json.nodes || []).map((nj, idx) => {
					let obj;
					if (boneNodeIndices.has(idx)) {
						obj = new THREE.Bone();
					} else if (nj.mesh !== undefined) {
						obj = new THREE.Group();
					} else {
						obj = new THREE.Object3D();
					}
					// Three.js's AnimationMixer matches tracks by name; give
					// every node a name so untitled bones don't drop their tracks.
					obj.name = nj.name || ('node_' + idx);
					if (nj.matrix) {
						const m = new THREE.Matrix4().fromArray(nj.matrix);
						m.decompose(obj.position, obj.quaternion, obj.scale);
					} else {
						if (nj.translation) obj.position.fromArray(nj.translation);
						if (nj.rotation) obj.quaternion.fromArray(nj.rotation);
						if (nj.scale) obj.scale.fromArray(nj.scale);
					}
					return obj;
				});

				// 8. Build skeletons from skins.
				const skeletons = (json.skins || []).map((sk) => {
					const bones = sk.joints.map(j => nodes[j]);
					let boneInverses = null;
					if (sk.inverseBindMatrices !== undefined) {
						const acc = json.accessors[sk.inverseBindMatrices];
						const bv = bufferViews[acc.bufferView];
						const offset = (acc.byteOffset || 0) + bv.byteOffset;
						const data = new Float32Array(buffers[bv.buffer], offset, acc.count * 16);
						boneInverses = [];
						for (let i = 0; i < acc.count; i++) {
							const m = new THREE.Matrix4().fromArray(data, i * 16);
							boneInverses.push(m);
						}
					}
					return new THREE.Skeleton(bones, boneInverses);
				});

				// 9. Build meshes — array of array (one entry per gltf mesh,
				//    each entry is the list of primitive meshes inside).
				const meshes = (json.meshes || []).map((mj) => {
					const out = [];
					for (const prim of mj.primitives) {
						const geom = new THREE.BufferGeometry();
						let isSkinned = false;
						for (const [glAttr, accIdx] of Object.entries(prim.attributes)) {
							const threeAttr = ATTRIB_MAP[glAttr];
							if (!threeAttr) continue;
							geom.setAttribute(threeAttr, makeBufferAttribute(json, accIdx, buffers, bufferViews));
							if (SKIN_ATTRS.has(glAttr)) isSkinned = true;
						}
						if (prim.indices !== undefined) {
							geom.setIndex(makeBufferAttribute(json, prim.indices, buffers, bufferViews));
						}
						const mat = (prim.material !== undefined) ? materials[prim.material] : new THREE.MeshStandardMaterial();
						const mesh = isSkinned ? new THREE.SkinnedMesh(geom, mat) : new THREE.Mesh(geom, mat);
						if (mj.name) mesh.name = mj.name;
						out.push(mesh);
					}
					return out;
				});

				// 10. Wire meshes onto their owning nodes; DO NOT bind yet —
				//     bones must be in the scene tree first so their matrixWorld
				//     is right when Skeleton initializes.
				const skinnedMeshBindings = []; // [{mesh, skinIdx}]
				for (const [idx, nj] of (json.nodes || []).entries()) {
					if (nj.mesh === undefined) continue;
					const primMeshes = meshes[nj.mesh];
					for (const m of primMeshes) {
						nodes[idx].add(m);
						if (m.isSkinnedMesh && nj.skin !== undefined) {
							skinnedMeshBindings.push({ mesh: m, skinIdx: nj.skin });
						}
					}
				}

				// 11. Parent the scene tree.
				const sceneIdx = json.scene !== undefined ? json.scene : 0;
				const sceneJson = json.scenes && json.scenes[sceneIdx];
				const root = new THREE.Group();
				if (sceneJson && sceneJson.name) root.name = sceneJson.name;
				if (sceneJson && sceneJson.nodes) {
					for (const ni of sceneJson.nodes) {
						root.add(buildNodeTree(json, ni, nodes));
					}
				}

				// 11b. Force matrixWorld update across the whole tree so bones
				//      have valid world transforms when SkinnedMesh.bind() is
				//      called. Then bind each SkinnedMesh with an explicit
				//      identity bindMatrix — matches upstream three-r162
				//      GLTFLoader (uses `_identityMatrix`). Passing a defined
				//      bindMatrix skips Three.js's `skeleton.calculateInverses()`
				//      which would clobber the gltf-provided inverseBindMatrices.
				root.updateMatrixWorld(true);
				const identityBindMatrix = new THREE.Matrix4();
				for (const { mesh, skinIdx } of skinnedMeshBindings) {
					mesh.bind(skeletons[skinIdx], identityBindMatrix);
				}

				// 12. Build animation clips.
				const animations = (json.animations || []).map((anim) =>
					buildAnimationClip(anim, json, buffers, bufferViews, nodes)
				);

				onLoad && onLoad({
					scene: root, scenes: [root], cameras: [],
					animations, asset: json.asset || {},
				});
			} catch (err) {
				if (onError) onError(err);
				else console.warn('GLTFLoader error:', err && err.message || err);
			}
		}
	}

	THREE.GLTFLoader = GLTFLoader;
})();
