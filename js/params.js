// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

import { buildParameterChange } from './sysex.js';
import { controllerFor, buildControllerMessages } from './controllers.js';

export async function loadParameters() {
  const res = await fetch('./data/parameters.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load parameters.json: ${res.status}`);
  return res.json();
}

// Splits nibble-packed value across `size` bytes: each byte carries one
// 4-bit nibble in its low bits (bits 6-4 always 0), MSB nibble first - the
// packing scheme documented for Master Tune, Transpose-adjacent Detune, etc.
export function nibblePack(value, size) {
  const bytes = [];
  for (let i = size - 1; i >= 0; i--) {
    bytes.push((value >> (i * 4)) & 0x0f);
  }
  return bytes;
}

export function nibbleUnpack(bytes) {
  let value = 0;
  for (const b of bytes) value = (value << 4) | (b & 0x0f);
  return value;
}

// Expands a parameters.json section's `params` array into flat UI rows.
// Multi-byte non-nibble params (e.g. "Reverb Type" MSB+LSB) become one row
// per byte so each byte gets its own knob, but they're still one addressable
// unit on the wire - confirmed against real hardware output, the device
// sends/expects all bytes together in a single Parameter Change message at
// the first byte's address, not one message per byte (see sendParamGroup).
export function expandRows(params) {
  const rows = [];
  for (const p of params) {
    if (p.size > 1 && p.encoding !== 'nibble') {
      const labels = p.size === 2 ? ['MSB', 'LSB'] : Array.from({ length: p.size }, (_, i) => `byte ${i}`);
      for (let i = 0; i < p.size; i++) {
        rows.push({
          ...p,
          offset: p.offset + i,
          size: 1,
          // p.default describes the first byte only (e.g. Reverb Type's
          // documented default is MSB=1 - the basic type of whatever MSB
          // is selected always has LSB=0); later bytes default to 0
          // rather than inheriting that same raw number.
          default: i === 0 ? p.default : 0,
          name: `${p.name} (${labels[i]})`,
          key: `${p.offset}:${i}`,
        });
      }
    } else {
      // keyOffset separates rows that share an address but send different
      // data (System's Drum Setup 1/2 Reset are both 00 00 7D).
      rows.push({ ...p, key: `${p.keyOffset ?? p.offset}:0` });
    }
  }
  return rows;
}

function resolveAddressBase(addressBase, context) {
  return addressBase.map((b) => (typeof b === 'string' ? context[b] : b));
}

// Transmit as Controller: when on, rows that have a CC/NRPN/RPN/Program
// Change form go out as that channel message instead of SysEx (see
// controllers.js). The app supplies how a context maps to a MIDI channel
// (a part's Rcv Channel, a drum setup's channel) and a part's current
// Bank/Program; a row with no usable channel still falls back to SysEx.
const controllerSend = { enabled: false, resolveChannel: null, resolveBankProgram: null };

export function configureControllerSend(options) {
  Object.assign(controllerSend, options);
}

export function isControllerSendEnabled() {
  return controllerSend.enabled;
}

// context.forceSysex keeps a send part-addressed even with Send as CC/NRPN
// on: the QY70/QY100 play incoming channel messages on whichever track is
// highlighted on the device, whatever channel they arrive on, so a CC or
// Program Change meant for Part 3 lands on the highlighted part instead.
function trySendAsController(midiLink, section, context, row, value) {
  if (!controllerSend.enabled || context.forceSysex) return false;
  const desc = controllerFor(section, row);
  if (!desc) return false;
  const channel = controllerSend.resolveChannel?.(section, context);
  if (!Number.isInteger(channel) || channel < 0 || channel > 15) return false;
  let bankProgram;
  if (desc.type === 'bankProgram') {
    bankProgram = controllerSend.resolveBankProgram?.(context);
    if (!bankProgram) return false;
    bankProgram = { ...bankProgram, [{ 1: 'msb', 2: 'lsb', 3: 'program' }[row.offset]]: value };
  }
  const messages = buildControllerMessages(desc, channel, value, { note: context.note, bankProgram });
  if (!messages) return false;
  for (const m of messages) midiLink.send(m);
  return true;
}

// Channel-message sections (kind "channel" in parameters.json: CCs, Pitch
// Bend, Aftertouch, Channel Mode, RPN/NRPN) describe each row's message in
// row.msg instead of an XG address. `lookup(name)` reads another row's
// current value in the same section/channel, for messages built from
// several rows (Poly Aftertouch's note, the custom RPN/NRPN builder).
export function buildChannelMessages(msg, channel, value, lookup) {
  const status = (s) => new Uint8Array(s);
  const cc = (n, v) => status([0xb0 | channel, n, v & 0x7f]);
  const select = (isRpn, msb, lsb) => (isRpn
    ? [cc(0x65, msb), cc(0x64, lsb)]
    : [cc(0x63, msb), cc(0x62, lsb)]);
  const nullSelect = () => [cc(0x65, 0x7f), cc(0x64, 0x7f)];
  switch (msg.type) {
    case 'cc':
      return [cc(msg.cc, msg.toggle ? (value ? 127 : 0) : value)];
    case 'pb':
      return [status([0xe0 | channel, value & 0x7f, (value >> 7) & 0x7f])];
    case 'cat':
      return [status([0xd0 | channel, value & 0x7f])];
    case 'pat':
      return [status([0xa0 | channel, lookup(msg.noteFrom) & 0x7f, value & 0x7f])];
    case 'pc':
      return [status([0xc0 | channel, value & 0x7f])];
    case 'rpn':
    case 'nrpn': {
      const lsb = msg.noteFrom ? lookup(msg.noteFrom) : msg.lsb;
      const data = msg.wide
        ? [cc(0x06, value >> 7), cc(0x26, value)]
        : [cc(0x06, value)];
      // Closed with a null RPN afterwards, same as Send as CC/NRPN, so a
      // stray Data Entry later can't keep editing this parameter.
      return [...select(msg.type === 'rpn', msg.msb, lsb), ...data, ...nullSelect()];
    }
    case 'rpnNull':
      return nullSelect();
    case 'custom': {
      // Left open (no null RPN) so Data Increment/Decrement (CC 96/97)
      // can keep stepping the chosen parameter.
      const isRpn = lookup('Custom Parameter Type') === 1;
      return [
        ...select(isRpn, lookup('Custom Parameter MSB'), lookup('Custom Parameter LSB')),
        cc(msg.part === 'lsb' ? 0x26 : 0x06, value),
      ];
    }
    default:
      return [];
  }
}

// addressBase is [high, mid, low-literal(0)] with "part"/"drumHigh"/"note"
// placeholders resolved from `context`; row.offset is added to the low byte.
export function sendParam(midiLink, deviceNumber, section, context, row, value) {
  if (section.kind === 'channel') {
    // context.channel is 0-15, or 'all' for every channel at once.
    const channels = context.channel === 'all' ? [...Array(16).keys()] : [context.channel];
    for (const ch of channels) {
      for (const m of buildChannelMessages(row.msg, ch, value, context.lookup)) midiLink.send(m);
    }
    return;
  }
  if (trySendAsController(midiLink, section, context, row, value)) return;
  const base = resolveAddressBase(section.addressBase, context);
  const address = [base[0], base[1], base[2] + row.offset];
  const data = row.encoding === 'nibble' ? nibblePack(value, row.size) : [value & 0x7f];
  midiLink.send(buildParameterChange(deviceNumber, address, data));
}

// For a group of same-origin split rows (e.g. Reverb Type's MSB+LSB, or a
// Variation Param's MSB+LSB), sends all bytes together in one Parameter
// Change message addressed to the first row's offset - the device rejects
// (XG Address Error) a lone message addressed to a later byte, since that
// address only exists as part of the combined multi-byte value.
export function sendParamGroup(midiLink, deviceNumber, section, context, rows, values) {
  const base = resolveAddressBase(section.addressBase, context);
  const address = [base[0], base[1], base[2] + rows[0].offset];
  midiLink.send(buildParameterChange(deviceNumber, address, values.map((v) => v & 0x7f)));
}
