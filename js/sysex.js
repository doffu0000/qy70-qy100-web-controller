// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// QY70 / XG SysEx message builders, matching the QY70 Data List's "MIDI
// Data Format" section:
//
//   XG Bulk Dump           F0 43 0n 4C bb bb aa aa aa dd..dd cc F7
//   XG Parameter Change    F0 43 1n 4C aa aa aa dd..dd F7
//   XG Bulk Dump Request   F0 43 2n 4C aa aa aa F7
//   XG Parameter Request   F0 43 3n 4C aa aa aa F7
//   MIDI Master Tuning     F0 43 1n 27 30 00 00 mm ll cc F7
//
// n = device number (0-15), aa/bb = 7-bit address/byte-count bytes,
// cc = checksum: the value that makes (byteCount + address + data + checksum)
// sum to a multiple of 128 in its low 7 bits.

export const YAMAHA_ID = 0x43;
export const MODEL_ID_XG = 0x4c;

export function checksum(bytes) {
  const sum = bytes.reduce((a, b) => a + b, 0);
  return (128 - (sum % 128)) % 128;
}

function addr3(address) {
  if (!Array.isArray(address) || address.length !== 3) {
    throw new Error('address must be [high, mid, low]');
  }
  return address;
}

export function buildParameterChange(deviceNumber, address, data) {
  const [ah, am, al] = addr3(address);
  return new Uint8Array([
    0xf0, YAMAHA_ID, 0x10 | (deviceNumber & 0x0f), MODEL_ID_XG,
    ah, am, al, ...data, 0xf7,
  ]);
}

export function buildBulkDump(deviceNumber, address, data) {
  const [ah, am, al] = addr3(address);
  const byteCount = data.length;
  const bbHigh = (byteCount >> 7) & 0x7f;
  const bbLow = byteCount & 0x7f;
  const body = [bbHigh, bbLow, ah, am, al, ...data];
  const cc = checksum(body);
  return new Uint8Array([
    0xf0, YAMAHA_ID, 0x00 | (deviceNumber & 0x0f), MODEL_ID_XG,
    ...body, cc, 0xf7,
  ]);
}

export function buildBulkDumpRequest(deviceNumber, address) {
  const [ah, am, al] = addr3(address);
  return new Uint8Array([
    0xf0, YAMAHA_ID, 0x20 | (deviceNumber & 0x0f), MODEL_ID_XG,
    ah, am, al, 0xf7,
  ]);
}

export function buildParameterRequest(deviceNumber, address) {
  const [ah, am, al] = addr3(address);
  return new Uint8Array([
    0xf0, YAMAHA_ID, 0x30 | (deviceNumber & 0x0f), MODEL_ID_XG,
    ah, am, al, 0xf7,
  ]);
}

export function buildXgSystemOn(deviceNumber) {
  return buildParameterChange(deviceNumber, [0x00, 0x00, 0x7e], [0x00]);
}

// General MIDI System On (Universal Non-Realtime Message, Data List
// 3-6-1-1) - unlike XG System On, this is a generic MIDI message with no
// Yamaha ID or device number, and switches the QY70/QY100 into GM mode
// instead of XG mode, resetting volume, pan, program, bank, reverb
// depth, and most controllers to GM defaults in the process.
export function buildGmSystemOn() {
  return new Uint8Array([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]);
}

// Writes text into the QY70/QY100's 32-character LCD "Message Window"
// (Data List Table 1-5, address 06 00 00 - 06 00 1F, one ASCII byte per
// character). Longer text is truncated; shorter text is space-padded to
// the full 32 bytes so it fully overwrites whatever was on screen before,
// rather than leaving trailing characters from a longer previous message.
export function buildMessageWindow(deviceNumber, text) {
  const MESSAGE_WINDOW_LENGTH = 32;
  const bytes = [];
  for (let i = 0; i < MESSAGE_WINDOW_LENGTH; i++) {
    const code = text.charCodeAt(i);
    bytes.push(Number.isNaN(code) || code < 0x20 || code > 0x7f ? 0x20 : code);
  }
  return buildParameterChange(deviceNumber, [0x06, 0x00, 0x00], bytes);
}

// Writes just ONE of the Message Window's two 16-character lines - Table
// 1-5's 32-byte range splits cleanly into two 16-byte halves (line 0 at
// address 06 00 00, line 1 at 06 00 10), and XG Parameter Change lets a
// message target any address/length within a parameter, so this only
// ever touches its own line's bytes and leaves whatever's on the other
// line completely alone. That's what makes fully independent per-line
// animation possible (see the Display Text tab's Split Message mode):
// each line's own send loop never has to know or coordinate with
// whatever the other line's loop is doing.
export function buildMessageWindowLine(deviceNumber, lineIndex, text) {
  const LINE_LENGTH = 16;
  const bytes = [];
  for (let i = 0; i < LINE_LENGTH; i++) {
    const code = text.charCodeAt(i);
    bytes.push(Number.isNaN(code) || code < 0x20 || code > 0x7f ? 0x20 : code);
  }
  return buildParameterChange(deviceNumber, [0x06, 0x00, (lineIndex & 1) * 0x10], bytes);
}

// Writes to the QY70/QY100's Bitmap Window display (Data List Table 1-5,
// address 07 00 00 - 07 00 2F, 48 data bytes). The doc lays these out as
// 48 flat byte/bit positions with no stated row/column mapping; the
// actual 16x16-pixel arrangement here was worked out by pushing single
// pixels and identifying all 4 real on-device corners: a byte's index
// within its own group of 16 (0-15) is the row (0=top, 15=bottom), and
// which of the 3 groups it's in is the horizontal section (Data0-15
// left, Data16-31 middle - untested, assumed by elimination - Data32-47
// right, bits b5/b6 only per the doc's own "Data 32-47 only uses bit 6
// and bit 5" note). See the Graphics tab's own grid-building code in
// app.js for the exact pixel-to-(dataIndex,bit) mapping and its
// remaining uncertainty (which bit is which column within a group).
// This function just takes the flat 48-byte array however it was
// assembled.
export function buildBitmapWindow(deviceNumber, data48) {
  const BITMAP_DATA_LENGTH = 48;
  const data = [];
  for (let i = 0; i < BITMAP_DATA_LENGTH; i++) {
    const value = data48[i];
    data.push(Number.isInteger(value) ? value & 0x7f : 0);
  }
  return buildParameterChange(deviceNumber, [0x07, 0x00, 0x00], data);
}

// Section Control (Data List 3-6-2) - a QY-specific SysEx shape, distinct
// from XG Parameter Change: no device-number nibble, fixed 7E status byte.
// F0 43 7E 00 ss dd F7, where ss (08H-0EH) selects INTRO/MAIN A/MAIN B/
// FILL AB/FILL BA/ENDING/BLANK. The byte structure itself is confirmed
// against two independently-extracted copies of the doc and real-hardware
// testing while a pattern was actively playing still didn't switch
// sections - the doc only ever says "dd=on is received" without spelling
// out the literal value, so this is now trying 7F (all bits set) instead
// of 1 as the "on" encoding, since every other hypothesis (byte order,
// section values, playback state) has been ruled out. Unconfirmed.
export const SECTION = {
  INTRO: 0x08,
  MAIN_A: 0x09,
  MAIN_B: 0x0a,
  FILL_AB: 0x0b,
  FILL_BA: 0x0c,
  ENDING: 0x0d,
  BLANK: 0x0e,
};

export function buildSectionControl(section) {
  return new Uint8Array([0xf0, YAMAHA_ID, 0x7e, 0x00, section, 0x7f, 0xf7]);
}

// Song Select (standard MIDI System Common, not XG SysEx) - Data List 3-3-2:
// the QY70/QY100 interprets the same F3 <number> message as a Song number
// while in Song mode, or a Pattern number while in Pattern mode - there's
// no separate "Pattern Select" message, just this one read differently
// depending on which mode the device is currently in.
export function buildSongSelect(number) {
  return new Uint8Array([0xf3, number & 0x7f]);
}

// cents: -1024.0 .. +1023.9921875 (7-bit nibble-packed as documented in Table 1-2)
export function buildMidiMasterTuning(deviceNumber, mm, ll) {
  const body = [0x30, 0x00, 0x00, mm & 0x7f, ll & 0x7f];
  const cc = checksum(body);
  return new Uint8Array([
    0xf0, YAMAHA_ID, 0x10 | (deviceNumber & 0x0f), 0x27,
    ...body, cc, 0xf7,
  ]);
}

