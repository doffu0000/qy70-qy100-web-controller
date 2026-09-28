// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// Standard MIDI File -> QY Song Bulk Dump, so the Data Filer can write a
// .mid straight into a QY song slot. This replicates the conversion done
// by Yamaha's own QY100 Data Filer (QY100.exe, 2002), recovered by
// decompiling it with Ghidra - function names below refer to that binary
// for anyone re-checking the behavior:
//
//   FUN_00412130  top level: MIDI channel N -> song track N (16 tracks),
//                 tempo events -> track 0x12, time signatures -> 0x13,
//                 every SysEx merged into track 0
//   FUN_00412320  per-track event encoder (byte layout below)
//   FUN_00411eb0  8-bit -> 7-bit packing as one continuous bit stream
//   FUN_00411fb0  block frame F0 43 00 5F 01 13 <addrHigh> <song> <track>
//   send routine  tracks in order (0x10-0x13 renumbered +9 on the wire,
//                 so 0x12/0x13 go out as 1B/1C), then a 654-byte song
//                 info record as 6 blocks on track 7F
//
// Verified against a real QY dump (04BADMED): every one of its 833 blocks
// rebuilds byte-for-byte with the packing/framing here, and all of its
// tracks decode cleanly with the event layout here.

import { MODEL_ID_QY, buildQyBulkModeOn, buildQyBulkModeOff, checksum } from './sysex.js';

const QY_PPQ = 480; // the QY's clock resolution; the Data Filer rescales every file to it

// Song info record sent as track 7F: the Data Filer's built-in default
// for an imported song (address 0x442E00 in QY100.exe, its 16-bit words
// already byte-swapped to wire order). Only tempo (+0x00, BPM x 10, big
// endian), name (+0x0A, 8 chars) and time signature (+0x19) get filled in.
const INFO_TEMPLATE_HEX =
  '04b0000000000000fefe202020202020202000007f7e00407f1cff00000c00400000000000000000007f000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000' +
  '64646464646464646464646464646464404040404040404040404040404040407f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f' +
  '000000000000000000000000000000002828282828282828282828282828282800000000000000000000000000000000' +
  '404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040' +
  '404040404040404040404040404040404040404040404040404040404040404042424242424242424242424242424242' +
  '7f7f000040404040404040404040404040404040404040404040404040404040404040404f4b747f667f5d7f6e7b5b5c' +
  '60696b6e4f4b747f667f5d7f6e7b5b5c60696b6e404040404040404040404d4d4d222e2e404040404040404040404d4d' +
  '4d222e2e7f7f207f20207f7f7f7f2020207f7f7f7f7f207f20207f7f7f7f2020207f7f7f7f7f7f7f7f7f7f7f7f7f7f7f' +
  '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f40404040404040404040404040404040404040404040404040404040' +
  '404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040' +
  '40404040404040404040404040404040404040400100120a080d31410006364d6a00000500000d05068313881388004a' +
  '00200000007f000000000000000000000000000000006464646464646464646464646464646464646464646464646464' +
  '646464646464000000000000000000000000000000000000000000000000';

export function isStandardMidiFile(bytes) {
  return bytes.length >= 14 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64; // "MThd"
}

// A RIFF-wrapped MIDI file (.rmi, "RIFF....RMID" with the SMF inside its
// "data" chunk) is returned as the plain SMF inside it; anything else is
// returned unchanged. Returns null if a RIFF file holds no SMF.
export function unwrapMidiFile(bytes) {
  const tag = String.fromCharCode(...bytes.slice(0, 4));
  if (tag !== 'RIFF' || String.fromCharCode(...bytes.slice(8, 12)) !== 'RMID') return bytes;
  for (let i = 12; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x4d && bytes[i + 1] === 0x54 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) return bytes.slice(i);
  }
  return null;
}

function readVarLen(b, i) {
  let v = 0;
  for (;;) {
    const c = b[i++];
    v = (v << 7) | (c & 0x7f);
    if (!(c & 0x80)) return [v, i];
  }
}

// Flattens every track into one time-ordered list of
// { tick, seq, kind: 'chan'|'sysex'|'meta', data } at 480 PPQ.
export function parseStandardMidiFile(b) {
  if (!isStandardMidiFile(b)) throw new Error('Not a Standard MIDI File (no MThd header).');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const headerLen = dv.getUint32(4);
  const trackCount = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported.');
  const events = [];
  let seq = 0;
  let i = 8 + headerLen;
  for (let n = 0; n < trackCount && i + 8 <= b.length; n++) {
    // Skip any non-MTrk chunk, per the SMF spec.
    while (i + 8 <= b.length && !(b[i] === 0x4d && b[i + 1] === 0x54 && b[i + 2] === 0x72 && b[i + 3] === 0x6b)) {
      i += 8 + dv.getUint32(i + 4);
    }
    if (i + 8 > b.length) break;
    const end = Math.min(b.length, i + 8 + dv.getUint32(i + 4));
    let j = i + 8;
    let tick = 0;
    let status = 0;
    while (j < end) {
      let delta;
      [delta, j] = readVarLen(b, j);
      tick += delta;
      const c = b[j];
      if (c === 0xff) {
        const type = b[j + 1];
        let len;
        [len, j] = readVarLen(b, j + 2);
        events.push({ tick, seq: seq++, kind: 'meta', data: { type, bytes: b.slice(j, j + len) } });
        j += len;
      } else if (c === 0xf0 || c === 0xf7) {
        let len;
        let k;
        [len, k] = readVarLen(b, j + 1);
        if (c === 0xf0) events.push({ tick, seq: seq++, kind: 'sysex', data: b.slice(k, k + len) });
        j = k + len;
      } else {
        if (c & 0x80) { status = c; j++; }
        const n1 = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
        events.push({ tick, seq: seq++, kind: 'chan', data: [status, ...b.slice(j, j + n1)] });
        j += n1;
      }
    }
    i = end;
  }
  for (const e of events) {
    if (division !== QY_PPQ) e.tick = Math.floor((e.tick * QY_PPQ + (division >> 1)) / division);
  }
  events.sort((a, b2) => a.tick - b2.tick || a.seq - b2.seq);
  return events;
}

// Growable byte buffer that tracks the time of the last written event, so
// every event can be preceded by its delay (FUN_00412830): 80+d for d<32,
// else one or more A0+hi, lo pairs of up to 4095 clocks each.
class QyTrackWriter {
  constructor() { this.bytes = []; this.last = 0; }
  delay(tick) {
    let d = tick - this.last;
    this.last = tick;
    while (d >= 0x20) {
      const step = Math.min(d, 0xfff);
      d -= step;
      this.bytes.push(0xa0 | ((step >> 7) & 0x1f), step & 0x7f);
    }
    if (d) this.bytes.push(0x80 | d);
  }
  event(tick, bytes) { this.delay(tick); this.bytes.push(...bytes); }
}

// Encodes one song track's events (FUN_00412320). Notes are stored with
// their length (the Note On paired with its Note Off) rather than as
// on/off pairs; bank select is folded into the following program change;
// RPN/NRPN + Data Entry collapse into one 6-byte event.
function encodeTrack(events) {
  if (!events.length) return [];
  const w = new QyTrackWriter();
  w.bytes.push(0xf0, 0x00);
  const used = new Set();
  let bankMsb = null;
  let bankLsb = null;
  let rpn = [0, 0];
  let nrpn = [0, 0];
  let dataEntryMode = null;
  events.forEach((e, idx) => {
    const { tick, kind, data } = e;
    if (kind === 'sysex') {
      const body = data[data.length - 1] === 0xf7 ? data.slice(0, -1) : data;
      w.event(tick, [0xf6, ...body, 0xf7]);
      return;
    }
    if (kind === 'tempo') {
      w.event(tick, [0xf5, data & 0x7f, (data >> 7) & 0x7f]);
      return;
    }
    const type = data[0] & 0xf0;
    if (type === 0x90 && data[2] > 0) {
      for (let k = idx + 1; k < events.length; k++) {
        const o = events[k];
        if (o.kind !== 'chan' || used.has(k)) continue;
        const ot = o.data[0] & 0xf0;
        if (((ot === 0x90 && o.data[2] === 0) || ot === 0x80) && o.data[1] === data[1]) {
          used.add(k);
          const gate = o.tick - tick;
          let head;
          if (gate < 0x10) head = [0xc0 | gate];
          else if (gate < 0x800) head = [0xd0 | ((gate >> 7) & 0xf), gate & 0x7f];
          else head = [0xe0 | ((gate >> 14) & 0xf), (gate >> 7) & 0x7f, gate & 0x7f];
          w.event(tick, [...head, data[1], data[2]]);
          break;
        }
      }
      return; // a Note On that never ends is dropped, same as the Data Filer
    }
    if (type === 0x80 || type === 0x90) return; // Note Offs are folded into their notes
    if (type === 0xa0) { w.event(tick, [0xfa, data[1], data[2]]); return; }
    if (type === 0xd0) { w.event(tick, [0xfd, data[1]]); return; }
    if (type === 0xe0) { w.event(tick, [0xfe, data[1] & 0x7f, data[2] & 0x7f]); return; }
    if (type === 0xc0) {
      if (bankMsb !== null && bankLsb !== null) {
        w.event(tick, [0xfc, 1, bankMsb, bankLsb, data[1]]);
      } else {
        if (bankMsb !== null) w.event(tick, [0xfb, 0x00, bankMsb]);
        else if (bankLsb !== null) w.event(tick, [0xfb, 0x20, bankLsb]);
        w.event(tick, [0xfc, 0, 0, 0, data[1]]);
      }
      bankMsb = null;
      bankLsb = null;
      return;
    }
    if (type === 0xb0) {
      const [, cc, v] = data;
      if (cc === 0x00) { bankMsb = v; return; }
      if (cc === 0x20) { bankLsb = v; return; }
      if (cc === 0x65 || cc === 0x64) {
        rpn[cc === 0x65 ? 0 : 1] = v;
        dataEntryMode = 'rpn';
        if (cc === 0x64 && v === 0x7f) { w.event(tick, [0xf3, 0x00, 0x7f, 0x7f, 0, 0]); dataEntryMode = null; }
        return;
      }
      if (cc === 0x63 || cc === 0x62) {
        nrpn[cc === 0x63 ? 0 : 1] = v;
        dataEntryMode = 'nrpn';
        if (cc === 0x62 && v === 0x7f) { w.event(tick, [0xf3, 0x01, 0x7f, 0x7f, 0, 0]); dataEntryMode = null; }
        return;
      }
      if (cc === 0x06 && dataEntryMode === 'rpn') { w.event(tick, [0xf3, 0x20, rpn[1], rpn[0], 0, v]); return; }
      if (cc === 0x06 && dataEntryMode === 'nrpn') { w.event(tick, [0xf3, 0x21, nrpn[1], nrpn[0], 0, v]); return; }
      w.event(tick, [0xfb, cc, v]);
    }
  });
  w.bytes.push(0xf2); // end of track
  return w.bytes;
}

const timeSigByte = (num, den) => (((num + 0x1f) & 0xf) << 3) | ((16 / den) & 7);

// Time signature track (FUN_00412e20 / FUN_00413020): F7 <sig> events,
// separated by C0+hi, lo delays counted in whole measures, not clocks.
function encodeTimeSignatureTrack(sigs) {
  if (!sigs.length) return [];
  const bytes = [0xf0, 0x00];
  let last = 0;
  let num = 4;
  let den = 4;
  for (const s of sigs) {
    if (s.tick) {
      const measures = Math.floor((s.tick - last) / ((1920 / den) * num));
      if (measures) {
        bytes.push(0xc0 | ((measures >> 7) & 0xf), measures & 0x7f);
        last = s.tick;
      }
    }
    bytes.push(0xf7, timeSigByte(s.num, s.den));
    num = s.num;
    den = s.den;
  }
  bytes.push(0xf2);
  return bytes;
}

// 128 bytes -> 147 seven-bit values, packed as one MSB-first bit stream.
function packQyBlock(block) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const x of block) {
    acc = ((acc << 8) | x) & 0x7fff;
    bits += 8;
    while (bits >= 7) {
      bits -= 7;
      out.push((acc >> bits) & 0x7f);
    }
  }
  if (bits) out.push((acc << (7 - bits)) & 0x7f);
  return out;
}

function buildSongBlocks(model, songByte, wireTrack, bytes) {
  const messages = [];
  for (let k = 0; k < bytes.length; k += 128) {
    const block = new Array(128).fill(0);
    for (let m = 0; m < 128 && k + m < bytes.length; m++) block[m] = bytes[k + m];
    const body = [0x01, 0x13, model === 'QY70' ? 0x01 : 0x11, songByte & 0x7f, wireTrack, ...packQyBlock(block)];
    messages.push(new Uint8Array([0xf0, 0x43, 0x00, MODEL_ID_QY, ...body, checksum(body), 0xf7]));
  }
  return messages;
}

// songNumber: 1-20, or 'current' for whichever song is selected on the
// device (address byte 7E). Returns the complete list of SysEx messages
// to push (bulk mode on, song blocks, info record, bulk mode off), plus a
// summary for display.
export function convertMidiToQySong(midiBytes, { songNumber = 1, model = 'QY100' } = {}) {
  const events = parseStandardMidiFile(midiBytes);
  const perChannel = Array.from({ length: 16 }, () => []);
  const tempos = [];
  const sigs = [];
  let name = null;
  let tempo0 = null;
  let sig0 = null;
  for (const e of events) {
    if (e.kind === 'chan') perChannel[e.data[0] & 0x0f].push(e);
    else if (e.kind === 'sysex') perChannel[0].push(e);
    else if (e.data.type === 0x51 && e.data.bytes.length === 3) {
      const usPerQuarter = (e.data.bytes[0] << 16) | (e.data.bytes[1] << 8) | e.data.bytes[2];
      const bpm10 = Math.max(250, Math.min(3000, Math.floor(600000000 / usPerQuarter)));
      if (e.tick === 0 && tempo0 === null) tempo0 = bpm10;
      tempos.push({ tick: e.tick, kind: 'tempo', data: bpm10 });
    } else if (e.data.type === 0x58 && e.data.bytes.length >= 2) {
      const num = e.data.bytes[0];
      const den = 2 ** e.data.bytes[1];
      if (e.tick === 0 && sig0 === null) sig0 = { num, den };
      if (!(e.tick === 0 && num === 4 && den === 4)) sigs.push({ tick: e.tick, num, den });
    } else if (e.data.type === 0x03 && name === null) {
      name = String.fromCharCode(...e.data.bytes);
    }
  }

  const tracks = new Map();
  perChannel.forEach((evs, ch) => tracks.set(ch, encodeTrack(evs)));
  tracks.set(0x1b, encodeTrack(tempos));
  tracks.set(0x1c, encodeTimeSignatureTrack(sigs));

  const info = INFO_TEMPLATE_HEX.match(/../g).map((h) => parseInt(h, 16));
  const t10 = tempo0 ?? 1200;
  info[0] = (t10 >> 8) & 0xff;
  info[1] = t10 & 0xff;
  const { num, den } = sig0 ?? { num: 4, den: 4 };
  info[0x19] = (((num + 0x1f) & 0xf) << 3) | ({ 4: 4, 8: 2, 16: 1 }[den] ?? 4);
  if (name) {
    const clean = name.slice(0, 8).padEnd(8, ' ');
    for (let k = 0; k < 8; k++) {
      const c = clean.charCodeAt(k);
      info[0x0a + k] = c >= 0x20 && c <= 0x7f ? c : 0x23; // '#', as the Data Filer does
    }
  }

  const songByte = songNumber === 'current' ? 0x7e : songNumber - 1;
  const messages = [buildQyBulkModeOn(model)];
  let noteCount = 0;
  let usedTracks = 0;
  for (const [wireTrack, bytes] of tracks) {
    if (!bytes.length) continue;
    if (wireTrack < 16) usedTracks++;
    messages.push(...buildSongBlocks(model, songByte, wireTrack, bytes));
  }
  for (const evs of perChannel) noteCount += evs.filter((e) => e.kind === 'chan' && (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0).length;
  messages.push(...buildSongBlocks(model, songByte, 0x7f, info));
  messages.push(buildQyBulkModeOff(model));
  return { messages, name, usedTracks, noteCount, tempo: t10 / 10 };
}
