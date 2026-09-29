// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// Whole-device backup files: the QY100's SmartMedia ".Q1A" and the PC Data
// Filer's ".BLK", both converted to and from the Bulk Dump blocks an All
// Data pull returns. Layouts follow the qyTools SysEx datasheet (Max
// Coppola, sections 9.2 to 9.6; facts only, none of its AGPL code) and were
// checked against real files: three .Q1A backups round-trip byte for byte,
// .Q1S/.Q1P bodies equal their paired .syx dumps unpacked, the ALL section
// is the setup block (13 00) and the EFF section is the 23 effect blocks
// (16 00..16 16), each unpacked and zero padded to 128 bytes.

import { MODEL_ID_QY, checksum } from './sysex.js';
import { isQyDataBlock, blockKind, unpackQyBlock, listDumpItems, QY_KIND_SONG, QY_KIND_PATTERN } from './qysong.js';
import { packQyBlock } from './smf.js';

export const QY_KIND_SETUP = 3;
export const QY_KIND_EFFECT = 6;

const CHUNK = 128;
const PATTERN_TRAILER = 0x7f;
const SONG_INFO_TRACK = 0x7f;
const SONG_INFO_BLOCKS = 6;
const PATTERN_TRAILER_BLOCKS = 5;
// Packed byte count on the wire (sent as a 7-bit hi/lo pair, so 147 is
// "01 13"), and the real bytes each block unpacks to.
const WIRE = {
  data: { count: 147, bytes: 128 }, // songs and patterns
  [QY_KIND_EFFECT]: { count: 144, bytes: 126 },
  [QY_KIND_SETUP]: { count: 37, bytes: 32 },
};

const pFlag = (model) => (model === 'QY70' ? 0x00 : 0x10);

function buildBlock(model, kind, mid, low, data) {
  const { count, bytes } = WIRE[kind] ?? WIRE.data;
  const raw = new Array(bytes).fill(0);
  for (let i = 0; i < bytes && i < data.length; i++) raw[i] = data[i];
  const body = [(count >> 7) & 0x7f, count & 0x7f, pFlag(model) | kind, mid & 0x7f, low & 0x7f, ...packQyBlock(raw)];
  return new Uint8Array([0xf0, 0x43, 0x00, MODEL_ID_QY, ...body, checksum(body), 0xf7]);
}

// The clear Yamaha's Data Filer sends before restoring a whole device:
// every song and pattern, plus effects on the QY100 (the QY70's 08 02 form
// leaves effects alone).
export function buildClearAllCommand(model) {
  return new Uint8Array([0xf0, 0x43, 0x10, MODEL_ID_QY, pFlag(model) | 0x08, 0x02, 0x00, 0x00, 0xf7]);
}

// Data blocks in the order the device dumps (and Data Filer restores) a
// whole memory: songs, patterns, effects, setup; each object's blocks keep
// their own order.
export function orderForRestore(messages) {
  const rank = { [QY_KIND_SONG]: 0, [QY_KIND_PATTERN]: 1, [QY_KIND_EFFECT]: 2, [QY_KIND_SETUP]: 3 };
  return messages
    .filter(isQyDataBlock)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (rank[blockKind(a.m)] ?? 4) - (rank[blockKind(b.m)] ?? 4) ||
      ((blockKind(a.m) === QY_KIND_SONG || blockKind(a.m) === QY_KIND_PATTERN) ? a.m[7] - b.m[7] : 0) || a.i - b.i)
    .map(({ m }) => m);
}

// ---------------------------------------------------------------- helpers

function ascii(text, len) {
  const out = new Array(len).fill(0x20);
  for (let i = 0; i < len && i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

function magic(name) {
  return ascii(`YQ1${name}     V1.00`, 16);
}

function blocksOf(messages, kind, slot) {
  return messages.filter((m) => isQyDataBlock(m) && blockKind(m) === kind && (slot === undefined || m[7] === slot));
}

function unpacked(m) {
  const out = new Array(CHUNK).fill(0);
  unpackQyBlock(m).forEach((b, i) => { if (i < CHUNK) out[i] = b; });
  return out;
}

// Slots present in a dump, per kind, ascending.
function slotsOf(messages, kind) {
  return [...new Set(blocksOf(messages, kind).map((m) => m[7]))].filter((s) => s < 0x7e).sort((a, b) => a - b);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Per-object track/page numbers, in order, with their block counts.
function runs(blocks) {
  const out = [];
  for (const m of blocks) {
    const last = out[out.length - 1];
    if (last && last.id === m[8]) last.count++;
    else out.push({ id: m[8], count: 1 });
  }
  return out;
}

// .Q1S metadata: a hi/lo block count per track. MIDI tracks 0-15 at 16+2t,
// the style-playback, tempo and time signature tracks (19..1C) at 48+2(t-19).
function songCountOffset(track) {
  if (track < 16) return 16 + 2 * track;
  if (track >= 0x19 && track <= 0x1c) return 48 + 2 * (track - 0x19);
  return null;
}

// ------------------------------------------------------------------- .Q1A

export function isQ1aFile(name, bytes) {
  return /\.q1a$/i.test(name) || (bytes.length >= CHUNK && String.fromCharCode(...bytes.slice(0, 6)) === 'YQ1ALL');
}

// A whole-device dump (as pulled) -> .Q1A bytes. Throws if the dump lacks
// the setup or effect blocks a .Q1A has to carry.
export function buildQ1a(messages) {
  const setup = blocksOf(messages, QY_KIND_SETUP)[0];
  const effects = blocksOf(messages, QY_KIND_EFFECT);
  if (!setup || !effects.length) throw new Error('This dump has no setup/effect data, so it cannot be saved as a .Q1A. Pull All Data from a QY100 first.');
  const parts = [];

  const all = new Array(CHUNK).fill(0);
  magic('ALL').forEach((b, i) => { all[i] = b; });
  unpackQyBlock(setup).forEach((b, i) => { if (16 + i < CHUNK) all[16 + i] = b; });
  parts.push(Uint8Array.from(all));

  const effHead = new Array(CHUNK).fill(0);
  magic('EFF').forEach((b, i) => { effHead[i] = b; });
  effHead[16] = effects.length;
  parts.push(Uint8Array.from(effHead), ...effects.map((m) => Uint8Array.from(unpacked(m))));

  for (const slot of slotsOf(messages, QY_KIND_PATTERN)) {
    const blocks = blocksOf(messages, QY_KIND_PATTERN, slot);
    const head = new Array(CHUNK).fill(0);
    magic('PAT').forEach((b, i) => { head[i] = b; });
    head[16] = slot;
    for (const { id, count } of runs(blocks)) {
      if (id === PATTERN_TRAILER || id >= 48) continue;
      head[18 + 2 * id] = (count >> 8) & 0xff;
      head[19 + 2 * id] = count & 0xff;
    }
    head[114] = 0x02;
    head[115] = 0x22;
    parts.push(Uint8Array.from(head), ...blocks.map((m) => Uint8Array.from(unpacked(m))));
  }

  for (const slot of slotsOf(messages, QY_KIND_SONG)) {
    const blocks = blocksOf(messages, QY_KIND_SONG, slot);
    const head = new Array(CHUNK).fill(0);
    magic('SNG').forEach((b, i) => { head[i] = b; });
    head[16] = slot;
    for (const { id, count } of runs(blocks)) {
      const off = songCountOffset(id);
      if (off === null) continue;
      head[16 + off] = (count >> 8) & 0xff;
      head[17 + off] = count & 0xff;
    }
    head[72] = 0x02;
    head[73] = 0x8e;
    parts.push(Uint8Array.from(head), ...blocks.map((m) => Uint8Array.from(unpacked(m))));
  }

  const end = new Array(CHUNK).fill(0);
  magic('END').forEach((b, i) => { end[i] = b; });
  parts.push(Uint8Array.from(end));
  return concat(parts);
}

// .Q1A bytes -> Bulk Dump blocks for `model`, in restore order.
export function parseQ1a(bytes, model = 'QY100') {
  const tag = (off) => String.fromCharCode(...bytes.slice(off, off + 6));
  const at = (off) => bytes.slice(off, off + CHUNK);
  if (tag(0) !== 'YQ1ALL') throw new Error('Not a .Q1A file (no YQ1ALL header).');
  const songs = [];
  const patterns = [];
  const effects = [];
  let setup = null;
  let off = 0;
  while (off + CHUNK <= bytes.length) {
    const t = tag(off);
    const head = at(off);
    off += CHUNK;
    if (t === 'YQ1ALL') {
      setup = buildBlock(model, QY_KIND_SETUP, 0, 0, head.slice(16, 16 + WIRE[QY_KIND_SETUP].bytes));
    } else if (t === 'YQ1EFF') {
      for (let k = 0; k < head[16]; k++, off += CHUNK) effects.push(buildBlock(model, QY_KIND_EFFECT, k, 0, at(off)));
    } else if (t === 'YQ1PAT') {
      const slot = head[16];
      for (let id = 0; id < 48; id++) {
        const count = (head[18 + 2 * id] << 8) | head[19 + 2 * id];
        for (let k = 0; k < count; k++, off += CHUNK) patterns.push(buildBlock(model, QY_KIND_PATTERN, slot, id, at(off)));
      }
      for (let k = 0; k < PATTERN_TRAILER_BLOCKS; k++, off += CHUNK) patterns.push(buildBlock(model, QY_KIND_PATTERN, slot, PATTERN_TRAILER, at(off)));
    } else if (t === 'YQ1SNG') {
      const slot = head[16];
      const tracks = [...Array(16).keys(), 0x19, 0x1a, 0x1b, 0x1c];
      for (const track of tracks) {
        const o = songCountOffset(track);
        const count = (head[16 + o] << 8) | head[17 + o];
        for (let k = 0; k < count; k++, off += CHUNK) songs.push(buildBlock(model, QY_KIND_SONG, slot, track, at(off)));
      }
      for (let k = 0; k < SONG_INFO_BLOCKS; k++, off += CHUNK) songs.push(buildBlock(model, QY_KIND_SONG, slot, SONG_INFO_TRACK, at(off)));
    } else if (t === 'YQ1END') {
      break;
    } else {
      throw new Error(`Unrecognized .Q1A section at byte ${off - CHUNK}.`);
    }
  }
  if (off > bytes.length) throw new Error('This .Q1A file is truncated.');
  return [...songs, ...patterns, ...effects, ...(setup ? [setup] : [])];
}

// ------------------------------------------------------------------- .BLK

const BLK_CATALOG = 0x560;
const BLK_RECORD = 0xd0;

// Catalog entry: 8-char name ('********' when empty), size as a 7-bit
// pair (equal to the object's block count), 6 zero bytes.
function catalogEntry(name, blockCount) {
  const e = new Array(16).fill(0);
  if (!blockCount) {
    ascii('********', 8).forEach((b, i) => { e[i] = b; });
    return e;
  }
  ascii(name || '', 8).forEach((b, i) => { e[i] = b; });
  e[8] = (blockCount >> 7) & 0x7f;
  e[9] = blockCount & 0x7f;
  return e;
}

// A whole-device dump -> Data Filer .BLK bytes: the 20 song + 64 pattern
// catalog, then every block (songs 1-20, patterns 1-64, then the rest) in
// its own 208-byte record, zero padded.
export function buildBlk(messages) {
  const catalog = [];
  const songNames = new Map(listDumpItems(messages).filter((i) => i.kind === QY_KIND_SONG).map((i) => [i.slot, i.name]));
  for (let s = 0; s < 20; s++) catalog.push(...catalogEntry(songNames.get(s), blocksOf(messages, QY_KIND_SONG, s).length));
  catalog.push(...new Array(16).fill(0));
  for (let p = 0; p < 64; p++) {
    const blocks = blocksOf(messages, QY_KIND_PATTERN, p);
    const trailer = blocks.find((m) => m[8] === PATTERN_TRAILER);
    const name = trailer ? String.fromCharCode(...unpackQyBlock(trailer).slice(6, 14)) : '';
    catalog.push(...catalogEntry(name, blocks.length));
  }
  catalog.push(...new Array(16).fill(0));

  const records = orderForRestore(messages).map((m) => {
    if (m.length > BLK_RECORD) throw new Error('A block is too long for a .BLK record.');
    const rec = new Uint8Array(BLK_RECORD);
    rec.set(m);
    return rec;
  });
  return concat([Uint8Array.from(catalog), ...records]);
}
