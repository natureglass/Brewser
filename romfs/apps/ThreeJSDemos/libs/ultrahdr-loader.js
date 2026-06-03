// Port of three-latest's UltraHDRLoader.js for the nx.js + r184 stack
// (switch-web-browser threejs-demos). Mirrors the upstream parse logic
// (JPEG segment scan, XMP / ISO 21496-1 metadata, MPF section, HDR
// recovery formula) verbatim. Two adaptations:
//
//   1. XMP metadata parsed via regex instead of DOMParser. nx.js
//      doesn't expose a global DOMParser. The gainmap descriptor is a
//      flat <rdf:Description hdrgm:Foo="..." ... /> element so regex
//      extraction is sufficient.
//   2. JPEG decode uses createImageBitmap(Blob) — nx.js exposes that
//      natively via $.imageDecode. ctx canvases come from
//      OffscreenCanvas instead of document.createElement('canvas').
//   3. File loading uses Switch.readFile(sdmcPath + url) instead of
//      Three.js's FileLoader. Required because loading the r184 IIFE
//      breaks brewser:// fetch ([[r184-fetch-hang]]).
//
// Usage:
//   const loader = new THREE.UltraHDRLoader();
//   loader.setSdmcPath('sdmc:/.../assets/');
//   loader.load('royal_esplanade_2k.hdr.jpg', (texture, texData) => {
//       texture.mapping = THREE.EquirectangularReflectionMapping;
//       scene.background = texture;
//       scene.environment = texture;
//   });

(function () {
  const THREE = globalThis.__THREE_R184_STAGED__ ||
                globalThis.__THREE_R162_STAGED__;
  if (!THREE) return;

  const log = (s, e) => {
    try { (globalThis.__crashLog || (() => {}))('[hdr] ' + s, e); } catch (_) {}
  };

  const SRGB_TO_LINEAR = new Float64Array(1024);
  for (let i = 0; i < 1024; i++) {
    SRGB_TO_LINEAR[i] = Math.pow(i * 0.003717127 + 0.0521327014, 2.4);
  }

  function srgbToLinear(value) {
    if (value < 10.31475) return value * 0.000303527;
    if (value < 1024) return SRGB_TO_LINEAR[value | 0];
    return Math.pow(value * 0.003717127 + 0.0521327014, 2.4);
  }

  // Regex-based XMP gainmap-descriptor parser. Upstream uses DOMParser
  // to walk the rdf:Description; our asset class is flat — every field
  // lives as an attribute on the gainmap descriptor's single
  // rdf:Description element. The container descriptor is identified by
  // the presence of a <Container:Directory> child and skipped.
  function parseXMPMetadata(xmpDataString, metadata) {
    if (xmpDataString.indexOf('Container:Directory') !== -1) return;
    function attr(name, defaultStr) {
      const m = xmpDataString.match(
        new RegExp('hdrgm:' + name + '\\s*=\\s*"([^"]*)"')
      );
      return m ? m[1] : defaultStr;
    }
    metadata.version = attr('Version', '1.0');
    metadata.baseRenditionIsHDR = attr('BaseRenditionIsHDR', 'False') === 'True';
    metadata.gainMapMin = parseFloat(attr('GainMapMin', '0'));
    metadata.gainMapMax = parseFloat(attr('GainMapMax', '1'));
    metadata.gamma = parseFloat(attr('Gamma', '1'));
    // Upstream encodes these as `parseFloat(node.getAttribute(...) / (1/64))`.
    // The string-divide-then-parseFloat behaviour ports as: parse to
    // number first, divide by 1/64, then parseFloat — which is just
    // multiplying by 64.
    metadata.offsetSDR = parseFloat(attr('OffsetSDR', '0')) / (1 / 64);
    metadata.offsetHDR = parseFloat(attr('OffsetHDR', '0')) / (1 / 64);
    metadata.hdrCapacityMin = parseFloat(attr('HDRCapacityMin', '0'));
    metadata.hdrCapacityMax = parseFloat(attr('HDRCapacityMax', '1'));
  }

  function parseISOMetadata(data, metadata) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 4; // skip min version + writer version (2 + 2)
    const flags = view.getUint8(offset);
    offset += 1;
    const backwardDirection = (flags & 0x4) !== 0;
    const useCommonDenominator = (flags & 0x8) !== 0;

    let gainMapMin, gainMapMax, gamma, offsetSDR, offsetHDR;
    let hdrCapacityMin, hdrCapacityMax;

    if (useCommonDenominator) {
      const commonDenominator = view.getUint32(offset, false); offset += 4;
      const baseHdrHeadroomN = view.getUint32(offset, false); offset += 4;
      hdrCapacityMin = Math.log2(baseHdrHeadroomN / commonDenominator);
      const alternateHdrHeadroomN = view.getUint32(offset, false); offset += 4;
      hdrCapacityMax = Math.log2(alternateHdrHeadroomN / commonDenominator);
      const gainMapMinN = view.getInt32(offset, false); offset += 4;
      gainMapMin = gainMapMinN / commonDenominator;
      const gainMapMaxN = view.getInt32(offset, false); offset += 4;
      gainMapMax = gainMapMaxN / commonDenominator;
      const gammaN = view.getUint32(offset, false); offset += 4;
      gamma = gammaN / commonDenominator;
      const offsetSDRN = view.getInt32(offset, false); offset += 4;
      offsetSDR = (offsetSDRN / commonDenominator) * 255.0;
      const offsetHDRN = view.getInt32(offset, false);
      offsetHDR = (offsetHDRN / commonDenominator) * 255.0;
    } else {
      const baseHdrHeadroomN = view.getUint32(offset, false); offset += 4;
      const baseHdrHeadroomD = view.getUint32(offset, false); offset += 4;
      hdrCapacityMin = Math.log2(baseHdrHeadroomN / baseHdrHeadroomD);
      const alternateHdrHeadroomN = view.getUint32(offset, false); offset += 4;
      const alternateHdrHeadroomD = view.getUint32(offset, false); offset += 4;
      hdrCapacityMax = Math.log2(alternateHdrHeadroomN / alternateHdrHeadroomD);
      const gainMapMinN = view.getInt32(offset, false); offset += 4;
      const gainMapMinD = view.getUint32(offset, false); offset += 4;
      gainMapMin = gainMapMinN / gainMapMinD;
      const gainMapMaxN = view.getInt32(offset, false); offset += 4;
      const gainMapMaxD = view.getUint32(offset, false); offset += 4;
      gainMapMax = gainMapMaxN / gainMapMaxD;
      const gammaN = view.getUint32(offset, false); offset += 4;
      const gammaD = view.getUint32(offset, false); offset += 4;
      gamma = gammaN / gammaD;
      const offsetSDRN = view.getInt32(offset, false); offset += 4;
      const offsetSDRD = view.getUint32(offset, false); offset += 4;
      offsetSDR = (offsetSDRN / offsetSDRD) * 255.0;
      const offsetHDRN = view.getInt32(offset, false); offset += 4;
      const offsetHDRD = view.getUint32(offset, false);
      offsetHDR = (offsetHDRN / offsetHDRD) * 255.0;
    }

    metadata.version = '1.0';
    metadata.baseRenditionIsHDR = backwardDirection;
    metadata.gainMapMin = gainMapMin;
    metadata.gainMapMax = gainMapMax;
    metadata.gamma = gamma;
    metadata.offsetSDR = offsetSDR;
    metadata.offsetHDR = offsetHDR;
    metadata.hdrCapacityMin = hdrCapacityMin;
    metadata.hdrCapacityMax = hdrCapacityMax;
  }

  class UltraHDRLoader {
    constructor() {
      this.path = '';
      this.sdmcPath = null;
      this.type = THREE.HalfFloatType;
      // 0 = no cap. When set, the SDR + gainmap canvases are scaled
      // down so neither dimension exceeds maxSize. Used on low-VRAM
      // platforms (Mesa Nouveau / Citron) where PMREM blur loops
      // bog down on a full 2k RGBA16F source equirect with 12-mip
      // chain — the slow per-bindTexture latency that ultimately
      // wedges the driver. Downsizing trades sharpness for survival.
      this.maxSize = 0;
    }
    setPath(p) { this.path = p; return this; }
    setSdmcPath(p) { this.sdmcPath = p; return this; }
    setDataType(t) { this.type = t; return this; }
    setMaxSize(n) { this.maxSize = n; return this; }

    load(url, onLoad, onProgress, onError) {
      log('load() begin', url);
      const texture = new THREE.DataTexture(
        this.type === THREE.HalfFloatType ? new Uint16Array() : new Float32Array(),
        0, 0,
        THREE.RGBAFormat,
        this.type,
        THREE.UVMapping,
        THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping,
        THREE.LinearFilter, THREE.LinearMipMapLinearFilter,
        1, THREE.LinearSRGBColorSpace,
      );
      texture.generateMipmaps = true;
      texture.flipY = true;

      const onBuffer = (buffer) => {
        log('Switch.readFile resolved', 'bytes=' + buffer.byteLength);
        try {
          this.parse(buffer, (texData) => {
            log('parse onLoad', texData.width + 'x' + texData.height + ' type=' + texData.type);
            texture.image = {
              data: texData.data,
              width: texData.width,
              height: texData.height,
            };
            texture.needsUpdate = true;
            log('about to call user onLoad callback');
            if (onLoad) onLoad(texture, texData);
            log('returned from user onLoad callback');
          }, onError);
        } catch (e) {
          log('parse THREW', e && e.message ? e.message : String(e));
          if (onError) onError(e);
        }
      };

      if (this.sdmcPath) {
        log('Switch.readFile begin', this.sdmcPath + url);
        Switch.readFile(this.sdmcPath + url).then((buf) => {
          onBuffer(buf instanceof ArrayBuffer
            ? buf
            : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        }).catch((e) => {
          log('Switch.readFile FAILED', e && e.message ? e.message : String(e));
          if (onError) onError(e);
        });
      } else {
        fetch(this.path + url).then((r) => r.arrayBuffer()).then(onBuffer)
          .catch((e) => { if (onError) onError(e); });
      }

      return texture;
    }

    parse(buffer, onLoad, onError) {
      log('parse() entry', 'bufferLen=' + buffer.byteLength);
      const metadata = {
        version: null,
        baseRenditionIsHDR: null,
        gainMapMin: null, gainMapMax: null,
        gamma: null,
        offsetSDR: null, offsetHDR: null,
        hdrCapacityMin: null, hdrCapacityMax: null,
      };
      const textDecoder = new TextDecoder();
      const bytes = new Uint8Array(buffer);
      const sections = [];

      let offset = 0;
      while (offset < bytes.length - 1) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const markerType = bytes[offset + 1];
        if (markerType === 0xd8) {
          sections.push({
            sectionType: markerType,
            section: bytes.subarray(offset, offset + 2),
            sectionOffset: offset + 2,
          });
          offset += 2; continue;
        }
        if (markerType === 0xe0 || markerType === 0xe1 || markerType === 0xe2) {
          const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
          const segmentEnd = offset + 2 + segmentLength;
          sections.push({
            sectionType: markerType,
            section: bytes.subarray(offset, segmentEnd),
            sectionOffset: offset + 2,
          });
          offset = segmentEnd; continue;
        }
        if (markerType >= 0xc0 && markerType <= 0xfe &&
            markerType !== 0xd9 && (markerType < 0xd0 || markerType > 0xd7)) {
          const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
          offset += 2 + segmentLength;
          continue;
        }
        offset += 2;
      }

      log('JPEG section scan complete', 'sections=' + sections.length);

      let primaryImage, gainmapImage;

      for (let i = 0; i < sections.length; i++) {
        const { sectionType, section, sectionOffset } = sections[i];
        if (sectionType === 0xe0) {
          /* JPEG header, ignored */
        } else if (sectionType === 0xe1) {
          parseXMPMetadata(textDecoder.decode(new Uint8Array(section)), metadata);
        } else if (sectionType === 0xe2) {
          const sectionData = new DataView(
            section.buffer, section.byteOffset + 2, section.byteLength - 2,
          );

          // ISO 21496-1 metadata?
          const isoNS = 'urn:iso:std:iso:ts:21496:-1 ';
          if (section.byteLength >= isoNS.length + 2) {
            let isISO = true;
            for (let j = 0; j < isoNS.length; j++) {
              if (section[2 + j] !== isoNS.charCodeAt(j)) { isISO = false; break; }
            }
            if (isISO) {
              const isoData = section.subarray(2 + isoNS.length);
              parseISOMetadata(isoData, metadata);
              continue;
            }
          }

          // MPF section?
          const sectionHeader = sectionData.getUint32(2, false);
          if (sectionHeader === 0x4d504600) {
            const mpfLittleEndian = sectionData.getUint32(6) === 0x49492a00;
            const mpfBytesOffset = 60;
            const primaryImageSize = sectionData.getUint32(mpfBytesOffset, mpfLittleEndian);
            const primaryImageOffset = sectionData.getUint32(mpfBytesOffset + 4, mpfLittleEndian);
            const gainmapImageSize = sectionData.getUint32(mpfBytesOffset + 16, mpfLittleEndian);
            const gainmapImageOffset =
              sectionData.getUint32(mpfBytesOffset + 20, mpfLittleEndian) +
              sectionOffset + 6;

            primaryImage = new Uint8Array(buffer, primaryImageOffset, primaryImageSize);
            gainmapImage = new Uint8Array(buffer, gainmapImageOffset, gainmapImageSize);
          }
        }
      }

      log('metadata complete',
        'ver=' + metadata.version +
        ' gainMin=' + metadata.gainMapMin +
        ' gainMax=' + (typeof metadata.gainMapMax === 'number' ? metadata.gainMapMax.toFixed(3) : metadata.gainMapMax) +
        ' gamma=' + metadata.gamma);
      log('image pointers', 'sdr=' + (primaryImage ? primaryImage.byteLength : 'null') +
        ' gainmap=' + (gainmapImage ? gainmapImage.byteLength : 'null'));

      if (!metadata.version) throw new Error('UltraHDRLoader: not a valid UltraHDR image');
      if (!primaryImage || !gainmapImage) {
        throw new Error('UltraHDRLoader: could not locate SDR or gainmap images');
      }

      log('before _applyGainmapToSDR');
      this._applyGainmapToSDR(metadata, primaryImage, gainmapImage,
        (hdrBuffer, width, height) => {
          onLoad({
            width, height, data: hdrBuffer,
            format: THREE.RGBAFormat,
            type: this.type,
          });
        },
        (err) => {
          if (onError) onError(typeof err === 'string' ? new Error(err) : err);
        },
      );
    }

    _applyGainmapToSDR(metadata, sdrBuffer, gainmapBuffer, onSuccess, onError) {
      const decodeImage = (data, label) => {
        log('createImageBitmap begin', label + ' bytes=' + data.byteLength);
        return createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
          .then((bm) => {
            log('createImageBitmap done', label + ' ' + bm.width + 'x' + bm.height);
            return bm;
          });
      };

      const maxSize = this.maxSize;
      Promise.all([decodeImage(sdrBuffer, 'sdr'), decodeImage(gainmapBuffer, 'gainmap')])
        .then(([sdrImage, gainmapImage]) => {
          log('both bitmaps decoded',
            'sdr=' + sdrImage.width + 'x' + sdrImage.height +
            ' gain=' + gainmapImage.width + 'x' + gainmapImage.height);
          let sdrWidth = sdrImage.width;
          let sdrHeight = sdrImage.height;
          const sdrAspect = sdrWidth / sdrHeight;
          const gainmapAspect = gainmapImage.width / gainmapImage.height;
          if (Math.abs(sdrAspect - gainmapAspect) > 0.001) {
            log('ASPECT MISMATCH', 'sdr=' + sdrAspect + ' gain=' + gainmapAspect);
            onError('UltraHDRLoader: SDR and gainmap aspect ratio mismatch');
            return;
          }

          // Optional downsize for low-VRAM platforms. The HDR recovery
          // loop output dims become the canvas dims here.
          if (maxSize && (sdrWidth > maxSize || sdrHeight > maxSize)) {
            const scale = Math.min(maxSize / sdrWidth, maxSize / sdrHeight);
            const newW = Math.max(1, Math.round(sdrWidth * scale));
            const newH = Math.max(1, Math.round(sdrHeight * scale));
            log('downsize active',
              sdrWidth + 'x' + sdrHeight + ' -> ' + newW + 'x' + newH);
            sdrWidth = newW;
            sdrHeight = newH;
          }

          log('before new OffscreenCanvas', sdrWidth + 'x' + sdrHeight);
          const canvas = new OffscreenCanvas(sdrWidth, sdrHeight);
          const ctx = canvas.getContext('2d');
          log('after OffscreenCanvas + 2d ctx');

          ctx.drawImage(
            gainmapImage,
            0, 0, gainmapImage.width, gainmapImage.height,
            0, 0, sdrWidth, sdrHeight,
          );
          log('drew gainmap to canvas (scaled to target size)');
          const gainmapImageData = ctx.getImageData(0, 0, sdrWidth, sdrHeight);
          log('getImageData gainmap', 'bytes=' + gainmapImageData.data.length);

          // Scale SDR to target dims too (not just at native size).
          ctx.drawImage(
            sdrImage,
            0, 0, sdrImage.width, sdrImage.height,
            0, 0, sdrWidth, sdrHeight,
          );
          log('drew sdr to canvas (scaled to target size)');
          const sdrImageData = ctx.getImageData(0, 0, sdrWidth, sdrHeight);
          log('getImageData sdr', 'bytes=' + sdrImageData.data.length);

          const maxDisplayBoost = Math.pow(1.8, metadata.hdrCapacityMax * 0.5);
          const unclampedWeightFactor =
            (Math.log2(maxDisplayBoost) - metadata.hdrCapacityMin) /
            (metadata.hdrCapacityMax - metadata.hdrCapacityMin);
          const weightFactor = Math.min(Math.max(unclampedWeightFactor, 0), 1);

          const sdrData = sdrImageData.data;
          const gainmapData = gainmapImageData.data;
          const dataLength = sdrData.length;
          const gainMapMin = metadata.gainMapMin;
          const gainMapMax = metadata.gainMapMax;
          const offsetSDR = metadata.offsetSDR;
          const offsetHDR = metadata.offsetHDR;
          const invGamma = 1.0 / metadata.gamma;
          const useGammaOne = metadata.gamma === 1.0;
          const isHalfFloat = this.type === THREE.HalfFloatType;
          const toHalfFloat = THREE.DataUtils.toHalfFloat;

          log('allocating hdrBuffer',
            'isHalfFloat=' + isHalfFloat + ' dataLength=' + dataLength +
            ' approxMB=' + ((dataLength * (isHalfFloat ? 2 : 4)) / 1048576).toFixed(1));
          // 1.0 in half-float is 15360; 1.0 in float32 is 1.0. Pre-fill
          // alpha channel to 1.0 once; the loop only writes RGB.
          const hdrBuffer = isHalfFloat
            ? new Uint16Array(dataLength).fill(15360)
            : new Float32Array(dataLength).fill(1.0);
          log('hdrBuffer allocated + filled');

          log('HDR recovery loop begin');
          const PROGRESS_INTERVAL = 1048576; // log every ~1M elements (~262k pixels)
          let nextProgress = PROGRESS_INTERVAL;
          for (let i = 0; i < dataLength; i += 4) {
            for (let c = 0; c < 3; c++) {
              const idx = i + c;
              const sdrValue = sdrData[idx];
              const gainmapValue = gainmapData[idx] * 0.00392156862745098;
              const logRecovery = useGammaOne
                ? gainmapValue
                : Math.pow(gainmapValue, invGamma);
              const logBoost = gainMapMin + (gainMapMax - gainMapMin) * logRecovery;
              const hdrValue =
                (sdrValue + offsetSDR) *
                  (logBoost * weightFactor === 0.0
                    ? 1.0
                    : Math.pow(2, logBoost * weightFactor)) -
                offsetHDR;
              const linearHDRValue = Math.min(Math.max(srgbToLinear(hdrValue), 0), 65504);
              hdrBuffer[idx] = isHalfFloat ? toHalfFloat(linearHDRValue) : linearHDRValue;
            }
            if (i >= nextProgress) {
              log('HDR loop progress', Math.round((i / dataLength) * 100) + '%');
              nextProgress += PROGRESS_INTERVAL;
            }
          }
          log('HDR recovery loop done');

          log('before onSuccess(hdrBuffer)');
          onSuccess(hdrBuffer, sdrWidth, sdrHeight);
          log('after onSuccess returned');
        })
        .catch((e) => {
          log('decode/apply CHAIN REJECTED', e && e.message ? e.message : String(e));
          onError(e);
        });
    }
  }

  THREE.UltraHDRLoader = UltraHDRLoader;
})();
