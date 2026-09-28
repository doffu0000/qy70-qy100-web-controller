// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// Working with QY Song/Pattern Bulk Dump data that's already in hand (a
// loaded .syx, an original Data Filer .blk, or a pull): listing what's in
// it, copying one song or pattern into another slot (or across models),
// and exporting a song as a Standard MIDI File. Behavior mirrors Yamaha's
// QY100 Data Filer (QY100.exe, decompiled with Ghidra; function names
// below refer to that binary):
//
//   FUN_0040f210  "Send QY Data > One Song/One Pattern": picks that item's
//                 blocks out of a bulk file and sends them to another slot
//   FUN_0040eb80  .blk loader: 0x560-byte header, then one SysEx per
//                 208-byte record
//   FUN_00405500  song -> SMF (format 0, 480 PPQ), with FUN_00406c00 /
//                 FUN_004071e0 adding the optional "XG voice data header"
//                 measure built from the song's info record (track 7F)
//
// A block frame is F0 43 00 5F cc cc AH AM AL <7-bit data> sum F7, where
// AH's low nibble is the data kind (1 song, 2 pattern, 3 setup, 5 lists)
// and its 0x10 bit is the model (set = QY100, clear = QY70), AM is the
// song/pattern number (7E = "currently selected"), AL is the track.

import { MODEL_ID_QY, checksum, buildQyBulkModeOn, buildQyBulkModeOff } from './sysex.js';

export const QY_KIND_SONG = 1;
export const QY_KIND_PATTERN = 2;
export const QY_CURRENT_SLOT = 0x7e;

// --------------------------------------------------------------- messages

export function splitSysex(bytes) {
  const out = [];
  let start = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xf0) start = i;
    else if (bytes[i] === 0xf7 && start !== -1) {
      out.push(bytes.slice(start, i + 1));
      start = -1;
    }
  }
  return out;
}

export function isQyDataBlock(m) {
  return m.length >= 12 && m[0] === 0xf0 && m[1] === 0x43 && m[2] === 0x00 && m[3] === MODEL_ID_QY;
}

export const blockKind = (m) => m[6] & 0x0f;
export const blockModel = (m) => (m[6] & 0x10 ? 'QY100' : 'QY70');

// 147 seven-bit values -> 128 bytes (one continuous MSB-first bit stream).
export function unpackQyBlock(m) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 9; i < m.length - 2; i++) {
    acc = ((acc << 7) | (m[i] & 0x7f)) & 0x3fff;
    bits += 7;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

// Rewrites a data block's model bit and slot number, fixing its checksum.
export function retargetBlock(m, model, slot) {
  const r = Uint8Array.from(m);
  r[6] = (r[6] & 0x0f) | (model === 'QY70' ? 0x00 : 0x10);
  r[7] = slot & 0x7f;
  r[r.length - 2] = checksum(Array.from(r.slice(4, -2)));
  return r;
}

// --------------------------------------------------------------- .blk files

// Original Data Filer bulk file: a 0x560-byte header (its song/style name
// list), then fixed 208-byte records each holding one SysEx message.
export function isDataFilerBulkFile(name, bytes) {
  return /\.blk$/i.test(name) && bytes.length > 0x560;
}

export function extractBulkFileMessages(bytes) {
  const out = [];
  for (let off = 0x560; off + 1 < bytes.length; off += 0xd0) {
    const rec = bytes.slice(off, Math.min(bytes.length, off + 0xd0));
    const end = rec.indexOf(0xf7);
    if (rec[0] === 0xf0 && end > 0) out.push(rec.slice(0, end + 1));
  }
  return out;
}

// --------------------------------------------------------------- contents

// Every song/pattern a dump holds: [{ kind, number (1-based, or 'current'),
// model, name }]. Song names come from each song's info record.
export function listDumpItems(messages) {
  const items = new Map();
  for (const m of messages) {
    if (!isQyDataBlock(m)) continue;
    const kind = blockKind(m);
    if (kind !== QY_KIND_SONG && kind !== QY_KIND_PATTERN) continue;
    const key = `${kind}:${m[7]}`;
    if (!items.has(key)) {
      items.set(key, {
        kind,
        slot: m[7],
        number: m[7] === QY_CURRENT_SLOT ? 'current' : m[7] + 1,
        model: blockModel(m),
        name: null,
      });
    }
  }
  for (const item of items.values()) {
    if (item.kind !== QY_KIND_SONG) continue;
    const info = collectTrack(messages, QY_KIND_SONG, item.slot, 0x7f);
    if (info.length >= 0x12) item.name = String.fromCharCode(...info.slice(0x0a, 0x12)).replace(/\0/g, ' ').trim() || null;
  }
  return [...items.values()].sort((a, b) => a.kind - b.kind || a.slot - b.slot);
}

export function itemLabel(item) {
  const what = item.kind === QY_KIND_SONG ? 'Song' : 'Pattern';
  const num = typeof item.number === 'number' ? ` ${item.number}` : '';
  return `${what}${num}${item.name ? ` "${item.name}"` : ''}`;
}

function collectTrack(messages, kind, slot, track) {
  const bytes = [];
  for (const m of messages) {
    if (isQyDataBlock(m) && blockKind(m) === kind && m[7] === slot && m[8] === track) bytes.push(...unpackQyBlock(m));
  }
  return bytes;
}

// The complete message list for writing one song/pattern from a dump into
// `targetNumber` (1-based) on `model`, bracketed by bulk mode on/off.
export function buildItemTransfer(messages, item, model, targetNumber) {
  const blocks = messages.filter((m) => isQyDataBlock(m) && blockKind(m) === item.kind && m[7] === item.slot);
  return [
    buildQyBulkModeOn(model),
    ...blocks.map((m) => retargetBlock(m, model, targetNumber - 1)),
    buildQyBulkModeOff(model),
  ];
}

// --------------------------------------------------------------- song decode

// Decodes one QY track into { tick, bytes } MIDI events on `channel`
// (the inverse of the Data Filer's SMF import encoder). Returns
// { events, complete } where complete is false if an unknown byte cut the
// track short.
function decodeTrack(data, channel) {
  const events = [];
  let i = 0;
  let t = 0;
  const ev = (bytes) => events.push({ tick: t, bytes });
  while (i < data.length) {
    const c = data[i];
    if (c === 0xf0) { i += 2; continue; }
    if (c === 0xf2) return { events, complete: true };
    if (c >= 0x80 && c < 0xa0) { t += c & 0x1f; i += 1; continue; }
    if (c >= 0xa0 && c < 0xc0) { t += ((c & 0x1f) << 7) | data[i + 1]; i += 2; continue; }
    if (c >= 0xc0 && c < 0xf0) {
      let gate;
      if (c < 0xd0) { gate = c & 0x0f; i += 1; }
      else if (c < 0xe0) { gate = ((c & 0x0f) << 7) | data[i + 1]; i += 2; }
      else { gate = ((c & 0x0f) << 14) | (data[i + 1] << 7) | data[i + 2]; i += 3; }
      const note = data[i];
      const vel = data[i + 1];
      i += 2;
      events.push({ tick: t, bytes: [0x90 | channel, note, vel] });
      // A zero-length note keeps its Off after its own On (see the sort in
      // exportSongToMidi), instead of jumping ahead of it.
      events.push({ tick: t + gate, bytes: [0x80 | channel, note, 0x40], off: gate > 0 });
      continue;
    }
    switch (c) {
      case 0xfa: ev([0xa0 | channel, data[i + 1], data[i + 2]]); i += 3; break;
      case 0xfb: ev([0xb0 | channel, data[i + 1], data[i + 2]]); i += 3; break;
      case 0xfd: ev([0xd0 | channel, data[i + 1]]); i += 2; break;
      case 0xfe: ev([0xe0 | channel, data[i + 1], data[i + 2]]); i += 3; break;
      case 0xfc: {
        const [type, msb, lsb, prog] = data.slice(i + 1, i + 5);
        if (type & 1) { ev([0xb0 | channel, 0x00, msb]); ev([0xb0 | channel, 0x20, lsb]); }
        ev([0xc0 | channel, prog]);
        i += 5;
        break;
      }
      case 0xf3: {
        const [type, lsb, msb, , value] = data.slice(i + 1, i + 6);
        const nrpn = type & 1;
        ev([0xb0 | channel, nrpn ? 0x63 : 0x65, msb]);
        ev([0xb0 | channel, nrpn ? 0x62 : 0x64, lsb]);
        if (type & 0x20) ev([0xb0 | channel, 0x06, value]);
        i += 6;
        break;
      }
      case 0xf6: {
        const end = data.indexOf(0xf7, i);
        if (end < 0) return { events, complete: false };
        ev({ sysex: data.slice(i + 1, end + 1) });
        i = end + 1;
        break;
      }
      case 0xf5: ev({ tempo: data[i + 1] | (data[i + 2] << 7) }); i += 3; break;
      default: return { events, complete: false };
    }
  }
  return { events, complete: false };
}

// Time signature track: F7 <sig> events separated by Cx yy measure delays.
function decodeTimeSignatureTrack(data) {
  const out = [];
  let i = 0;
  let tick = 0;
  let num = 4;
  let den = 4;
  while (i < data.length) {
    const c = data[i];
    if (c === 0xf0) { i += 2; continue; }
    if (c === 0xf2) break;
    if (c >= 0xc0 && c < 0xd0) {
      tick += (((c & 0x0f) << 7) | data[i + 1]) * (1920 / den) * num;
      i += 2;
      continue;
    }
    if (c === 0xf7) {
      ({ num, den } = decodeTimeSigByte(data[i + 1]));
      out.push({ tick, num, den });
      i += 2;
      continue;
    }
    break;
  }
  return out;
}

function decodeTimeSigByte(b) {
  return { num: ((b >> 3) & 0x0f) + 1, den: { 4: 4, 2: 8, 1: 16 }[b & 7] ?? 4 };
}

// --------------------------------------------------------------- SMF writing

function varLen(v) {
  const out = [v & 0x7f];
  while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
  return out;
}

const tempoMeta = (bpm10) => {
  const us = Math.floor(600000000 / bpm10); // integer division, as FUN_004070f0 does
  return [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
};
const timeSigMeta = (num, den) => [0xff, 0x58, 0x04, num, Math.log2(den), 0x18, 0x08];

function eventBytes(e) {
  if (e.sysex) return [0xf0, ...varLen(e.sysex.length), ...e.sysex];
  if (e.tempo) return tempoMeta(e.tempo);
  return e.bytes;
}

function writeFormat0(events) {
  const track = [];
  let last = 0;
  for (const e of events) {
    track.push(...varLen(e.tick - last), ...eventBytes(e));
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const len = track.length;
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...track,
  ]);
}

// Exports one song from a dump as a format 0 SMF. With xgHeader, a setup
// measure (GM/XG System On plus every non-default voice/effect/drum
// setting from the song's info record) is placed before the song, exactly
// as the Data Filer's "Add XG voice data header" option does.
export function exportSongToMidi(messages, item, { xgHeader = true } = {}) {
  const tracks = [];
  for (let tr = 0; tr < 16; tr++) tracks.push(collectTrack(messages, QY_KIND_SONG, item.slot, tr));
  const info = collectTrack(messages, QY_KIND_SONG, item.slot, 0x7f);
  const tempoTrack = decodeTrack(collectTrack(messages, QY_KIND_SONG, item.slot, 0x1b), 0).events.filter((e) => e.bytes.tempo);
  const sigs = decodeTimeSignatureTrack(collectTrack(messages, QY_KIND_SONG, item.slot, 0x1c));
  if (info.length < 0x28e) throw new Error('This song has no info record (track 7F), so it cannot be exported.');

  const songEvents = [];
  const incomplete = [];
  tracks.forEach((data, ch) => {
    if (!data.length) return;
    const { events, complete } = decodeTrack(data, ch);
    if (!complete) incomplete.push(ch + 1);
    events.forEach((e, k) => songEvents.push({ ...e, order: ch * 1e6 + k }));
  });

  const bpm10 = (info[0] << 8) | info[1];
  const infoSig = decodeTimeSigByte(info[0x19]);
  const name = String.fromCharCode(...info.slice(0x0a, 0x12)).replace(/\0.*$/, '').trimEnd();
  const nameMeta = name ? [{ tick: 0, bytes: [0xff, 0x03, name.length, ...Array.from(name, (c) => c.charCodeAt(0))] }] : [];
  const meta = [];
  let offset = 0;

  if (xgHeader) {
    const { events: header, end } = buildXgHeader(info, tracks);
    offset = Math.max(1920, Math.floor((end + 480) / 480) * 480);
    meta.push({ tick: 0, bytes: tempoMeta(bpm10) }, { tick: 0, bytes: timeSigMeta(4, 4) }, ...nameMeta);
    const partialBeats = (offset % 1920) / 480;
    const lastBar = Math.floor(offset / 1920) * 1920;
    if (partialBeats) meta.push({ tick: lastBar, bytes: timeSigMeta(partialBeats, 4) });
    meta.push(...header);
    if (!sigs.some((s) => s.tick === 0)) meta.push({ tick: offset, bytes: timeSigMeta(infoSig.num, infoSig.den) });
  } else {
    if (!tempoTrack.some((e) => e.tick === 0)) meta.push({ tick: 0, bytes: tempoMeta(bpm10) });
    if (!sigs.some((s) => s.tick === 0)) meta.push({ tick: 0, bytes: timeSigMeta(infoSig.num, infoSig.den) });
    meta.push(...nameMeta);
  }

  const all = [
    ...meta.map((e, k) => ({ ...e, order: -3e6 + k })),
    ...tempoTrack.map((e, k) => ({ tick: e.tick + offset, bytes: tempoMeta(e.bytes.tempo), order: -2e6 + k })),
    ...sigs.map((s, k) => ({ tick: s.tick + offset, bytes: timeSigMeta(s.num, s.den), order: -1e6 + k })),
    ...songEvents.map((e) => ({ ...e, tick: e.tick + offset, bytes: e.bytes.sysex ? undefined : e.bytes, sysex: e.bytes.sysex })),
  ];
  // At the same tick: meta events first (name, tempo, time signature),
  // then Note Offs so a repeated note is released before it's struck
  // again, then everything else in source order.
  const rank = (e) => (e.bytes && e.bytes[0] === 0xff ? ({ 0x03: 0, 0x51: 1, 0x58: 2 }[e.bytes[1]] ?? 3) : e.off ? 4 : 5);
  all.sort((a, b) => a.tick - b.tick || rank(a) - rank(b) || a.order - b.order);
  return { midi: writeFormat0(all), name, incompleteTracks: incomplete };
}

// --------------------------------------------------------------- XG header

// Default values the Data Filer compares against, copied from QY100.exe:
// reverb/chorus rows of 16 bytes, variation rows of 16 little-endian
// words, the drum kit index by program number, the 16 editable drum note
// slots, and per-kit per-note defaults (6 bytes per note).
const REVERB_DEFAULTS_HEX =
  '00000000000000000000000000000000120a080d310000000028000332084000190a1c062e00000000280d034a074000050a10043100000000280503' +
  '400840000c0a0504260000000028000332084000090a2f0524000000002800033c084000130a10073600000000280003400640000b0a100733000000' +
  '0028020240064000190a060831000000002802034005400009050b002e1e32460728220340074000300613002c213446102814034007400003060300' +
  '221a1d3b0f28200340084000';
const CHORUS_DEFAULTS_HEX =
  '0000000000000000000000000000000006364d6a001c402e40402e400a000000083f401e001c3e2a3a402e400a000000042c406e001c402e42402e40' +
  '0a00000009204568001c402e40402e400a0001000c204000001c402e407f28440a0000001c125a02001c3e2a3c5428440a000000043f2c02001c402e' +
  '447f28440a000000081d4000001c4033427f28440a0001000e0e6802001c402e406028400a04010020111a02001c402e3c6028400a040100046d6d02' +
  '001c402e407f28400a040100';
const VARIATION_DEFAULTS_HEX =
  '000000000000000000000000000000000000000000000000000000000000000012000a0008000d003100000000000000000028000000030032000800' +
  '4000000019000a001c0006002e00000000000000000028000d0003004a0007004000000005000a001000040031000000000000000000280005000300' +
  '40000800400000000c000a000500040026000000000000000000280000000300320008004000000009000a002f000500240000000000000000002800' +
  '000003003c0008004000000013000a00100007003600000000000000000028000000030040000600400000000b000a00100007003300000000000000' +
  '0000280002000200400006004000000019000a0006000800310000000000000000002800020003004000050040000000050d8306881388134a006400' +
  '0a0000000000200000003c001c0040002e004000c409a60ea80ea60e57000a00000000000000200000003c001c0040002e004000a4065000f4065000' +
  '0a00a406f40600000000280000003c001c0040002e004000a406d6066f0001000a000000000000000000200000003c001c0040002e00400000001300' +
  '05001000400000002e00000000002000050000000a00000000000000020007000a001000400003002e00000000002000050002000a00000000000000' +
  '00000f0006000200400000002c00000000002000040003000a000000000000000100130008000300400000002f00000000002000060003000a000000' +
  '000000003f00610000003000000000000000000000004000020000000000000000000000370069000000320000000000000000000000400001000000' +
  '00000000000000002b006e000e003500000000000000000000004000000000000000000000000000060036004d006a0000001c0040002e0040004000' +
  '2e0040000a0000000000000008003f0040001e0000001c003e002a003a0040002e0040000a0000000000000004002c0040006e0000001c0040002e00' +
  '420040002e0040000a00000000000000090020004500680000001c0040002e00400040002e0040000a000000010000000c0020004000000000001c00' +
  '40002e0040007f00280044000a000000000000001c0012005a00020000001c003e002a003c005400280044000a0000000000000004003f002c000200' +
  '00001c0040002e0044007f00280044000a0000000000000008001d004000000000001c004000330042007f00280044000a000000010000000e000e00' +
  '6800020000001c0040002e0040006000280040000a00040001000000200011001a00020000001c0040002e003c006000280040000a00040001000000' +
  '04006d006d00020000001c0040002e0040007f00280040000a000400010000000c0019001000000000001c0040002e0040007f002e0040000a000000' +
  '000000005100230000000000000018003c002d0036007f00210034001e00000000000000530038000000000000001c0040002e0040007f0028004000' +
  '0a004000000000004c0050002000050000001c0040002e0040007f00280040000a0000000000000008006f004a00680000001c0040002e0040004000' +
  '06000100400000000000000008006f004a006c0000001c0040002e00400040000500010004000000000000002800140048003500300000002b004a00' +
  '0a007f007800000000000000000000001d00180044002d0037000000290048000a007f00680000000000000000000000270001003000370000000000' +
  '0000000000007f00700000000000000000000000460022003c000a0046001c002e00000000007f000000000000000000000000001c0046002e004600' +
  '000000000000000000007f00220040000a00000000000000460038002700190000001c0042002e0040007f0000000000000000000000000000000000' +
  '00000000000000000000000000000000000000000000000000000000';
const DRUM_KIT_INDEX_HEX =
  '00010203ffffffff0405ffffffffffff0607ffffffffffff08090a0b0c0dffff0e0fffffffffffff10ffffffffffffff11ffffffffffffffffffffff' +
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
  'ffffffffffffffff';
const DRUM_NOTE_SLOTS_HEX =
  '10121415161718191a1b1d1f2126282e';
const DRUM_KIT_DEFAULTS_HEX = [
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f004b00407f7f007f00407f7f007400402020007f00407f7f006600402020007f00402020005d00407f7f007f00407f7f006e00407f7f007b00407f7f006f00187f7f005b014d2020007100277f7f005c014d2020006300347f7f0060014d2020005700407f7f006300537f7f007f00457f7f007400687f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f004b00407f7f007f00407f7f007400402020007f00407f7f006600402020007f00402020005d00407f7f007f00407f7f006e00407f7f007b00407f7f006f00187f7f005b014d2020007100277f7f005c014d2020006300347f7f0060014d2020005700407f7f006300537f7f007f00457f7f007400687f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f005a00407f7f007f00407f7f006300402020007f00407f7f006600402020007f00402020005d00407f7f007f00407f7f006e00407f7f006e00407f7f006f00187f7f005b014d2020007100277f7f005c014d2020005200347f7f0060014d2020005700407f7f006300537f7f007f00457f7f007400687f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f004b00407f7f007f00407f7f007400402020007f00407f7f006600402020007f00402020005d00407f7f007f00407f7f006e00407f7f007b00407f7f006f00187f7f0065014d2020007100277f7f005c014d2020006300347f7f0065014d2020005700407f7f006300537f7f007f00457f7f007400687f7f006900227f7f007800227f7f007f002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f007f00197f7f007f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f004b00407f7f007f00407f7f007400402020007f00407f7f006600402020006f00402020005d00407f7f007f00407f7f006e00407f7f007b00407f7f007b00187f7f005b014d2020007f00277f7f005c014d2020007500347f7f0060014d2020007900407f7f007b00537f7f007f00457f7f007c005f7f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f004b00407f7f007f00407f7f007400402020007f00407f7f006600402020006f00402020005d00407f7f007f00407f7f006e00407f7f007b00407f7f007b00187f7f0064014d2020007f00277f7f005c014d2020007500347f7f006a014d2020007900407f7f007b00537f7f007f00457f7f007c005f7f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f007900407f7f007f00407f7f006f00402020007f00407f7f007f00402020007700402020005d00407f7f006e00407f7f006e00407f7f007700407f7f007b00187f7f005b014d2020007f00277f7f005c014d2020007500347f7f0060014d2020007900407f7f007b00537f7f007f00457f7f007c005f7f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f007900407f7f007f00407f7f006f00402020007f00407f7f007f00402020007700402020005d00407f7f006e00407f7f006e00407f7f007700407f7f007b00187f7f0060014d2020007f00277f7f005c014d2020007500347f7f0060014d2020007900407f7f007b00537f7f007f00457f7f007c005f7f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f006400407f7f014f00407f7f017f00403f3f007200407f7f007f00407f7f007b00402020007f00407f7f007f00402020007f00402020005d00407f7f006b00407f7f006e00407f7f006600407f7f005c00187f7f005b014d2020005e00277f7f005c014d2020006100347f7f0060014d2020005d00407f7f006600537f7f007f00457f7f006100657f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f005904157f7f005e04227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f006400407f7f014f00407f7f017f00403f3f007200407f7f007f00407f7f006f00402020007f00407f7f007b00402020007f00402020007400407f7f006b00407f7f006e00407f7f006600407f7f007f00187f7f006c014d2020007000277f7f005b014d2020006c00347f7f0060014d2020007000407f7f006d00537f7f006d00457f7f006d00657f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f005900277f7f005900197f7f007300405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006000153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f005904157f7f005e04227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f006400407f7f014f00407f7f017f00403f3f007800407f7f007f00407f7f007d00402020007f00407f7f007b00402020007f00402020007400407f7f006b00407f7f006e00407f7f006600407f7f007f00187f7f006c014d2020007000277f7f005b014d2020006c00347f7f0060014d2020007000407f7f006d00537f7f006d00457f7f006d00657f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f005900277f7f005900197f7f007300405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006000153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f005904157f7f005e04227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f006400407f7f014f00407f7f017f00403f3f007800407f7f007f00407f7f007d00402020007f00407f7f007b00402020007f00402020007400407f7f006b00407f7f006e00407f7f006f00407f7f007f00187f7f0044014d2020007000277f7f005b014d2020006c00347f7f003a014d2020007000407f7f006d00537f7f006d00457f7f006d00657f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f005900277f7f005900197f7f007300405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006000153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f005904157f7f005e04227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f006a00407f7f007f00407f7f005e00402020007f00407f7f006100402020006500402020005d00407f7f007f00407f7f006e00407f7f007b00407f7f006f00187f7f004a014d2020007100277f7f004f014d2020005200347f7f0049014d2020005700407f7f006300537f7f007f00457f7f007400687f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f006400407f7f007f00407f7f007400402020006400407f7f006600402020007f00402020005d00407f7f007f00407f7f006e00407f7f007f00407f7f006f00187f7f0057014d2020007100277f7f0054014d2020005200347f7f0040014d2020005700407f7f006300537f7f007f00457f7f007400687f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f004b00407f7f007f00407f7f007400402020007f00407f7f006600402020007800402020005d00407f7f007f00407f7f006e00407f7f007b00407f7f007100187f7f005b014d2020007a00277f7f005c014d2020007000347f7f0060014d2020007f00407f7f006e00537f7f007f00457f7f007400687f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f004b00407f7f007f00407f7f007400402020007f00407f7f006600402020007800402020005d00407f7f007f00407f7f006e00407f7f007b00407f7f007100187f7f005b014d2020007a00277f7f005c014d2020007000347f7f0060014d2020007f00407f7f006e00537f7f007f00457f7f007400687f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f005500407f7f007f00407f7f007400402020007f00407f7f006600402020007500402020005d00407f7f005400407f7f006e00407f7f004a00407f7f007f00187f7f005b014d2020007f00277f7f005c014d2020007f00347f7f0060014d2020007f00407f7f007800537f7f007f00457f7f007a00687f7f006900227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006e002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
  '6603335f5f007903335f5f003f00337f7f007f00337f7f005d04343f3f007404343f3f007f00404b00007f00407f7f005e00403f3f006200403f3f005c00407f7f007700407f7f003100407f7f002f00407f7f013400407f7f002d00407f7f014f00407f7f017f00403f3f004b00407f7f007f00407f7f007400402020007f00407f7f007f00402020007f00402020005d00407f7f004f00407f7f006e00407f7f004f00407f7f007100187f7f005b014d2020007a00277f7f005c014d2020007000347f7f0060014d2020007f00407f7f006e00537f7f007b00407f7f007400687f7f007c00227f7f007800227f7f006b002e7f7f007400403f3f007f00407f7f0076004d3f3f007f00337f7f006a00197f7f006a002e7f7f006e006e5f5f0057006e5f5f004900277f7f005900197f7f006f00405f5f005b00407f7f005f00407f7f006c00226464006c00226464005a001c3f3f006300153f3f006700657f7f016e00657f7f017c005f3f3f006a006e3f3f015800405f5f006b00685f5f006000685f5f006100157f7f006b00227f7f007f02195f5f007f02197f7f006a00533f3f007b00697f7f004400407f7f00',
];

const hexBytes = (h) => h.match(/../g).map((x) => parseInt(x, 16));
let xgTables = null;
function tables() {
  if (!xgTables) {
    const variation = hexBytes(VARIATION_DEFAULTS_HEX);
    xgTables = {
      reverb: hexBytes(REVERB_DEFAULTS_HEX),
      chorus: hexBytes(CHORUS_DEFAULTS_HEX),
      variation: Array.from({ length: variation.length / 2 }, (_, k) => variation[2 * k] | (variation[2 * k + 1] << 8)),
      kitIndex: hexBytes(DRUM_KIT_INDEX_HEX),
      noteSlots: hexBytes(DRUM_NOTE_SLOTS_HEX),
      kits: DRUM_KIT_DEFAULTS_HEX.map(hexBytes),
    };
  }
  return xgTables;
}

// Effect type (MSB, LSB) -> row of the default tables (FUN_004111f0,
// FUN_004112b0, FUN_004113e0).
function reverbRow(msb, lsb) {
  switch (msb) {
    case 1: return lsb === 1 ? 2 : 1;
    case 2: return lsb === 1 ? 4 : lsb === 2 ? 5 : 3;
    case 3: return lsb === 1 ? 7 : 6;
    case 4: return 8;
    case 0x10: return 9;
    case 0x11: return 10;
    case 0x13: return 11;
    default: return 0;
  }
}

function chorusRow(msb, lsb) {
  const sub = { 1: 1, 2: 2, 8: 3 }[lsb] ?? 0;
  if (msb === 0x41) return 1 + sub;
  if (msb === 0x42) return 5 + sub;
  if (msb === 0x43) return lsb === 1 ? 10 : lsb === 8 ? 11 : 9;
  return 0;
}

function variationRow(msb, lsb, variationConnection) {
  const fixed = { 0: 0, 4: 8, 5: 9, 6: 10, 7: 0xb, 8: 0xc, 0x0a: 0xf, 0x0b: 0x10, 0x40: 0x2b, 0x44: 0x1f, 0x45: 0x20, 0x46: 0x21, 0x47: 0x22, 0x49: 0x25, 0x4a: 0x26, 0x4b: 0x27, 0x4c: 0x28, 0x4d: 0x29, 0x4e: 0x2a };
  if (msb in fixed) return fixed[msb];
  switch (msb) {
    case 1: return lsb === 1 ? 2 : 1;
    case 2: return lsb === 1 ? 4 : lsb === 2 ? 5 : 3;
    case 3: return lsb === 1 ? 7 : 6;
    case 9: return lsb === 1 ? 0xe : 0xd;
    case 0x14: return lsb === 1 ? 0x12 : lsb === 2 ? 0x13 : 0x11;
    case 0x41: return 0x14 + ({ 1: 1, 2: 2, 8: 3 }[lsb] ?? 0);
    case 0x42: return 0x18 + ({ 1: 1, 2: 2, 8: 3 }[lsb] ?? 0);
    case 0x43: return lsb === 1 ? 0x1d : lsb === 8 ? 0x1e : 0x1c;
    case 0x48: return lsb === 0 ? 0x23 : lsb === 8 ? 0x24 : 0x23;
    default: return msb > 0x4e ? 0x2b : variationConnection !== 0 ? 0 : 0x2b;
  }
}

// Builds the setup-measure events (FUN_004071e0 and helpers). `tracks`
// decides which parts get per-part settings (only parts with data).
function buildXgHeader(info, tracks) {
  const T = tables();
  const events = [];
  let t = 0;
  const sx = (tick, body) => events.push({ tick, sysex: [...body, 0xf7] });
  const xg = (tick, hi, mid, lo, ...data) => sx(tick, [0x43, 0x10, 0x4c, hi, mid, lo, ...data]);
  const cc = (tick, ch, n, v) => events.push({ tick, bytes: [0xb0 | ch, n, v & 0x7f] });

  sx(0, [0x7e, 0x7f, 0x09, 0x01]); // GM System On
  t = 0x1e0;
  xg(t, 0x00, 0x00, 0x7e, 0x00); // XG System On
  t += 0x76;

  // FUN_00407350: master transpose and master volume
  if (info[0x17] !== 0x40) { t += 2; xg(t, 0x00, 0x00, 0x06, info[0x17]); }
  if (info[0x14] !== 0x7f) { t += 2; sx(t, [0x7f, 0x7f, 0x04, 0x01, 0x00, info[0x14]]); }

  // FUN_00407490: reverb / chorus / variation, only non-default values
  if (info[0x224] !== 1 || info[0x225] !== 0) { t += 2; xg(t, 2, 1, 0x00, info[0x224], info[0x225]); }
  const rRow = reverbRow(info[0x224], info[0x225]);
  for (let k = 0; k < 5; k++) if (T.reverb[rRow * 16 + k] !== info[0x226 + k]) { t += 2; xg(t, 2, 1, 2 + k, info[0x226 + k]); }
  if (info[0x22b] !== 0x41 || info[0x22c] !== 0) { t += 2; xg(t, 2, 1, 0x20, info[0x22b], info[0x22c]); }
  const cRow = chorusRow(info[0x22b], info[0x22c]);
  for (let k = 0; k < 5; k++) if (T.chorus[cRow * 16 + k] !== info[0x22d + k]) { t += 2; xg(t, 2, 1, 0x22 + k, info[0x22d + k]); }
  if (info[0x232] !== 0) { t += 2; xg(t, 2, 1, 0x2e, info[0x232]); }
  if (info[0x233] !== 5 || info[0x234] !== 0) { t += 2; xg(t, 2, 1, 0x40, info[0x233], info[0x234]); }
  const vRow = variationRow(info[0x233], info[0x234], info[0x244]);
  const word = (o) => (info[o] << 8) | info[o + 1];
  for (let k = 0; k < 5; k++) {
    const v = word(0x236 + 2 * k);
    if (T.variation[vRow * 16 + k] !== v) { t += 2; xg(t, 2, 1, 0x42 + 2 * k, (v >> 7) & 0x7f, v & 0x7f); }
  }
  const v10 = word(0x240);
  if (T.variation[vRow * 16 + 9] !== v10) { t += 2; xg(t, 2, 1, 0x54, (v10 >> 7) & 0x7f, v10 & 0x7f); }
  if (info[0x242] !== 0) { t += 2; xg(t, 2, 1, 0x58, info[0x242]); }
  if (info[0x243] !== 0) { t += 2; xg(t, 2, 1, 0x59, info[0x243]); }
  if (info[0x244] !== 0) { t += 2; xg(t, 2, 1, 0x5a, info[0x244]); }
  if (info[0x245] !== 0x7f && info[0x244] === 0) { t += 2; xg(t, 2, 1, 0x5b, info[0x245]); }

  // FUN_00407890: per-part voice and controller setup
  for (let p = 0; p < 16; p++) {
    if (!tracks[p].length) continue;
    let rpnUsed = false;
    let nrpnUsed = false;
    const mode = info[0x50 + p];
    let base = t;
    if (mode !== (p === 9 ? 2 : 0)) { xg(t + 2, 8, p, 0x07, mode); base = t + 5; }
    let msb = info[0x20 + p];
    let lsb = info[0x30 + p];
    let prog = info[0x40 + p];
    if (mode === 2) { msb = info[0x120]; lsb = 0; prog = info[0x122]; }
    else if (mode === 3) { msb = info[0x121]; lsb = 0; prog = info[0x123]; }
    cc(base + 2, p, 0x00, msb);
    cc(base + 4, p, 0x20, lsb);
    events.push({ tick: base + 6, bytes: [0xc0 | p, prog & 0x7f] });
    cc(base + 0x0b, p, 0x07, info[0x60 + p]);
    if (info[0x70 + p] === 0) xg(base + 0x0d, 8, p, 0x0e, 0);
    else cc(base + 0x0d, p, 0x0a, info[0x70 + p]);
    cc(base + 0x0f, p, 0x0b, 0x7f);
    cc(base + 0x11, p, 0x5b, info[0xa0 + p]);
    t = base + 0x13;
    cc(t, p, 0x5d, info[0x90 + p]);
    if (info[0x244] === 1) { t = base + 0x15; cc(t, p, 0x5e, info[0xb0 + p]); }
    for (const [off, n] of [[0xc0, 0x4a], [0xd0, 0x47], [0xe0, 0x49]]) {
      if (info[off + p] !== 0x40) { t += 2; cc(t, p, n, info[off + p]); }
    }
    if (info[0xf0 + p] !== 0x40) {
      cc(t + 2, p, 0x63, 1); cc(t + 4, p, 0x62, 100); t += 6; cc(t, p, 0x06, info[0xf0 + p]);
      nrpnUsed = true;
    }
    if (info[0x100 + p] !== 0x40) { t += 2; cc(t, p, 0x48, info[0x100 + p]); }
    if (info[0x110 + p] > 0x3f) {
      cc(t + 2, p, 0x65, 0); cc(t + 4, p, 0x64, 0); t += 6; cc(t, p, 0x06, info[0x110 + p] - 0x40);
      rpnUsed = true;
    }
    if (info[0x80 + p] !== 0x7f) { t += 2; xg(t, 8, p, 0x11, info[0x80 + p]); }
    if (mode === 2 || mode === 3) {
      const r = drumSetup(info, mode - 2, p, t, events, T);
      t = r.t;
      if (r.nrpnUsed) nrpnUsed = true;
    }
    if (nrpnUsed || rpnUsed) { cc(t + 2, p, 0x65, 0x7f); t += 4; cc(t, p, 0x64, 0x7f); }
  }
  return { events, end: t };
}

// FUN_00407e00: per-note drum setup edits for drum part d (0 or 1),
// compared against the selected kit's defaults.
function drumSetup(info, d, part, t, events, T) {
  const kitFlag = info[0x120 + d];
  let nrpnUsed = false;
  const nrpn = (msb, note, v) => {
    t += 2; events.push({ tick: t, bytes: [0xb0 | part, 0x63, msb] });
    t += 2; events.push({ tick: t, bytes: [0xb0 | part, 0x62, note] });
    t += 2; events.push({ tick: t, bytes: [0xb0 | part, 0x06, v & 0x7f] });
    nrpnUsed = true;
  };
  if (kitFlag !== 0x7f && kitFlag !== 0x7e) return { t, nrpnUsed };
  let kit = null;
  if (kitFlag === 0x7f) {
    const idx = T.kitIndex[info[0x122 + d]];
    kit = T.kits[idx === 0xff ? 0 : idx];
  }
  for (let k = 0; k < 16; k++) {
    const slot = T.noteSlots[k];
    const note = slot + 13;
    const o = 0x124 + d * 16 + k;
    const def = kit ? kit.slice(slot * 6, slot * 6 + 6) : [0x7f, 0, 0x40, 0x7f];
    if (info[o] !== 0x40) nrpn(0x18, note, info[o]);
    if (info[o + 0x20] !== def[0]) nrpn(0x1a, note, info[o + 0x20]);
    if (info[o + 0x40] !== def[2]) nrpn(0x1c, note, info[o + 0x40]);
    if (info[o + 0x60] !== def[3]) nrpn(0x1d, note, info[o + 0x60]);
    if (info[o + 0x80] !== 0x7f) nrpn(0x1f, note, info[o + 0x80]);
    if (info[o + 0xa0] !== 0x40) nrpn(0x14, note, info[o + 0xa0]);
    if (info[o + 0xc0] !== 0x40) nrpn(0x15, note, info[o + 0xc0]);
    if (info[o + 0xe0] !== 0x40) {
      t += 2; events.push({ tick: t, sysex: [0x43, 0x10, 0x4c, 0x30 + d, note, 0x0e, info[o + 0xe0], 0xf7] });
      t += 2; events.push({ tick: t, sysex: [0x43, 0x10, 0x4c, 0x30 + d, note, 0x0f, info[o + 0xe0], 0xf7] });
    }
  }
  return { t, nrpnUsed };
}
