// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

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
