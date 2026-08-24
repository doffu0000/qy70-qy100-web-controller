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

// cents: -1024.0 .. +1023.9921875 (7-bit nibble-packed as documented in Table 1-2)
export function buildMidiMasterTuning(deviceNumber, mm, ll) {
  const body = [0x30, 0x00, 0x00, mm & 0x7f, ll & 0x7f];
  const cc = checksum(body);
  return new Uint8Array([
    0xf0, YAMAHA_ID, 0x10 | (deviceNumber & 0x0f), 0x27,
    ...body, cc, 0xf7,
  ]);
}

