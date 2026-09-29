// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// "Transmit as controller": the channel-message equivalents (CC, NRPN, RPN,
// Program Change) of the XG Multi Part and Drum Setup parameters. Taken from
// qy100-toolkit's qy100-remote-transmission-mapping/xg_controller_equivalents.json,
// which cites the QY100 Data List's receive list (pp. 42-43) and NRPN/RPN
// tables (pp. 47-48). Everything not listed here (effects, System, Detune,
// Note Limits, controller routing depths...) has no channel-message form and
// always goes out as SysEx.

// Keyed by Multi Part address offset (08 nn <offset>).
const MULTI_PART = {
  0x01: { type: 'bankProgram' }, // Bank Select MSB -> CC 0
  0x02: { type: 'bankProgram' }, // Bank Select LSB -> CC 32
  0x03: { type: 'bankProgram' }, // Program Number -> Program Change
  0x0b: { type: 'cc', cc: 7 },
  // XG Pan 0 means Random, which CC 10 can't express (0 is hard left there).
  0x0e: { type: 'cc', cc: 10, sysexWhen: (v) => v === 0 },
  0x12: { type: 'cc', cc: 93 },
  0x13: { type: 'cc', cc: 91 },
  0x14: { type: 'cc', cc: 94 },
  0x15: { type: 'nrpn', msb: 0x01, lsb: 0x08 },
  0x16: { type: 'nrpn', msb: 0x01, lsb: 0x09 },
  0x17: { type: 'nrpn', msb: 0x01, lsb: 0x0a },
  0x18: { type: 'cc', cc: 74 },
  0x19: { type: 'cc', cc: 71 },
  0x1a: { type: 'cc', cc: 73 },
  0x1b: { type: 'nrpn', msb: 0x01, lsb: 0x64 },
  0x1c: { type: 'cc', cc: 72 },
  // XG runs 28..58 around 40 (-24..+24 semitones); RPN 00 00 only takes
  // 0..24, so a negative range still needs SysEx.
  0x23: { type: 'rpn', msb: 0x00, lsb: 0x00, convert: (v) => v - 0x40, sysexWhen: (v) => v < 0x40 },
  0x67: { type: 'cc', cc: 65, convert: (v) => (v ? 127 : 0) },
  0x68: { type: 'cc', cc: 5 },
};

// Keyed by Drum Setup address offset (3n rr <offset>); NRPN LSB is the note.
const DRUM_SETUP = {
  0x00: 0x18, // Pitch Coarse
  0x01: 0x19, // Pitch Fine
  0x02: 0x1a, // Level
  0x04: 0x1c, // Pan (0 = Random, SysEx only)
  0x05: 0x1d, // Reverb Send
  0x06: 0x1e, // Chorus Send
  0x07: 0x1f, // Variation Send
  0x0b: 0x14, // Filter Cutoff
  0x0c: 0x15, // Filter Resonance
  0x0d: 0x16, // EG Attack
  0x0e: 0x17, // EG Decay 1
};

function sectionKind(section) {
  if (section.addressBase[0] === 0x08) return 'multiPart';
  if (section.addressBase[0] === 'drumHigh') return 'drumSetup';
  return null;
}

// The controller form of one parameter row, or null when it only exists as
// SysEx. Multi-byte and nibble-packed rows never have one.
export function controllerFor(section, row) {
  if (row.size !== 1 || row.encoding === 'nibble') return null;
  const kind = sectionKind(section);
  if (kind === 'multiPart') return MULTI_PART[row.offset] ?? null;
  if (kind === 'drumSetup') {
    const msb = DRUM_SETUP[row.offset];
    if (msb === undefined) return null;
    return { type: 'nrpn', msb, lsbIsNote: true, sysexWhen: row.offset === 0x04 ? (v) => v === 0 : undefined };
  }
  return null;
}

const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');

// Short label for a row's tooltip/badge, e.g. "CC 74" or "NRPN 01 64".
export function controllerLabel(desc) {
  if (!desc) return '';
  if (desc.type === 'cc') return `CC ${desc.cc}`;
  if (desc.type === 'bankProgram') return 'Bank Select + Program Change';
  if (desc.type === 'rpn') return `RPN ${hex(desc.msb)} ${hex(desc.lsb)}`;
  return `NRPN ${hex(desc.msb)} ${desc.lsbIsNote ? 'note' : hex(desc.lsb)}`;
}

// Closes a parameter number selection so a later stray Data Entry (a
// hardware slider, a recorded track) can't keep editing it.
function nullRpn(status) {
  return [new Uint8Array([status, 0x65, 0x7f]), new Uint8Array([status, 0x64, 0x7f])];
}

// The channel messages for one value, or null if this value can't be
// expressed that way (the caller falls back to SysEx). `bankProgram` is the
// part's full {msb, lsb, program} with the changed byte already applied,
// since a Bank Select only takes effect on the next Program Change.
export function buildControllerMessages(desc, channel, value, { note, bankProgram } = {}) {
  if (desc.sysexWhen?.(value)) return null;
  const status = 0xb0 | channel;
  const v = (desc.convert ? desc.convert(value) : value) & 0x7f;
  switch (desc.type) {
    case 'cc':
      return [new Uint8Array([status, desc.cc, v])];
    case 'bankProgram':
      if (!bankProgram) return null;
      return [
        new Uint8Array([status, 0, bankProgram.msb & 0x7f]),
        new Uint8Array([status, 32, bankProgram.lsb & 0x7f]),
        new Uint8Array([0xc0 | channel, bankProgram.program & 0x7f]),
      ];
    case 'nrpn':
    case 'rpn': {
      const [selMsb, selLsb] = desc.type === 'nrpn' ? [0x63, 0x62] : [0x65, 0x64];
      const lsb = desc.lsbIsNote ? note : desc.lsb;
      if (lsb === undefined || lsb === null) return null;
      return [
        new Uint8Array([status, selMsb, desc.msb]),
        new Uint8Array([status, selLsb, lsb & 0x7f]),
        new Uint8Array([status, 0x06, v]),
        ...nullRpn(status),
      ];
    }
    default:
      return null;
  }
}
