// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// Live conversations with the device: working out which model is
// connected, confirming it accepted bulk mode, reading its song/user style
// memory list, and clearing slots. Mirrors Yamaha's QY100 Data Filer
// (QY100.exe, decompiled with Ghidra):
//
//   FUN_0040dae0  connection check: Universal Identity Request, expecting
//                 F0 7E 7F 06 02 43 00 41 04 34 xx xx xx xx F7 from a
//                 QY100; then bulk mode ON and a Parameter Request that
//                 must read back ON, or the device is in a screen that
//                 refuses transfers ("press EXIT")
//   FUN_0040e090  song list: request 15 00 00 -> 20 x 16-byte entries
//   FUN_0040e1c0  user style list: 15 01 00 and 15 01 01 -> 64 entries
//   FUN_0040d610  free memory = 100% minus every entry's size
//   FUN_0040e390  song clear  F0 43 10 5F 18 00 00 <slot> F7
//   FUN_0040e440  style clear F0 43 10 5F 18 01 00 <slot> F7
//
// Every address carries the model bit (0x10 = QY100, clear = QY70), the
// same way the song/pattern data does.
//
// `io` is { send(bytes), waitFor(predicate, timeoutMs) -> bytes|null,
// sleep(ms) } so this module stays independent of the page's MIDI plumbing.

import { MODEL_ID_QY } from './sysex.js';

const P = (model) => (model === 'QY70' ? 0x00 : 0x10);
const isQy = (m, sub) => m.length >= 8 && m[0] === 0xf0 && m[1] === 0x43 && (m[2] & 0xf0) === sub && m[3] === MODEL_ID_QY;

export const IDENTITY_REQUEST = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
const QY100_IDENTITY = [0x43, 0x00, 0x41, 0x04, 0x34]; // manufacturer, family, member

const bulkModeRequest = (model) => [0xf0, 0x43, 0x30, MODEL_ID_QY, P(model), 0x00, 0x00, 0xf7];
const bulkModeSet = (model, on) => [0xf0, 0x43, 0x10, MODEL_ID_QY, P(model), 0x00, 0x00, on ? 1 : 0, 0xf7];
const isBulkModeReply = (model) => (m) => isQy(m, 0x10) && m[4] === P(model) && m[5] === 0 && m[6] === 0 && m.length >= 9;

// Works out which model is on the other end of the selected ports.
// Returns { model: 'QY100'|'QY70'|null, identity: number[]|null, how }.
// Identity Request first (the QY100's answer is known); then, since the
// QY70's answer isn't documented anywhere, a bulk mode Parameter Request
// at each model's own address - a QY70 ignores QY100 addresses and vice
// versa, so whichever one answers identifies it.
export async function detectQyModel(io) {
  await io.send(IDENTITY_REQUEST);
  const id = await io.waitFor((m) => m.length >= 10 && m[0] === 0xf0 && m[1] === 0x7e && m[3] === 0x06 && m[4] === 0x02, 1200);
  const identity = id ? Array.from(id) : null;
  if (id && QY100_IDENTITY.every((b, k) => id[5 + k] === b)) return { model: 'QY100', identity, how: 'identity' };
  for (const model of ['QY100', 'QY70']) {
    await io.send(bulkModeRequest(model));
    if (await io.waitFor(isBulkModeReply(model), 800)) return { model, identity, how: 'probe' };
  }
  return { model: null, identity, how: null };
}

// Turns bulk mode on and confirms the device actually entered it.
// Returns true when confirmed, false when the device answered "off" or not
// at all (it's on a screen that refuses data transfer).
export async function enterBulkMode(io, model) {
  await io.send(bulkModeSet(model, true));
  await io.sleep(100);
  await io.send(bulkModeRequest(model));
  const reply = await io.waitFor(isBulkModeReply(model), 1500);
  return !!reply && reply[7] === 1;
}

// Like list requests, an OFF sent right after the device's last reply is
// ignored (seen on a real QY100: OFF sent 3.5ms after the final list page
// left it stuck on "Now Bulk Mode"). So wait first, then read the state
// back and resend OFF while it still reads ON. `verify` needs a MIDI In;
// without one the OFF is just sent after the wait.
export async function exitBulkMode(io, model, { verify = true } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await io.sleep(attempt ? 400 : 200);
    await io.send(bulkModeSet(model, false));
    if (!verify) return true;
    await io.sleep(100);
    await io.send(bulkModeRequest(model));
    const reply = await io.waitFor(isBulkModeReply(model), 1000);
    if (!reply || reply[7] === 0) return true;
  }
  return false;
}

// Reads the device's song and user style memory list. Entries are
// { number, name, size } with size in tenths of a percent of memory; an
// empty slot has size 0. freeTenths is what's left (FUN_0040d610).
export async function readMemoryList(io, model) {
  const p = P(model) | 0x05;
  const songs = await requestListPage(io, [p, 0x00, 0x00], 20);
  if (!songs) throw new Error('The song list could not be received.');
  const styles = [];
  for (const page of [0x00, 0x01]) {
    const entries = await requestListPage(io, [p, 0x01, page], 32);
    if (!entries) throw new Error('The user style list could not be received.');
    styles.push(...entries);
  }
  styles.forEach((s, k) => { s.number = k + 1; });
  const used = [...songs, ...styles].reduce((sum, e) => sum + e.size, 0);
  return { songs, styles, freeTenths: Math.max(0, 1000 - used) };
}

// The device ignores a list request that arrives too soon after its
// previous reply (seen on a real QY100: the style list request sent 1ms
// after the song list arrived got no answer), so each request waits first,
// as the Data Filer does (100-200ms), and is retried once. Replies are
// matched on kind and list only, not the page byte - the Data Filer
// doesn't check it either.
async function requestListPage(io, address, count) {
  let reply = null;
  for (let attempt = 0; attempt < 2 && !reply; attempt++) {
    await io.sleep(attempt ? 500 : 200);
    await io.send([0xf0, 0x43, 0x20, MODEL_ID_QY, ...address, 0xf7]);
    reply = await io.waitFor((m) => isQy(m, 0x00) && m[6] === address[0] && m[7] === address[1] && m.length >= 9 + count * 16, 3000);
  }
  if (!reply) return null;
  const entries = [];
  for (let k = 0; k < count; k++) {
    const e = reply.slice(9 + k * 16, 9 + (k + 1) * 16);
    entries.push({
      number: k + 1,
      name: String.fromCharCode(...e.slice(0, 8)).replace(/\0/g, ' ').trimEnd(),
      size: (e[8] << 7) | e[9],
    });
  }
  return entries;
}

// kind: 'song' or 'style'; number: 1-based slot.
export function buildClearCommand(model, kind, number) {
  return [0xf0, 0x43, 0x10, MODEL_ID_QY, P(model) | 0x08, kind === 'song' ? 0x00 : 0x01, 0x00, (number - 1) & 0x7f, 0xf7];
}

export const formatTenths = (tenths) => `${Math.floor(tenths / 10)}.${tenths % 10}%`;
