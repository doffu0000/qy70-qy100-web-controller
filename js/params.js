import { buildParameterChange } from './sysex.js';

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
// per byte since each byte is documented as an independently meaningful
// 7-bit value, not a single wide integer.
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

// addressBase is [high, mid, low-literal(0)] with "part"/"drumHigh"/"note"
// placeholders resolved from `context`; row.offset is added to the low byte.
export function sendParam(midiLink, deviceNumber, section, context, row, value) {
  const base = resolveAddressBase(section.addressBase, context);
  const address = [base[0], base[1], base[2] + row.offset];
  const data = row.encoding === 'nibble' ? nibblePack(value, row.size) : [value & 0x7f];
  midiLink.send(buildParameterChange(deviceNumber, address, data));
}
