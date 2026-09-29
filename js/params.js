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
      rows.push({ ...p, key: `${p.offset}:0` });
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

function trySendAsController(midiLink, section, context, row, value) {
  if (!controllerSend.enabled) return false;
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

// addressBase is [high, mid, low-literal(0)] with "part"/"drumHigh"/"note"
// placeholders resolved from `context`; row.offset is added to the low byte.
export function sendParam(midiLink, deviceNumber, section, context, row, value) {
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
