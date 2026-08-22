import { MidiLink } from './midi.js';
import { buildXgSystemOn } from './sysex.js';
import { loadVoices, selectVoice, filterVoices, categoriesFor, bankLabel, voiceDisplayName } from './voices.js';
import { loadParameters, expandRows, sendParam, sendParamGroup } from './params.js';
import { createKnob, createToggle, createMultiToggle } from './knob.js';

const link = new MidiLink();
let voices = [];
let presets = [];
let selectedVoiceKey = null;
const expandedVoices = new Set();

const el = (id) => document.getElementById(id);
const inputSelect = el('input-select');
const outputSelect = el('output-select');
const channelSelect = el('channel-select');
const connectBtn = el('connect-btn');
const statusEl = el('status');
const bankSelect = el('bank-select');
const categorySelect = el('category-select');
const searchBox = el('search-box');
const voiceListEl = el('voice-list');
const logOutput = el('log-output');

// Web MIDI is Chromium-only (no Safari, historically no Firefox) - flag it
// up front instead of only surfacing an error once someone clicks Connect.
if (!navigator.requestMIDIAccess) {
  el('no-midi-banner').hidden = false;
  connectBtn.disabled = true;
}

const allChannelsOpt = document.createElement('option');
allChannelsOpt.value = 'all';
allChannelsOpt.textContent = 'All';
channelSelect.appendChild(allChannelsOpt);
for (let i = 1; i <= 16; i++) {
  const opt = document.createElement('option');
  opt.value = i - 1;
  opt.textContent = `${i}`;
  channelSelect.appendChild(opt);
}
channelSelect.value = 'all';

// Timing Clock (F8) and Active Sensing (FE) are real-time bytes a device can
// send continuously (Active Sensing every ~200ms per spec) - logging them
// would flood the panel with nothing diagnostically useful.
const TIMING_STATUS_BYTES = new Set([0xf8, 0xfe]);
const LOG_MAX_LINES = 30;
const logEnabled = el('log-enabled');
let logLines = [];

function log(direction, bytes) {
  if (!logEnabled.checked) return;
  if (bytes.length === 1 && TIMING_STATUS_BYTES.has(bytes[0])) return;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  logLines.push(`${new Date().toLocaleTimeString()} ${direction} ${hex}`);
  if (logLines.length > LOG_MAX_LINES) logLines = logLines.slice(-LOG_MAX_LINES);
  logOutput.textContent = logLines.join('\n') + '\n';
  logOutput.scrollTop = logOutput.scrollHeight;
}

const originalSend = link.send.bind(link);
link.send = (bytes) => {
  log('OUT', bytes);
  originalSend(bytes);
};
link.onMessage = (bytes) => {
  log('IN ', bytes);
  handleIncomingVoiceChange(bytes);
  handleIncomingNoteOn(bytes);
};

// MIDIAccess fires onstatechange for reasons unrelated to the user (e.g. a
// port re-announcing itself), so preserve the selected device across a
// rebuild of the <select> options instead of resetting to "(none)".
function refreshDeviceLists() {
  const inputs = link.listInputs();
  const outputs = link.listOutputs();
  const prevInput = inputSelect.value;
  const prevOutput = outputSelect.value;

  inputSelect.innerHTML = '<option value="">(none)</option>' +
    inputs.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
  outputSelect.innerHTML = '<option value="">(none)</option>' +
    outputs.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');

  if (prevInput && inputs.some((d) => d.id === prevInput)) inputSelect.value = prevInput;
  if (prevOutput && outputs.some((d) => d.id === prevOutput)) outputSelect.value = prevOutput;
}

connectBtn.addEventListener('click', async () => {
  try {
    await link.requestAccess();
    link.onDevicesChanged = refreshDeviceLists;
    refreshDeviceLists();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

inputSelect.addEventListener('change', () => {
  link.selectInput(inputSelect.value);
  statusEl.textContent = inputSelect.value ? '' : 'No MIDI input selected';
});

outputSelect.addEventListener('change', () => {
  link.selectOutput(outputSelect.value);
  statusEl.textContent = outputSelect.value ? '' : 'No MIDI output selected';
});

function currentChannel() {
  return channelSelect.value === 'all' ? 'all' : Number(channelSelect.value || 0);
}

function refreshCategoryOptions() {
  categorySelect.hidden = bankSelect.value === 'sfxkit';
  const cats = categoriesFor(voices, bankSelect.value).sort();
  categorySelect.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${c}">${c}</option>`).join('');
  categorySelect.value = '';
  el('drum-kit-hint').hidden = bankSelect.value !== 'drum' && bankSelect.value !== 'sfxkit';
}

function currentFilteredVoices() {
  const bankCategoryFiltered = filterVoices(voices, {
    bank: bankSelect.value,
    category: categorySelect.value,
  });
  const search = searchBox.value.trim().toLowerCase();
  if (!search) return bankCategoryFiltered;
  return bankCategoryFiltered.filter((v) =>
    (v.name && v.name.toLowerCase().includes(search)) ||
    presetsFor(v).some((p) => p.name.toLowerCase().includes(search)));
}

function presetsFor(v) {
  return presets.filter((p) => p.voice.bank === v.bank && p.voice.bankMsb === v.bankMsb &&
    p.voice.bankLsb === v.bankLsb && p.voice.program === v.program);
}

const ALL_PARTS = Array.from({ length: 32 }, (_, i) => i);

// Presets only override a handful of Multi Part knobs (filter/EG/effects
// sends/vibrato); picking any voice afterwards should still start from that
// voice's own defaults rather than inheriting whatever a prior preset left
// behind on the part.
function resetPresetTouchedParams(parts) {
  const section = parameters.multiPart;
  const paramNames = new Set(presets.flatMap((p) => p.params.map((row) => row.name)));
  for (const part of parts) {
    for (const name of paramNames) {
      const row = section.params.find((r) => r.name === name);
      if (row && typeof row.default === 'number') sendParam(link, 0, section, { part }, row, row.default);
    }
  }
}

// Parts 1-16 map 1:1 onto MIDI channels 1-16 in Song mode, so voice-select
// (Bank Select + Program Change) rides those same channels. Parts 17-32
// (Pattern mode's 8 tracks, plus further hidden parts) don't have a fixed
// channel - which channel reaches them depends on the device's current
// mode - so a preset always sets the sound on all 32 parts, but only
// auto-selects the voice on Parts 1-16; the rest need that voice picked on
// the device itself first.
function applyPreset(preset) {
  const voice = voices.find((v) => v.bank === preset.voice.bank && v.bankMsb === preset.voice.bankMsb &&
    v.bankLsb === preset.voice.bankLsb && v.program === preset.voice.program);
  if (!voice) return;
  resetPresetTouchedParams(ALL_PARTS);
  selectVoice(link, 'all', voice);
  const section = parameters.multiPart;
  for (const part of ALL_PARTS) {
    for (const p of preset.params) {
      const row = section.params.find((r) => r.name === p.name);
      if (row) sendParam(link, 0, section, { part }, row, p.value);
    }
  }
}

function renderVoiceList() {
  const filtered = currentFilteredVoices();
  const search = searchBox.value.trim().toLowerCase();
  voiceListEl.innerHTML = '';
  for (const v of filtered) {
    const key = `${v.bank}:${v.program}:${v.bankMsb}:${v.bankLsb}`;
    const voicePresets = presetsFor(v);
    const li = document.createElement('li');
    li.dataset.key = key;
    if (key === selectedVoiceKey) li.classList.add('selected');
    if (v.qy100Only) li.classList.add('qy100-only');
    const badge = v.qy100Only ? '<span class="qy100-badge" title="QY100 only - not present on QY70">QY100</span>' : '';
    const searchMatchesPreset = search && voicePresets.some((p) => p.name.toLowerCase().includes(search));
    const expanded = expandedVoices.has(key) || searchMatchesPreset;
    const toggle = voicePresets.length
      ? `<button type="button" class="preset-toggle" title="${voicePresets.length} preset${voicePresets.length > 1 ? 's' : ''}">${expanded ? '▾' : '▸'}</button>`
      : '<span class="preset-toggle-spacer"></span>';
    li.innerHTML = `${toggle}<span>${voiceDisplayName(v)}${badge}</span>` +
      `<span class="voice-meta">${bankLabel(v.bank)} P${v.program} B${v.bankLsb}</span>`;
    if (voicePresets.length) {
      li.querySelector('.preset-toggle').addEventListener('click', (evt) => {
        evt.stopPropagation();
        if (expandedVoices.has(key)) expandedVoices.delete(key);
        else expandedVoices.add(key);
        renderVoiceList();
      });
    }
    li.addEventListener('click', () => {
      try {
        resetPresetTouchedParams(ALL_PARTS);
        selectVoice(link, currentChannel(), v);
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
      selectedVoiceKey = key;
      renderVoiceList();
      if (v.bank === 'drum' || v.bank === 'sfxkit') {
        const kitIndex = drumKits.findIndex((k) => k.bankMsb === v.bankMsb && k.program === v.program);
        if (kitIndex !== -1) {
          sectionSelect.value = 'drumSetup';
          drumkitSelect.value = kitIndex;
          populateNoteSelect();
          renderParamPanel();
        }
      }
    });
    voiceListEl.appendChild(li);

    if (voicePresets.length && expanded) {
      for (const preset of voicePresets) {
        const presetKey = `${key}:preset:${preset.id}`;
        const presetLi = document.createElement('li');
        presetLi.className = 'preset-item';
        presetLi.dataset.key = presetKey;
        if (presetKey === selectedVoiceKey) presetLi.classList.add('selected');
        presetLi.innerHTML = `<span>${preset.name}</span>`;
        presetLi.addEventListener('click', () => {
          try {
            applyPreset(preset);
          } catch (err) {
            statusEl.textContent = `Error: ${err.message}`;
          }
          selectedVoiceKey = presetKey;
          renderVoiceList();
        });
        voiceListEl.appendChild(presetLi);
      }
    }
  }
}

bankSelect.addEventListener('change', () => { refreshCategoryOptions(); renderVoiceList(); });
categorySelect.addEventListener('change', renderVoiceList);
searchBox.addEventListener('input', renderVoiceList);

const confirmDialog = el('confirm-dialog');
const confirmDialogOk = el('confirm-dialog-ok');
const confirmDialogCancel = el('confirm-dialog-cancel');

function showConfirm(title, message) {
  return new Promise((resolve) => {
    el('confirm-dialog-title').textContent = title;
    el('confirm-dialog-message').textContent = message;
    const onOk = () => settle(true);
    const onCancel = () => settle(false);
    const onBackdropClick = (evt) => { if (evt.target === confirmDialog) settle(false); };
    function settle(result) {
      confirmDialogOk.removeEventListener('click', onOk);
      confirmDialogCancel.removeEventListener('click', onCancel);
      confirmDialog.removeEventListener('cancel', onCancel);
      confirmDialog.removeEventListener('click', onBackdropClick);
      confirmDialog.close();
      resolve(result);
    }
    confirmDialogOk.addEventListener('click', onOk);
    confirmDialogCancel.addEventListener('click', onCancel);
    confirmDialog.addEventListener('cancel', onCancel);
    confirmDialog.addEventListener('click', onBackdropClick);
    confirmDialog.showModal();
  });
}

el('xg-on-btn').addEventListener('click', async () => {
  const confirmed = await showConfirm(
    'Send XG System On?',
    "This can be done once at the start of a session (or after a power " +
    "cycle) if Parameter Change edits below aren't taking effect - the " +
    "QY100 ignores them until it receives this. It's typically not needed.\n\n" +
    'It will reset every voice on every channel to its default.'
  );
  if (!confirmed) return;
  try {
    link.send(buildXgSystemOn(0));
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

el('clear-log-btn').addEventListener('click', () => {
  logLines = [];
  logOutput.textContent = '';
});

// ---- Parameters (generic, data-driven from parameters.json) ----

let parameters = {};
let drumNotes = {};
let effectTypes = {};
const sectionSelect = el('section-select');
const partSelect = el('part-select');
const drumkitSelect = el('drumkit-select');
const noteSelect = el('note-select');
const drumSetupHint = el('drum-setup-hint');
const paramListEl = el('param-list');

async function loadDrumNotes() {
  const res = await fetch('./data/drum_notes.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load drum_notes.json: ${res.status}`);
  return res.json();
}

async function loadPresets() {
  const res = await fetch('./data/presets.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load presets.json: ${res.status}`);
  return res.json();
}

async function loadEffectTypes() {
  const res = await fetch('./data/effect_types.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load effect_types.json: ${res.status}`);
  return res.json();
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// QY70 numbers notes from C-2 (note 0), per the manual's NOTE NUMBER field.
function noteName(n) {
  const octave = Math.floor(n / 12) - 2;
  return `${NOTE_NAMES[n % 12]}${octave}`;
}

function populatePartSelect() {
  const group = (label, from, to) =>
    `<optgroup label="${label}">${Array.from({ length: to - from + 1 }, (_, i) =>
      `<option value="${from + i}">Part ${from + i + 1}</option>`).join('')}</optgroup>`;
  partSelect.innerHTML =
    group('Song Mode', 0, 15) +
    group('Pattern Mode', 16, 23) +
    group('Hidden', 24, 31);
}

let drumKits = [];

function populateDrumkitSelect() {
  drumKits = voices.filter((v) => v.bank === 'drum' || v.bank === 'sfxkit');
  drumkitSelect.innerHTML = drumKits.map((k, i) =>
    `<option value="${i}">${k.name}</option>`).join('');
}

const STANDARD_KIT_ID = '127_1';

function populateNoteSelect() {
  const [lo, hi] = parameters.drumSetup.noteRange;
  const kit = drumKits[Number(drumkitSelect.value || 0)];
  const kitId = kit ? `${kit.bankMsb}_${kit.program}` : STANDARD_KIT_ID;
  const opts = [];
  for (let n = lo; n <= hi; n++) {
    const entry = drumNotes[n];
    const name = entry && (entry[kitId] || entry[STANDARD_KIT_ID]);
    const label = name || '(no sound)';
    opts.push(`<option value="${n}">${noteName(n)} ${label}</option>`);
  }
  noteSelect.innerHTML = opts.join('');
}

// Track each channel's last Bank Select MSB/LSB (CC0/CC32) so an incoming
// Program Change can be resolved to the voice it selects, the same way
// buildVoiceSelect() sends the pair together when the app picks a voice.
const lastBankSelect = {};

// When the device itself switches to a drum or SFX kit voice (e.g. the user
// changes the track's voice in Song/Pattern mode), follow it in the Drum
// Setup kit picker so the note names shown stay in sync with what's playing.
function handleIncomingVoiceChange(bytes) {
  if (bytes.length < 2) return;
  const type = bytes[0] & 0xf0;
  const ch = bytes[0] & 0x0f;
  if (type === 0xb0 && bytes.length >= 3) {
    const state = lastBankSelect[ch] || (lastBankSelect[ch] = {});
    if (bytes[1] === 0) state.msb = bytes[2];
    else if (bytes[1] === 32) state.lsb = bytes[2];
    return;
  }
  if (type !== 0xc0) return;
  const selectedChannel = currentChannel();
  if (selectedChannel !== 'all' && ch !== selectedChannel) return;
  const state = lastBankSelect[ch];
  if (!state || state.msb === undefined) return;
  const program = bytes[1] + 1; // wire value is 0-127; voices.json uses 1-128
  const kitIndex = drumKits.findIndex((k) => k.bankMsb === state.msb && k.program === program);
  if (kitIndex === -1) return;
  sectionSelect.value = 'drumSetup';
  drumkitSelect.value = kitIndex;
  populateNoteSelect();
  renderParamPanel();
}

// While Drum Setup is open, let a note played on the device (Note On,
// velocity > 0) pick the same note in the dropdown, so editing follows
// whatever the user is actually playing on the QY100 itself.
function handleIncomingNoteOn(bytes) {
  if (sectionSelect.value !== 'drumSetup') return;
  if (bytes.length < 3 || (bytes[0] & 0xf0) !== 0x90 || bytes[2] === 0) return;
  const ch = bytes[0] & 0x0f;
  const selectedChannel = currentChannel();
  if (selectedChannel !== 'all' && ch !== selectedChannel) return;
  const note = bytes[1];
  const [lo, hi] = parameters.drumSetup.noteRange;
  if (note < lo || note > hi || String(note) === noteSelect.value) return;
  noteSelect.value = String(note);
  renderParamPanel();
}

function currentContext(sectionKey) {
  if (sectionKey === 'multiPart') {
    return { part: Number(partSelect.value || 0) };
  }
  if (sectionKey === 'drumSetup') {
    // The "3n" address high nibble only has 16 possible values (0-F), so it
    // indexes by MIDI channel rather than by kit name (there are 20+ kits) -
    // it always affects whatever kit is playing on that channel, regardless
    // of the kit name selected in the dropdown below. Channel "All" sends
    // the same edit to every one of the 16 possible addresses at once.
    const ch = currentChannel();
    return {
      drumHigh: ch === 'all' ? null : 0x30 + ch,
      allChannels: ch === 'all',
      note: Number(noteSelect.value || 0),
    };
  }
  return {};
}

// Some defaults depend on the current context rather than being a fixed
// number - e.g. Multi Part's Rcv Channel defaults to the part's own number.
function resolveDefault(row, context) {
  if (row.default === 'part') return context.part ?? 0;
  return row.default;
}

// Params that are a hard on/off flag on real hardware get a switch instead
// of a rotary knob (Reset stays the same for both).
const TOGGLE_PARAMS = new Set(['VariMode', 'Mono/Poly Mode', 'Portamento Switch']);

// Params that pick between named modes (3+ discrete states) get a
// segmented switch instead of a rotary knob; the array index is the wire
// value, so it also serves as the DYNAMIC_PARAM_DESC lookup below.
const MULTI_TOGGLE_PARAMS = {
  'Same Note Number Key On Assign': { labels: ['Single', 'Multi', 'Inst (Drum)'] },
  'Part Mode': { labels: ['Normal', 'Drum Thru', 'Drum 1', 'Drum 2'] },
};

// A few params have a raw-hex/wire-value description that's more useful
// shown as a live, human-readable readout of the knob's current setting.
const semitoneDesc = (value) => {
  const semitones = Math.round(value) - 64;
  return `${semitones > 0 ? '+' : ''}${semitones} semitones`;
};
const DYNAMIC_PARAM_DESC = {
  'Master Tune': (value) => {
    const cents = Number(((Math.round(value) - 1024) * 0.1).toFixed(2));
    return `${cents > 0 ? '+' : ''}${cents} cent`;
  },
  Transpose: semitoneDesc,
  'Note Shift': semitoneDesc,
  'Bend Pitch Control': semitoneDesc,
  VariMode: (value) => (Math.round(value) === 1 ? 'System' : 'Insertion'),
  'Variation Part': (value) => {
    const v = Math.round(value);
    return v === 127 ? 'Off' : `Part ${v + 1}`;
  },
  'Rcv Channel': (value) => {
    const v = Math.round(value);
    return v === 127 ? 'Off' : `Channel ${v + 1}`;
  },
  Detune: (value) => {
    const hz = Number(((Math.round(value) - 128) * 0.1).toFixed(2));
    return `${hz > 0 ? '+' : ''}${hz} Hz`;
  },
  Pan: (value) => {
    const v = Math.round(value);
    if (v === 0) return 'Random';
    if (v === 64) return 'C';
    return v < 64 ? `L${64 - v}` : `R${v - 64}`;
  },
  'Note Limit Low': (value) => noteName(Math.round(value)),
  'Note Limit High': (value) => noteName(Math.round(value)),
  'Mono/Poly Mode': (value) => (Math.round(value) === 1 ? 'Poly' : 'Mono'),
  'Portamento Switch': (value) => (Math.round(value) === 1 ? 'On' : 'Off'),
  'Same Note Number Key On Assign': (value) => MULTI_TOGGLE_PARAMS['Same Note Number Key On Assign'].labels[Math.round(value)],
  'Part Mode': (value) => MULTI_TOGGLE_PARAMS['Part Mode'].labels[Math.round(value)],
};
// Others just don't need their static description shown at all.
const SUPPRESSED_PARAM_DESC = new Set([
  'Master Volume', 'Reverb Type (MSB)', 'Chorus Type (MSB)', 'Variation Type (MSB)',
  'Reverb Return', 'Reverb Pan', 'Program Number',
]);

// Sections with an effect-type picker: base param name -> key into effectTypes.json.
const EFFECT_TYPE_PARAMS = {
  reverb: { paramName: 'Reverb Type', dataKey: 'reverb' },
  chorus: { paramName: 'Chorus Type', dataKey: 'chorus' },
  variation: { paramName: 'Variation Type', dataKey: 'variation' },
};

// Builds an effect-type picker (Reverb/Chorus/Variation Type), wired to
// drive (and follow) the MSB/LSB knob pair it sits next to.
function buildEffectTypeSelect(types, msbKnob, lsbKnob) {
  const select = document.createElement('select');
  select.className = 'effect-type-select';
  for (const t of types) {
    const opt = document.createElement('option');
    opt.value = `${t.msb}:${t.lsb}`;
    opt.textContent = t.qy100Only ? `${t.name} (QY100)` : t.name;
    if (t.qy100Only) opt.style.color = 'var(--qy100)';
    select.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '';
  customOpt.textContent = '(custom)';
  customOpt.hidden = true;
  select.appendChild(customOpt);

  function syncFromKnobs() {
    const match = types.find((t) => t.msb === msbKnob.getValue() && t.lsb === lsbKnob.getValue());
    select.value = match ? `${match.msb}:${match.lsb}` : '';
  }
  select.addEventListener('change', () => {
    if (!select.value) return;
    const [msb, lsb] = select.value.split(':').map(Number);
    // Update the MSB display silently, then fire on the LSB set so the
    // grouped onChange sends one message with both new bytes together,
    // rather than two messages (the first with a stale byte).
    msbKnob.setValue(msb, false);
    lsbKnob.setValue(lsb, true);
  });
  syncFromKnobs();
  return { element: select, syncFromKnobs };
}

// Multi-byte params (e.g. "Reverb Type (MSB)" / "(LSB)") come out of
// expandRows as separate rows that share the original param's offset,
// encoded as the first half of each row's "offset:subIndex" key - group
// those back together so they render as multiple knobs on one line.
// combineSend stays true: the device wants these bytes in one message.
function groupRows(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    const groupKey = row.key.split(':')[0];
    if (current && current.groupKey === groupKey) {
      current.rows.push(row);
    } else {
      current = { groupKey, rows: [row], combineSend: true };
      groups.push(current);
    }
  }
  return groups;
}

// Some params are independently-addressed MSB/LSB pairs (e.g. Multi Part's
// Bank Select) rather than one documented multi-byte value - the device
// still wants two separate messages, but it reads better shown on one
// line like the combined ones, so merge them for display only.
function mergeVisualPairs(groups) {
  const merged = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const next = groups[i + 1];
    const msbMatch = g.rows.length === 1 && g.rows[0].name.match(/^(.+) MSB$/);
    const lsbMatch = next && next.rows.length === 1 && next.rows[0].name.match(/^(.+) LSB$/);
    if (msbMatch && lsbMatch && msbMatch[1] === lsbMatch[1]) {
      merged.push({ groupKey: g.groupKey, rows: [g.rows[0], next.rows[0]], combineSend: false });
      i++;
    } else {
      merged.push(g);
    }
  }
  return merged;
}

function renderParamPanel() {
  const sectionKey = sectionSelect.value;
  const section = parameters[sectionKey];
  partSelect.hidden = sectionKey !== 'multiPart';
  drumkitSelect.hidden = sectionKey !== 'drumSetup';
  noteSelect.hidden = sectionKey !== 'drumSetup';
  drumSetupHint.hidden = sectionKey !== 'drumSetup';

  const context = currentContext(sectionKey);
  const groups = mergeVisualPairs(groupRows(expandRows(section.params)));
  paramListEl.innerHTML = '';
  // Variation Part only means anything in Insertion mode; the two Sends
  // only mean anything in System mode - grey out whichever doesn't apply
  // to the current VariMode.
  let variModeKnob;
  let variationPartRowEl;
  let sendToReverbRowEl;
  let sendToChorusRowEl;
  function updateVariModeDimming(value) {
    const isSystem = Math.round(value) === 1;
    if (variationPartRowEl) variationPartRowEl.classList.toggle('dimmed', isSystem);
    if (sendToReverbRowEl) sendToReverbRowEl.classList.toggle('dimmed', !isSystem);
    if (sendToChorusRowEl) sendToChorusRowEl.classList.toggle('dimmed', !isSystem);
  }
  for (const { rows, combineSend } of groups) {
    const firstRow = rows[0];
    const grouped = rows.length > 1;
    const baseName = grouped
      ? firstRow.name.replace(/ \([^)]*\)$/, '').replace(/ (MSB|LSB)$/, '')
      : firstRow.name;

    const div = document.createElement('div');
    div.className = 'param-row';
    const dynamicDesc = DYNAMIC_PARAM_DESC[firstRow.name];
    const showStaticDesc = !dynamicDesc && !SUPPRESSED_PARAM_DESC.has(firstRow.name) && firstRow.description;
    const desc = showStaticDesc ? `<span class="param-desc">${firstRow.description}</span>` : '<span class="param-desc"></span>';
    div.innerHTML = `<span class="param-name">${baseName}</span>${desc}`;
    const descEl = div.querySelector('.param-desc');

    const effectTypeParam = EFFECT_TYPE_PARAMS[sectionKey];
    const isEffectTypeRow = effectTypeParam && baseName === effectTypeParam.paramName;
    let effectSelect;
    const knobGroup = document.createElement('div');
    knobGroup.className = 'knob-group';
    const knobs = [];

    for (const row of rows) {
      const caption = grouped ? (row.name.match(/\(([^)]*)\)$/)?.[1] ?? row.name.match(/ (MSB|LSB)$/)?.[1]) : undefined;
      const defaultValue = resolveDefault(row, context);
      const widgetOptions = {
        value: defaultValue ?? row.dataMin,
        resetValue: defaultValue,
        onInput: (value) => {
          if (dynamicDesc) descEl.textContent = dynamicDesc(value);
          if (isEffectTypeRow) effectSelect?.syncFromKnobs();
          if (baseName === 'VariMode') updateVariModeDimming(value);
        },
        // combineSend rows (e.g. Reverb Type's MSB+LSB) are one addressable
        // unit on the wire - the device rejects a message addressed to a
        // later byte alone, so send every knob's current value together.
        // Visually-paired-but-independent rows (e.g. Multi Part's Bank
        // Select MSB/LSB) keep sending their own separate messages.
        onChange: (value) => {
          try {
            const doSend = (ctx) => {
              // grouped must hold too: groupRows marks every group
              // combineSend regardless of size, but sendParamGroup's plain
              // 7-bit masking is only correct for combining multiple
              // already-split bytes - a single nibble-encoded row (Master
              // Tune, Detune) needs sendParam's nibblePack instead.
              if (combineSend && grouped) {
                sendParamGroup(link, 0, section, ctx, rows, knobs.map((k) => k.getValue()));
              } else {
                sendParam(link, 0, section, ctx, row, value);
              }
            };
            if (context.allChannels) {
              for (let ch = 0; ch < 16; ch++) doSend({ ...context, drumHigh: 0x30 + ch });
            } else {
              doSend(context);
            }
          } catch (err) {
            statusEl.textContent = `Error: ${err.message}`;
          }
        },
      };
      // Some params are a hard flag or a small set of named modes on real
      // hardware rather than a smooth range, so they get a switch instead
      // of a rotary knob.
      const multiToggle = MULTI_TOGGLE_PARAMS[baseName];
      const knob = TOGGLE_PARAMS.has(baseName)
        ? createToggle(widgetOptions)
        : multiToggle
          ? createMultiToggle({ ...widgetOptions, labels: multiToggle.labels, titles: multiToggle.titles })
          : createKnob({ ...widgetOptions, min: row.dataMin, max: row.dataMax, caption });
      knobs.push(knob);
      knobGroup.appendChild(knob.element);
    }

    if (isEffectTypeRow && effectTypes[effectTypeParam.dataKey]) {
      effectSelect = buildEffectTypeSelect(effectTypes[effectTypeParam.dataKey], knobs[0], knobs[1]);
      descEl.appendChild(effectSelect.element);
    }

    div.appendChild(knobGroup);
    paramListEl.appendChild(div);

    if (baseName === 'VariMode') variModeKnob = knobs[0];
    if (baseName === 'Variation Part') variationPartRowEl = div;
    if (baseName === 'Send Variation To Reverb') sendToReverbRowEl = div;
    if (baseName === 'Send Variation To Chorus') sendToChorusRowEl = div;
    if (variModeKnob && ['VariMode', 'Variation Part', 'Send Variation To Reverb', 'Send Variation To Chorus'].includes(baseName)) {
      updateVariModeDimming(variModeKnob.getValue());
    }
  }
}

sectionSelect.addEventListener('change', renderParamPanel);
partSelect.addEventListener('change', renderParamPanel);
drumkitSelect.addEventListener('change', () => { populateNoteSelect(); renderParamPanel(); });
noteSelect.addEventListener('change', renderParamPanel);
// Drum Setup's address depends on the main Channel selector now.
channelSelect.addEventListener('change', () => {
  if (sectionSelect.value === 'drumSetup') renderParamPanel();
});

// ---- Boot ----

(async () => {
  [voices, parameters, drumNotes, presets, effectTypes] = await Promise.all(
    [loadVoices(), loadParameters(), loadDrumNotes(), loadPresets(), loadEffectTypes()]);
  refreshCategoryOptions();
  renderVoiceList();
  populatePartSelect();
  populateDrumkitSelect();
  populateNoteSelect();
  renderParamPanel();
})();
