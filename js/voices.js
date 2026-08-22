import { buildVoiceSelect } from './sysex.js';

const BANK_LABELS = {
  normal: 'Normal',
  sfx: 'SFX Voice',
  drum: 'Drum Kit',
  sfxkit: 'SFX Kit',
};

export async function loadVoices() {
  const res = await fetch('./data/voices.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load voices.json: ${res.status}`);
  return res.json();
}

export function bankLabel(bank) {
  return BANK_LABELS[bank] || bank;
}

export function voiceDisplayName(v) {
  return v.name || '(unnamed)';
}

// Sends Bank Select MSB/LSB + Program Change for a voice entry from voices.json.
// voices.json stores the 1-128 "Program #" as printed in the manual; the wire
// value is 0-127, so the -1 conversion happens here, once. channel === 'all'
// sends it on every one of the 16 MIDI channels.
export function selectVoice(midiLink, channel, voice) {
  const channels = channel === 'all' ? Array.from({ length: 16 }, (_, i) => i) : [channel];
  for (const ch of channels) {
    const messages = buildVoiceSelect(ch, voice.bankMsb, voice.bankLsb, voice.program - 1);
    for (const msg of messages) midiLink.send(msg);
  }
}

export function filterVoices(voices, { bank, category, search }) {
  return voices.filter((v) => {
    if (bank && v.bank !== bank) return false;
    if (category && v.category !== category) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!v.name || !v.name.toLowerCase().includes(s)) return false;
    }
    return true;
  });
}

export function categoriesFor(voices, bank) {
  const cats = new Set();
  for (const v of voices) {
    if (v.bank === bank && v.category) cats.add(v.category);
  }
  return Array.from(cats);
}
