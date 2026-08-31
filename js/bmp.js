// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// Minimal BMP (Windows Bitmap, BITMAPINFOHEADER) encoder/decoder for the
// Graphics tab's 16x16 monochrome pixel canvas - lets a drawn image
// round-trip as a real, standalone .bmp file on disk (openable in any
// image viewer/editor) rather than any in-app-only storage.

const BMP_WIDTH = 16;
const BMP_HEIGHT = 16;

function rowStride(rowBytes) {
  return Math.ceil(rowBytes / 4) * 4;
}

// isActive(x, y) -> boolean, y=0 is the top row. Encodes as 1-bit-per-
// pixel: black = on, white = off (BMP rows are stored bottom-up, and each
// row is padded to a 4-byte boundary per the file format).
export function encodeMonoBmp16x16(isActive) {
  const rowBytes = Math.ceil(BMP_WIDTH / 8);
  const stride = rowStride(rowBytes);
  const pixelDataSize = stride * BMP_HEIGHT;
  const headerSize = 14 + 40 + 8; // file header + info header + 2-color palette
  const fileSize = headerSize + pixelDataSize;
  const buf = new Uint8Array(fileSize);
  const view = new DataView(buf.buffer);

  buf[0] = 0x42; buf[1] = 0x4d; // 'BM'
  view.setUint32(2, fileSize, true);
  view.setUint32(6, 0, true);
  view.setUint32(10, headerSize, true);

  view.setUint32(14, 40, true);
  view.setInt32(18, BMP_WIDTH, true);
  view.setInt32(22, BMP_HEIGHT, true); // positive = bottom-up
  view.setUint16(26, 1, true);
  view.setUint16(28, 1, true); // 1 bit per pixel
  view.setUint32(30, 0, true); // BI_RGB (uncompressed)
  view.setUint32(34, pixelDataSize, true);
  view.setInt32(38, 2835, true); // ~72 DPI
  view.setInt32(42, 2835, true);
  view.setUint32(46, 2, true);
  view.setUint32(50, 2, true);

  // Palette: index 0 = white (off), index 1 = black (on).
  buf[54] = 0xff; buf[55] = 0xff; buf[56] = 0xff; buf[57] = 0x00;
  buf[58] = 0x00; buf[59] = 0x00; buf[60] = 0x00; buf[61] = 0x00;

  let rowStart = headerSize;
  for (let y = BMP_HEIGHT - 1; y >= 0; y--) {
    for (let x = 0; x < BMP_WIDTH; x++) {
      if (isActive(x, y)) buf[rowStart + (x >> 3)] |= 0x80 >> (x % 8);
    }
    rowStart += stride;
  }
  return buf;
}

// Decodes a BMP file back into a 16x16 grid of booleans, indexed
// isActive[y][x] (y=0 top). Supports 1-bit (palette) and 24/32-bit
// (uncompressed RGB) BITMAPINFOHEADER files, both row orders. Throws with
// a specific message if the file isn't a BMP, isn't exactly 16x16 (the
// QY70/QY100's Bitmap Window is a fixed size), or uses an unsupported
// compression/bit depth.
export function decodeMonoBmp(bytes) {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error('Not a BMP file.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelDataOffset = view.getUint32(10, true);
  const infoHeaderSize = view.getUint32(14, true);
  // Every offset/size below comes straight from the file, so a
  // corrupt or hand-crafted-adversarial BMP could otherwise put
  // pixelDataOffset/infoHeaderSize far outside the buffer - JS itself
  // can't be crashed or corrupted by that (TypedArray reads past the end
  // just return undefined, no OOB memory access is possible), but
  // without this check it would silently decode into a blank or
  // garbage-looking image instead of failing with a clear reason.
  if (infoHeaderSize < 40 || 14 + infoHeaderSize > bytes.length) {
    throw new Error('Unsupported or corrupt BMP header format.');
  }
  const width = view.getInt32(18, true);
  const heightRaw = view.getInt32(22, true);
  const height = Math.abs(heightRaw);
  const topDown = heightRaw < 0;
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (compression !== 0) throw new Error('Compressed BMP files are not supported.');
  if (width !== BMP_WIDTH || height !== BMP_HEIGHT) {
    throw new Error(`Image must be exactly ${BMP_WIDTH}x${BMP_HEIGHT} pixels (this file is ${width}x${height}).`);
  }
  if (pixelDataOffset < 14 + infoHeaderSize || pixelDataOffset > bytes.length) {
    throw new Error('Corrupt BMP file: invalid pixel data offset.');
  }

  const isActive = Array.from({ length: BMP_HEIGHT }, () => new Array(BMP_WIDTH).fill(false));

  if (bpp === 1) {
    const paletteOffset = 14 + infoHeaderSize;
    if (paletteOffset + 8 > bytes.length) {
      throw new Error('Corrupt BMP file: palette data is truncated.');
    }
    const c0Luminance = bytes[paletteOffset] + bytes[paletteOffset + 1] + bytes[paletteOffset + 2];
    const c1Luminance = bytes[paletteOffset + 4] + bytes[paletteOffset + 5] + bytes[paletteOffset + 6];
    const onIndex = c0Luminance <= c1Luminance ? 0 : 1;
    const stride = rowStride(Math.ceil(width / 8));
    if (pixelDataOffset + stride * height > bytes.length) {
      throw new Error('Corrupt BMP file: pixel data is truncated.');
    }
    for (let fileRow = 0; fileRow < height; fileRow++) {
      const y = topDown ? fileRow : height - 1 - fileRow;
      const rowStart = pixelDataOffset + fileRow * stride;
      for (let x = 0; x < width; x++) {
        const bit = (bytes[rowStart + (x >> 3)] >> (7 - (x % 8))) & 1;
        isActive[y][x] = bit === onIndex;
      }
    }
  } else if (bpp === 24 || bpp === 32) {
    const bytesPerPixel = bpp / 8;
    const stride = rowStride(width * bytesPerPixel);
    if (pixelDataOffset + stride * height > bytes.length) {
      throw new Error('Corrupt BMP file: pixel data is truncated.');
    }
    for (let fileRow = 0; fileRow < height; fileRow++) {
      const y = topDown ? fileRow : height - 1 - fileRow;
      const rowStart = pixelDataOffset + fileRow * stride;
      for (let x = 0; x < width; x++) {
        const p = rowStart + x * bytesPerPixel;
        const luminance = (bytes[p] + bytes[p + 1] + bytes[p + 2]) / 3;
        isActive[y][x] = luminance < 128;
      }
    }
  } else {
    throw new Error(`Unsupported BMP bit depth (${bpp}-bit) - use a 1-bit or 24-bit BMP.`);
  }
  return isActive;
}
