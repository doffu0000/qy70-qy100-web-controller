// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// Minimal animated GIF (GIF89a) encoder for the Graphics tab's Frames
// sequence - lets a whole animation round-trip as a real, standalone
// .gif file (openable/previewable in any image viewer or browser, with
// correct per-frame timing - GIF has a native delay field, which is
// exactly the "can't encode a pause in SysEx bytes" gap the Animation
// SysEx panel's own tooltip calls out), the same way a single frame
// round-trips as a .bmp. 2-color (black/white) palette only, matching
// the canvas's own monochrome content. Encode-only - there's no matching
// decoder here (Load Animation instead imports a sequence of ordinary
// still images, one per frame, rather than reading GIFs back in).

// Encodes one frame's pixel indices (0/1 per pixel, row-major) as GIF
// LZW-compressed image data (a minimum code size byte followed by
// length-prefixed sub-blocks, zero-terminated - ready to append right
// after that frame's Image Descriptor). Minimum code size is fixed at 2,
// GIF's own floor even for a 2-color image.
function encodeIndicesLzw(indices) {
  const minCodeSize = 2;
  const clearCode = 1 << minCodeSize; // 4
  const endCode = clearCode + 1; // 5
  let codeSize = minCodeSize + 1; // 3
  let nextCode = endCode + 1; // 6
  let dict = new Map();

  function resetDict() {
    dict = new Map();
    for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  }
  resetDict();

  const emitted = [{ code: clearCode, size: codeSize }];
  let w = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const wk = `${w},${k}`;
    if (dict.has(wk)) {
      w = wk;
      continue;
    }
    emitted.push({ code: dict.get(w), size: codeSize });
    if (nextCode < 4096) {
      dict.set(wk, nextCode);
      nextCode++;
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emitted.push({ code: clearCode, size: codeSize });
      resetDict();
    }
    w = String(k);
  }
  emitted.push({ code: dict.get(w), size: codeSize });
  emitted.push({ code: endCode, size: codeSize });

  // Pack into a bitstream, LSB-first within each byte (GIF's own bit
  // order for LZW codes).
  const bytes = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const { code, size } of emitted) {
    bitBuffer |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  }
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);

  const out = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0); // block terminator
  return out;
}

// frames: [{ indices: (0/1)[width*height], delayCs: number }] - delayCs
// is in 1/100s units, GIF's own delay resolution. loopForever adds a
// Netscape looping extension (skip it for a single playthrough).
export function encodeAnimatedGif({ width, height, frames, loopForever = true }) {
  const out = [];
  const push = (...vals) => out.push(...vals);
  const pushStr = (s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  const pushU16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);

  pushStr('GIF89a');
  pushU16(width);
  pushU16(height);
  push(0b10000001); // global color table present, 4 entries (2^(1+1))
  push(0); // background color index
  push(0); // no pixel aspect ratio info
  push(0xff, 0xff, 0xff); // palette 0: white (off)
  push(0x00, 0x00, 0x00); // palette 1: black (on)
  push(0x00, 0x00, 0x00); // palette 2: unused
  push(0x00, 0x00, 0x00); // palette 3: unused

  if (loopForever && frames.length > 1) {
    push(0x21, 0xff, 0x0b);
    pushStr('NETSCAPE2.0');
    push(3, 1, 0, 0, 0);
  }

  for (const frame of frames) {
    push(0x21, 0xf9, 4);
    push(0b00000100); // disposal method 1 (do not dispose), no transparency
    pushU16(Math.max(1, Math.round(frame.delayCs)));
    push(0, 0); // transparent color index (unused), block terminator

    push(0x2c); // image descriptor
    pushU16(0); pushU16(0); // left, top
    pushU16(width); pushU16(height);
    push(0); // no local color table, no interlace

    push(...encodeIndicesLzw(Array.from(frame.indices)));
  }

  push(0x3b); // trailer
  return new Uint8Array(out);
}

// This app's own canvas size - decodeAnimatedGif only accepts a GIF whose
// logical screen (and every frame in it) is exactly this size, same
// restriction decodeMonoBmp applies to .bmp files in bmp.js.
const GIF_WIDTH = 16;
const GIF_HEIGHT = 16;

// Reads the LZW-compressed image data starting at a frame's minimum-code-
// size byte (immediately after its Image Descriptor / local color table)
// back into color-table indices, the inverse of encodeIndicesLzw above.
// Returns the decoded indices plus the offset just past the terminating
// zero-length sub-block, so the caller can keep parsing.
function decodeIndicesLzw(bytes, startOffset, expectedPixelCount) {
  let offset = startOffset;
  if (offset >= bytes.length) throw new Error('Corrupt GIF file: unexpected end of file.');
  const minCodeSize = bytes[offset];
  offset += 1;

  const dataBytes = [];
  while (true) {
    if (offset >= bytes.length) throw new Error('Corrupt GIF file: unexpected end of file.');
    const blockSize = bytes[offset];
    offset += 1;
    if (blockSize === 0) break;
    if (offset + blockSize > bytes.length) throw new Error('Corrupt GIF file: image data is truncated.');
    for (let i = 0; i < blockSize; i++) dataBytes.push(bytes[offset + i]);
    offset += blockSize;
  }

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let bitPos = 0;
  function readCode(size) {
    let value = 0;
    for (let i = 0; i < size; i++) {
      const bitIndex = bitPos + i;
      const byteIndex = bitIndex >> 3;
      const bit = byteIndex < dataBytes.length ? (dataBytes[byteIndex] >> (bitIndex & 7)) & 1 : 0;
      value |= bit << i;
    }
    bitPos += size;
    return value;
  }

  let codeSize;
  let dict;
  function resetDict() {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push(null); // clear code - never looked up as an entry
    dict.push(null); // end code - never looked up as an entry
    codeSize = minCodeSize + 1;
  }
  resetDict();

  const output = [];
  let prev = null;
  while (output.length < expectedPixelCount) {
    if (bitPos + codeSize > dataBytes.length * 8) break;
    const code = readCode(codeSize);
    if (code === clearCode) {
      resetDict();
      prev = null;
      continue;
    }
    if (code === endCode) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (code === dict.length && prev) entry = prev.concat(prev[0]);
    else throw new Error('Corrupt GIF file: invalid LZW code.');
    for (const v of entry) output.push(v);
    if (prev) {
      dict.push(prev.concat(entry[0]));
      // >= not > - the decoder's dictionary is always exactly one entry
      // behind the encoder's (no entry is added for the very first code
      // after a clear), so its own growth threshold must trigger one
      // entry earlier to stay in lockstep with encodeIndicesLzw's.
      if (dict.length >= (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return { indices: output.slice(0, expectedPixelCount), nextOffset: offset };
}

// Reverses the GIF's 4-pass interlace row order back to top-to-bottom.
function deinterlace(colorIndices, width, height) {
  const out = new Array(width * height);
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  let src = 0;
  for (const [start, stride] of passes) {
    for (let y = start; y < height; y += stride) {
      for (let x = 0; x < width; x++) out[y * width + x] = colorIndices[src++];
    }
  }
  return out;
}

// Decodes an animated (or single-frame) GIF back into the same shape
// encodeAnimatedGif accepts: { width, height, frames: [{ indices, delayCs
// }] }. Only accepts exactly-16x16, full-canvas frames (no local
// sub-rectangle/partial-update frames, the kind some GIF optimizers
// produce) - anything else throws a specific, actionable error rather
// than silently compositing or corrupting. A palette color counts as "on"
// using the same luminance-under-half threshold as decodeMonoBmp's 24/32-
// bit path, so third-party-authored GIFs (not just ones this app wrote)
// decode sensibly too.
export function decodeAnimatedGif(bytes) {
  if (bytes.length < 13) throw new Error('Not a GIF file.');
  const sig = String.fromCharCode(...bytes.slice(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('Not a GIF file.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (width !== GIF_WIDTH || height !== GIF_HEIGHT) {
    throw new Error(`Image must be exactly ${GIF_WIDTH}x${GIF_HEIGHT} pixels (this file is ${width}x${height}).`);
  }
  const packed = bytes[10];
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = 2 << (packed & 0x07);
  let offset = 13;
  let globalColorTable = null;
  if (gctFlag) {
    if (offset + gctSize * 3 > bytes.length) throw new Error('Corrupt GIF file: color table is truncated.');
    globalColorTable = [];
    for (let i = 0; i < gctSize; i++) {
      globalColorTable.push([bytes[offset], bytes[offset + 1], bytes[offset + 2]]);
      offset += 3;
    }
  }

  const frames = [];
  let pendingDelayCs = 10;
  let pendingTransparentIndex = -1;

  while (offset < bytes.length) {
    const marker = bytes[offset];
    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) {
      if (offset + 2 > bytes.length) throw new Error('Corrupt GIF file: unexpected end of file.');
      const label = bytes[offset + 1];
      offset += 2;
      if (label === 0xf9) {
        if (offset + 5 > bytes.length) throw new Error('Corrupt GIF file: truncated graphic control extension.');
        const blockSize = bytes[offset];
        const packedGce = bytes[offset + 1];
        pendingDelayCs = view.getUint16(offset + 2, true) || 10;
        const transparentFlag = (packedGce & 0x01) !== 0;
        pendingTransparentIndex = transparentFlag ? bytes[offset + 4] : -1;
        offset += 1 + blockSize;
        if (bytes[offset] !== 0) throw new Error('Corrupt GIF file: malformed graphic control extension.');
        offset += 1;
      } else {
        while (true) {
          if (offset >= bytes.length) throw new Error('Corrupt GIF file: unexpected end of file.');
          const blockSize = bytes[offset];
          offset += 1;
          if (blockSize === 0) break;
          offset += blockSize;
        }
      }
      continue;
    }

    if (marker === 0x2c) {
      if (offset + 10 > bytes.length) throw new Error('Corrupt GIF file: truncated image descriptor.');
      const left = view.getUint16(offset + 1, true);
      const top = view.getUint16(offset + 3, true);
      const fWidth = view.getUint16(offset + 5, true);
      const fHeight = view.getUint16(offset + 7, true);
      const fPacked = bytes[offset + 9];
      offset += 10;
      const lctFlag = (fPacked & 0x80) !== 0;
      const interlaced = (fPacked & 0x40) !== 0;
      const lctSize = 2 << (fPacked & 0x07);
      let palette = globalColorTable;
      if (lctFlag) {
        if (offset + lctSize * 3 > bytes.length) throw new Error('Corrupt GIF file: color table is truncated.');
        palette = [];
        for (let i = 0; i < lctSize; i++) {
          palette.push([bytes[offset], bytes[offset + 1], bytes[offset + 2]]);
          offset += 3;
        }
      }
      if (left !== 0 || top !== 0 || fWidth !== width || fHeight !== height) {
        throw new Error('Unsupported GIF: only full-frame animation frames are supported (no partial-update frames).');
      }
      if (!palette) throw new Error('Corrupt GIF file: frame has no color table.');

      const { indices: colorIndices, nextOffset } = decodeIndicesLzw(bytes, offset, fWidth * fHeight);
      offset = nextOffset;
      const orderedIndices = interlaced ? deinterlace(colorIndices, fWidth, fHeight) : colorIndices;

      const activeIndices = orderedIndices.map((ci) => {
        if (ci === pendingTransparentIndex) return 0;
        const rgb = palette[ci] || [255, 255, 255];
        return (rgb[0] + rgb[1] + rgb[2]) / 3 < 128 ? 1 : 0;
      });

      frames.push({ indices: activeIndices, delayCs: pendingDelayCs });
      pendingTransparentIndex = -1;
      continue;
    }

    throw new Error('Corrupt GIF file: unrecognized block.');
  }

  if (frames.length === 0) throw new Error('GIF file has no image frames.');
  return { width, height, frames };
}
