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
const resetSectionBtn = el('reset-section-btn');
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

async function findDevices() {
  try {
    await link.requestAccess();
    link.onDevicesChanged = refreshDeviceLists;
    refreshDeviceLists();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

connectBtn.addEventListener('click', findDevices);
if (navigator.requestMIDIAccess) findDevices();

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
    "QY70/QY100 ignores them until it receives this. It's typically not needed.\n\n" +
    'It will reset every voice on every channel to its default.'
  );
  if (!confirmed) return;
  try {
    link.send(buildXgSystemOn(0));
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

resetSectionBtn.addEventListener('click', async () => {
  const sectionLabel = parameters[sectionSelect.value]?.label || 'this section';
  const confirmed = await showConfirm(
    `Reset all ${sectionLabel} parameters?`,
    `This sets every parameter in ${sectionLabel} back to its default value and sends the change now. ` +
    'Any custom values you\'ve dialed in here will be lost.'
  );
  if (!confirmed) return;
  for (const resetFn of currentSectionResetFns) resetFn();
});

el('clear-log-btn').addEventListener('click', () => {
  logLines = [];
  logOutput.textContent = '';
});

// ---- Parameters (generic, data-driven from parameters.json) ----

let parameters = {};
let drumNotes = {};
let effectTypes = {};
let effectParams = { groups: {}, typeToGroup: {} };
let effectValueTables = {};
const sectionSelect = el('section-select');
const partSelect = el('part-select');
const drumkitSelect = el('drumkit-select');
const noteSelect = el('note-select');
const drumSetupHint = el('drum-setup-hint');
const paramListEl = el('param-list');
let currentSectionResetFns = [];

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

async function loadEffectParams() {
  const res = await fetch('./data/effect_params.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load effect_params.json: ${res.status}`);
  return res.json();
}

async function loadEffectValueTables() {
  const res = await fetch('./data/effect_value_tables.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load effect_value_tables.json: ${res.status}`);
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

// These knobs pick an identity (which voice, which bank) rather than a
// smooth quality - continuously transmitting while dragging through them
// would just rapid-fire voice changes, not a useful live tweak. Effect Type
// rows are excluded separately via isEffectTypeRow for the same reason.
const NON_CONTINUOUS_PARAMS = new Set(['Bank Select', 'Program Number']);

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
const panDesc = (value) => {
  const v = Math.round(value);
  if (v === 64) return 'C';
  return v < 64 ? `L${64 - v}` : `R${v - 64}`;
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
  'Reverb Pan': panDesc,
  'Chorus Pan': panDesc,
  'Variation Pan': panDesc,
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

// Short explanations shown via the info icon next to each param name. Falls
// back to the row's own `description` field from parameters.json when a
// param isn't listed here, and the icon is simply omitted if neither exists.
const PARAM_INFO = {
  // System
  'Master Tune': 'Fine-tunes the whole instrument\'s pitch up or down in cents (1/100 of a semitone) - for matching another instrument that\'s slightly off pitch.',
  'Master Volume': 'Overall output volume for every part combined.',
  Transpose: 'Shifts the pitch of everything played in whole semitones, without changing the tempo - handy for matching a singer\'s range.',

  // Reverb / Chorus / Variation shared concepts
  'Reverb Type': 'The reverb algorithm in use - which room/hall/plate simulation (or delay/gate effect on Variation) is applied, and what its numbered parameters below control.',
  'Chorus Type': 'The chorus/flanger algorithm in use - and what its numbered parameters below control.',
  'Variation Type': 'The variation effect algorithm in use (any Reverb or Chorus algorithm, plus delays, distortion, EQ, and more) - and what its numbered parameters below control.',
  'Reverb Return': 'How much of the reverb\'s processed sound is mixed back into the output.',
  'Chorus Return': 'How much of the chorus\'s processed sound is mixed back into the output.',
  'Variation Return': 'How much of the variation effect\'s processed sound is mixed back into the output, when Variation is in System mode.',
  'Reverb Pan': 'Stereo position of the reverb\'s return signal.',
  'Chorus Pan': 'Stereo position of the chorus\'s return signal.',
  'Variation Pan': 'Stereo position of the variation effect\'s return signal, when Variation is in System mode.',
  'Send Chorus To Reverb': 'How much of the chorus\'s output is additionally fed into the reverb, for a chorus-then-reverb effect chain.',
  'Send Variation To Reverb': 'How much of the variation effect\'s output is additionally fed into the reverb, when Variation is in System mode.',
  'Send Variation To Chorus': 'How much of the variation effect\'s output is additionally fed into the chorus, when Variation is in System mode.',
  VariMode: 'Whether Variation acts as a shared bus effect like Reverb/Chorus (System - any part can send into it) or is patched directly into one specific part\'s signal path (Insertion - see Variation Part below).',
  'Variation Part': 'Which part receives the Variation effect directly in its signal chain, when VariMode is set to Insertion.',
  'MW Variation Ctrl Depth': 'How much the Modulation Wheel affects the Variation effect\'s depth, when Variation is in Insertion mode and its type supports control.',
  'PB Variation Ctrl Depth': 'How much the Pitch Bend Wheel affects the Variation effect\'s depth, when Variation is in Insertion mode and its type supports control.',
  'AT Variation Ctrl Depth': 'How much Channel Aftertouch affects the Variation effect\'s depth, when Variation is in Insertion mode and its type supports control.',
  'AC1 Variation Ctrl Depth': 'How much Assignable Controller 1 affects the Variation effect\'s depth, when Variation is in Insertion mode and its type supports control.',
  'AC2 Variation Ctrl Depth': 'How much Assignable Controller 2 affects the Variation effect\'s depth, when Variation is in Insertion mode and its type supports control.',

  // Multi Part
  'Element Reserve': 'How many sound-generating voices are reserved for this part, guaranteeing it can still play even when the instrument is busy with other parts.',
  'Bank Select': 'Selects the voice bank (MSB/LSB) this part plays from; combined with Program Number to pick the exact voice.',
  'Program Number': 'Selects which voice within the current bank this part plays.',
  'Rcv Channel': 'Which MIDI channel this part listens to; Off means it ignores incoming MIDI note data entirely.',
  'Mono/Poly Mode': 'Whether this part can only play one note at a time (Mono, good for basses/leads) or many notes at once (Poly).',
  'Portamento Switch': 'Turns on a smooth pitch glide between consecutive notes on this part.',
  'Portamento Time': 'How long the pitch glide takes when Portamento is on - higher is a slower slide.',
  'Same Note Number Key On Assign': 'How repeated notes of the same pitch are handled: replace the previous note (Single), layer on top of it (Multi), or use drum-style one-shot behavior (Inst).',
  'Part Mode': 'Whether this part behaves as a normal melodic part or is routed through drum-kit note mapping.',
  'Note Shift': 'Shifts this part\'s pitch in whole semitones, independent of the global Transpose.',
  Detune: 'Fine pitch offset for this part in Hz, for subtle chorus-like detuning against other parts.',
  Volume: 'This part\'s individual volume, relative to Master Volume.',
  'Velocity Sense Depth': 'How strongly playing velocity (how hard a note is struck) affects this part\'s volume.',
  'Velocity Sense Offset': 'Shifts the velocity-to-volume curve up or down, so even soft playing can reach full volume if raised.',
  Pan: 'Stereo position of this part.',
  'Note Limit Low': 'The lowest note this part will respond to - notes below it are ignored.',
  'Note Limit High': 'The highest note this part will respond to - notes above it are ignored.',
  'Dry Level': 'How much of this part\'s unprocessed (dry) signal is sent straight to the output, bypassing the effects sends below.',
  'Chorus Send': 'How much of this part\'s signal is sent to the Chorus effect.',
  'Reverb Send': 'How much of this part\'s signal is sent to the Reverb effect.',
  'Variation Send': 'How much of this part\'s signal is sent to the Variation effect (only relevant when Variation is in System mode).',
  'Vibrato Rate': 'Speed of this part\'s pitch vibrato.',
  'Vibrato Depth': 'Intensity of this part\'s pitch vibrato.',
  'Vibrato Delay': 'How long a note plays before vibrato fades in.',
  'Filter Cutoff Frequency': 'Brightness of the sound - lower rolls off high frequencies for a darker/mellower tone.',
  'Filter Resonance': 'Emphasizes frequencies right at the filter cutoff, adding a "peaky" or vocal-like edge to the tone.',
  'EG Attack Time': 'How quickly a note reaches full volume after being played - higher is a slower fade-in.',
  'EG Decay Time': 'How quickly a note settles from its initial peak down to its sustain level.',
  'EG Release Time': 'How long a note continues to sound after the key is released.',
  'Pitch EG Initial Level': 'The pitch offset a note starts at before the pitch envelope moves it, relative to its normal pitch.',
  'Pitch EG Attack Time': 'How quickly the pitch envelope moves from its initial level toward the release level.',
  'Pitch EG Release Level': 'The pitch offset a note settles toward as the pitch envelope finishes.',
  'Pitch EG Release Time': 'How long the pitch envelope takes to fade out after a note is released.',

  // Ch's AT / Multi Part sends
  Liveness: 'How much of the room\'s natural reflections carry through - higher feels more open/live.',
  Density: 'How densely packed the reverb\'s echoes are - higher sounds smoother and less like distinct repeats.',

  // Drum Setup
  'Pitch Coarse': 'Pitch of this drum sound in whole semitones.',
  'Pitch Fine': 'Fine pitch tuning of this drum sound in cents.',
  Level: 'Volume of this individual drum sound within the kit.',
  'Alternate Group': 'Sounds sharing the same non-zero group cut each other off (e.g. open/closed hi-hat) - 0 means no grouping.',
  'Reverb Send Level': 'How much of this drum sound is sent to the Reverb effect.',
  'Chorus Send Level': 'How much of this drum sound is sent to the Chorus effect.',
  'Variation Send Level': 'How much of this drum sound is sent to the Variation effect.',
  'Key Assign': 'Whether repeated hits of this drum sound cut each other off (Single) or are allowed to overlap/layer (Multi).',
  'Rcv Note Off': 'Whether this drum sound responds to Note Off messages (usually off, since most drum hits are one-shots).',
  'Rcv Note On': 'Whether this drum sound responds to Note On messages - turning it off effectively mutes that drum.',
  'EG Attack Rate': 'How quickly this drum sound reaches full volume after being struck - higher is faster.',
  'EG Decay1 Rate': 'How quickly this drum sound moves from its initial attack into its main decay.',
  'EG Decay2 Rate': 'How quickly this drum sound fades out after Decay 1 - effectively its overall length/tail.',
};
const AT_MOD_CONTROL_INFO = {
  'Pitch Control': 'How far this controller bends pitch, in semitones.',
  'Filter Control': 'How much this controller opens/closes the filter cutoff.',
  'Amplitude Control': 'How much this controller changes volume.',
  'Amp Control': 'How much this controller changes volume.',
  'LFO PMod Depth': 'How much this controller adds to the vibrato (pitch modulation) depth.',
  'LFO FMod Depth': 'How much this controller adds to filter (tone) modulation depth.',
  'LFO AMod Depth': 'How much this controller adds to tremolo (volume modulation) depth.',
};
for (const [suffix, text] of Object.entries(AT_MOD_CONTROL_INFO)) {
  PARAM_INFO[`MW ${suffix}`] = `Modulation Wheel: ${text[0].toLowerCase()}${text.slice(1)}`;
  PARAM_INFO[`Bend ${suffix}`] = `Pitch Bend Wheel: ${text[0].toLowerCase()}${text.slice(1)}`;
  PARAM_INFO[`Ch's AT ${suffix}`] = `Channel Aftertouch (pressing harder after a note is already held): ${text[0].toLowerCase()}${text.slice(1)}`;
}

// Sections with an effect-type picker: base param name -> key into effectTypes.json.
const EFFECT_TYPE_PARAMS = {
  reverb: { paramName: 'Reverb Type', dataKey: 'reverb' },
  chorus: { paramName: 'Chorus Type', dataKey: 'chorus' },
  variation: { paramName: 'Variation Type', dataKey: 'variation' },
};

// Live "meaning" text for the generic Reverb/Chorus/Variation "Parameter N"
// rows, sourced from the QY100 Data List's Effect Parameter List (page
// 10-13) - keyed by the real parameter name (from effect_params.json) once
// refreshEffectParamNames() has relabeled the row. 'static' just shows the
// documented range (used where the manual's own Range column doesn't give a
// clean linear formula, e.g. non-linear lookup-table params); 'linear' and
// 'enum' compute a live readout from the row's current knob value. Params
// with no documented unit (plain 0-127 depth/level dials) are intentionally
// left out - the raw number already is the whole story.
// Every 'linear' entry's formula is only documented over its own narrower
// data sub-range (e.g. EQ Gain is only defined for data 52-76, not the full
// 0-127 the app's shared generic-parameter-slot knob template allows) -
// dataMin/dataMax here clamp the value before formatting so dragging past
// the documented range doesn't print a nonsense reading.
const dbDesc = (v) => `${v - 64 >= 0 ? '+' : ''}${v - 64} dB`;
const balanceDesc = (aLabel, bLabel) => (v) => (v === 64 ? `${aLabel} = ${bLabel}` : v < 64 ? `${aLabel} +${64 - v}` : `${bLabel} +${v - 64}`);
// These read the byte value through the manual's own non-linear Data/Value
// Correspondence Tables (data/effect_value_tables.json, transcribed from
// the QY100 Data List) rather than a formula - "THRU" entries name the
// frequency where filtering stops applying, so the unit still belongs
// inside the parens (e.g. "THRU(20Hz)").
const tableDesc = (tableName, unit) => (v) => {
  const raw = effectValueTables[tableName]?.[v];
  if (raw === undefined || raw === null) return '';
  return /^THRU\(/.test(raw) ? raw.replace(')', `${unit})`) : `${raw}${unit}`;
};
const EFFECT_PARAM_META = {
  'Reverb Time': { kind: 'linear', dataMin: 0, dataMax: 69, format: tableDesc('table4_reverbTimeS', 's') },
  'HPF Cutoff': { kind: 'linear', dataMin: 0, dataMax: 52, format: tableDesc('table3_eqFreqHz', 'Hz') },
  'LPF Cutoff': { kind: 'linear', dataMin: 34, dataMax: 60, format: tableDesc('table3_eqFreqHz', 'Hz') },
  Width: { kind: 'linear', dataMin: 0, dataMax: 37, format: tableDesc('table8_widthDepthHeightM', 'm') },
  Height: { kind: 'linear', dataMin: 0, dataMax: 73, format: tableDesc('table8_widthDepthHeightM', 'm') },
  Depth: { kind: 'linear', dataMin: 0, dataMax: 104, format: tableDesc('table8_widthDepthHeightM', 'm') },
  'LFO Frequency': { kind: 'linear', dataMin: 0, dataMax: 127, format: tableDesc('table1_lfoFreqHz', 'Hz') },
  'EQ Low Frequency': { kind: 'linear', dataMin: 8, dataMax: 40, format: tableDesc('table3_eqFreqHz', 'Hz') },
  'EQ High Frequency': { kind: 'linear', dataMin: 28, dataMax: 58, format: tableDesc('table3_eqFreqHz', 'Hz') },
  'EQ Mid Frequency': { kind: 'static', text: '500Hz – 10.0kHz' },
  'Room Size': { kind: 'static', text: '0.1 – 7.0m' },
  Stage: { kind: 'static', text: '6-10 (Phaser 1) / 3-5 (Phaser 2)' },
  'Lch Delay': { kind: 'static', text: '0.1 – 715.0ms' },
  'Rch Delay': { kind: 'static', text: '0.1 – 715.0ms' },
  'Cch Delay': { kind: 'static', text: '0.1 – 715.0ms' },
  'Feedback Delay': { kind: 'static', text: '0.1 – 715.0ms' },
  'Feedback Delay 1': { kind: 'static', text: '0.1 – 715.0ms' },
  'Feedback Delay 2': { kind: 'static', text: '0.1 – 715.0ms' },
  'L->R Delay': { kind: 'static', text: '0.1 – 355.0ms' },
  'R->L Delay': { kind: 'static', text: '0.1 – 355.0ms' },
  'Lch Delay1': { kind: 'static', text: '0.1 – 355.0ms' },
  'Rch Delay1': { kind: 'static', text: '0.1 – 355.0ms' },
  'Lch Delay2': { kind: 'static', text: '0.1 – 355.0ms' },
  'Rch Delay2': { kind: 'static', text: '0.1 – 355.0ms' },

  'Dry/Wet': { kind: 'linear', dataMin: 1, dataMax: 127, format: balanceDesc('Dry', 'Wet') },
  'Er/ Rev Balance': { kind: 'linear', dataMin: 1, dataMax: 127, format: balanceDesc('Early Ref.', 'Reverb') },
  'Feedback Level': { kind: 'linear', dataMin: 1, dataMax: 127, format: (v) => `${v - 64 >= 0 ? '+' : ''}${v - 64}` },
  'Lch Feedback Level': { kind: 'linear', dataMin: 1, dataMax: 127, format: (v) => `${v - 64 >= 0 ? '+' : ''}${v - 64}` },
  'Rch Feedback Level': { kind: 'linear', dataMin: 1, dataMax: 127, format: (v) => `${v - 64 >= 0 ? '+' : ''}${v - 64}` },
  'EQ Low Gain': { kind: 'linear', dataMin: 52, dataMax: 76, format: dbDesc },
  'EQ High Gain': { kind: 'linear', dataMin: 52, dataMax: 76, format: dbDesc },
  'EQ Mid Gain': { kind: 'linear', dataMin: 52, dataMax: 76, format: dbDesc },
  'LFO Phase Difference': { kind: 'linear', dataMin: 4, dataMax: 124, format: (v) => `${(v - 64) * 3 >= 0 ? '+' : ''}${(v - 64) * 3}°` },
  'High Damp': { kind: 'linear', dataMin: 1, dataMax: 10, format: (v) => (v / 10).toFixed(1) },
  'EQ Mid Width': { kind: 'linear', dataMin: 10, dataMax: 120, format: (v) => (v / 10).toFixed(1) },
  Resonance: { kind: 'linear', dataMin: 10, dataMax: 120, format: (v) => (v / 10).toFixed(1) },

  'Input Mode': { kind: 'enum', labels: ['Mono', 'Stereo'] },
  'Input Select': { kind: 'enum', labels: ['L', 'R', 'L&R'] },
  'AMP Type': { kind: 'enum', labels: ['Off', 'Stack', 'Combo', 'Tube'] },
  'PAN Direction': { kind: 'enum', labels: ['L<->R', 'L->R', 'L<-R', 'L turn', 'R turn', 'L/R'] },
};
// A few parameter names mean something different depending on the group
// (e.g. "Type" is a reverb-shape enum for Early Ref but an A/B enum for
// Gate Reverb) - checked before the shared table above.
const EFFECT_PARAM_META_BY_GROUP = {
  'EARLY REF1,2': { Type: { kind: 'enum', labels: ['S-H', 'L-H', 'Rdm', 'Rvs', 'Plt', 'Spr'] } },
  'GATE REVERB, REVERSE GATE': { Type: { kind: 'enum', labels: ['Type A', 'Type B'] } },
};
function effectParamMeta(name, groupKey) {
  return (groupKey && EFFECT_PARAM_META_BY_GROUP[groupKey]?.[name]) || EFFECT_PARAM_META[name];
}
function computeEffectParamDesc(name, groupKey, value) {
  const meta = effectParamMeta(name, groupKey);
  if (!meta) return '';
  if (meta.kind === 'static') return meta.text;
  if (meta.kind === 'linear') return meta.format(Math.min(meta.dataMax, Math.max(meta.dataMin, Math.round(value))));
  if (meta.kind === 'enum') return meta.labels[Math.round(value)] ?? '';
  return '';
}

// A couple of the generic slots have a hardware-meaningful resting value
// that differs from the shared 0-127 template's default of 0 - e.g. -63dB
// isn't "no feedback", 0dB (data 64) is.
const EFFECT_PARAM_DEFAULT = {
  'Feedback Level': 64,
  'Lch Feedback Level': 64,
  'Rch Feedback Level': 64,
};

// Info-icon tooltip text for the generic Reverb/Chorus/Variation "Parameter
// N" slots, keyed by their real name once relabeled - shown once the
// currently selected effect Type actually defines a name for the slot.
const EFFECT_PARAM_INFO = {
  'Reverb Time': 'How long the reverb tail takes to decay.',
  Diffusion: 'How dense/smooth the reverb\'s reflections are - higher blurs individual echoes together.',
  'Initial Delay': 'Time before the first reflection is heard, simulating the size of the space.',
  'HPF Cutoff': 'Rolls off low frequencies below this point out of the effect signal.',
  'LPF Cutoff': 'Rolls off high frequencies above this point out of the effect signal.',
  Width: 'Simulated left-right width of the room.',
  Height: 'Simulated ceiling height of the room.',
  Depth: 'Simulated front-back depth of the room.',
  'Wall Vary': 'Amount of randomization applied to the simulated wall reflections.',
  'Dry/Wet': 'Balance between the unprocessed (dry) and effect-processed (wet) signal.',
  'Rev Delay': 'Delay before the main reverb tail begins, after the initial reflections.',
  Density: 'Density of the reverb\'s later reflections.',
  'Er/ Rev Balance': 'Balance between the early reflections and the main reverb tail.',
  'Feedback Level': 'How much of the delay/effect output is fed back into itself - higher repeats longer.',
  'Lch Feedback Level': 'How much of the left channel delay is fed back into itself - higher repeats longer.',
  'Rch Feedback Level': 'How much of the right channel delay is fed back into itself - higher repeats longer.',
  'LFO Frequency': 'Speed of the modulation cycle.',
  'LFO PM Depth': 'Depth of the pitch-modulation applied by the LFO.',
  'LFO Depth': 'Depth of the modulation applied by the LFO.',
  'AM Depth': 'Depth of the amplitude (volume) modulation.',
  'PM Depth': 'Depth of the pitch modulation.',
  'L/R Depth': 'Depth of the left-right panning motion.',
  'F/R Depth': 'Depth of the front-back panning motion.',
  'Delay Offset': 'Base delay time the LFO\'s modulation is centered around.',
  'EQ Low Frequency': 'Corner frequency of the low-shelf EQ band.',
  'EQ Low Gain': 'Boost or cut applied at and below the low-shelf frequency.',
  'EQ Mid Frequency': 'Center frequency of the mid EQ band.',
  'EQ Mid Gain': 'Boost or cut applied around the mid-band center frequency.',
  'EQ Mid Width': 'How narrow or broad the mid EQ band is around its center frequency.',
  'EQ High Frequency': 'Corner frequency of the high-shelf EQ band.',
  'EQ High Gain': 'Boost or cut applied at and above the high-shelf frequency.',
  'Input Mode': 'Whether the effect processes its input as mono or stereo.',
  'Input Select': 'Which input channel(s) feed the effect.',
  'LFO Phase Difference': 'Phase offset between the left and right LFO cycles, for a wider stereo effect.',
  'Room Size': 'Simulated size of the room, affecting reflection timing.',
  Liveness: 'How reflective the simulated room surfaces are.',
  'High Damp': 'How much high frequencies decay faster than the rest of the signal as it repeats/reverberates.',
  'Delay Time': 'Time between the input and the first repeat.',
  Type: 'Which variation of this effect algorithm is used.',
  'Lch Delay': 'Delay time on the left channel.',
  'Rch Delay': 'Delay time on the right channel.',
  'Cch Delay': 'Delay time on the center channel.',
  'Cch Level': 'Output level of the center channel delay.',
  'Feedback Delay': 'Delay time used for the feedback repeats.',
  'Feedback Delay 1': 'Delay time used for the first feedback path.',
  'Feedback Delay 2': 'Delay time used for the second feedback path.',
  'L->R Delay': 'Delay time from the left channel feeding into the right.',
  'R->L Delay': 'Delay time from the right channel feeding into the left.',
  'Lch Delay1': 'First delay time on the left channel.',
  'Rch Delay1': 'First delay time on the right channel.',
  'Lch Delay2': 'Second delay time on the left channel.',
  'Rch Delay2': 'Second delay time on the right channel.',
  'Delay2 Level': 'Output level of the second delay tap.',
  Drive: 'Amount of distortion/overdrive gain applied to the signal.',
  'AMP Type': 'Which guitar amplifier/cabinet character is simulated.',
  'Output Level': 'Overall output level of the effect.',
  'Edge(Clip Curve)': 'Shape of the distortion clipping, from mild to sharp-edged.',
  Resonance: 'Emphasis added right at the filter\'s cutoff frequency.',
  'Cutoff Frequency Offset': 'How far the wah\'s filter sweep moves from its center frequency.',
  'PAN Direction': 'Pattern the auto-pan effect moves the sound image in.',
  Stage: 'Which stage/depth of the phasing effect is used.',
  'Phase Shift Offset': 'Base amount of phase shift the LFO\'s sweep is centered around.',
};
const EFFECT_PARAM_UNUSED_INFO = 'Unused by the currently selected effect Type - the QY70/QY100 ignores this byte here, though it can still be sent and may do something on other/external XG gear.';

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
  currentSectionResetFns = [];
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

  // The generic "Reverb/Chorus/Variation Parameter N" rows mean something
  // different depending on the selected effect Type (e.g. Param 1 is
  // "Reverb Time" for Hall/Room/Stage/Plate but "Lch Delay" for Delay
  // types) - relabel them live whenever the Type's MSB/LSB change, without
  // rebuilding the DOM (that would drop mid-drag pointer capture).
  const effectTypeParam = EFFECT_TYPE_PARAMS[sectionKey];
  const paramNameEls = [];
  let effectTypeKnobs = null;
  let currentEffectGroupKey = null;
  function currentEffectGroup() {
    if (!effectTypeParam || !effectTypeKnobs) return { groupKey: null, group: null };
    const [msbKnob, lsbKnob] = effectTypeKnobs;
    const typeList = effectTypes[effectTypeParam.dataKey] || [];
    const match = typeList.find((t) => t.msb === msbKnob.getValue() && t.lsb === lsbKnob.getValue());
    const groupKey = (match && effectParams.typeToGroup[match.name]) || null;
    return { groupKey, group: groupKey && effectParams.groups[groupKey] };
  }
  function refreshEffectParamNames() {
    if (!effectTypeParam || !effectTypeKnobs) return;
    const { groupKey, group } = currentEffectGroup();
    currentEffectGroupKey = groupKey;
    for (const { el, num, fallback, descEl, knob, row, infoIcon } of paramNameEls) {
      const used = !!(group && group[num - 1]);
      el.textContent = used ? group[num - 1] : fallback;
      descEl.textContent = used ? computeEffectParamDesc(el.textContent, currentEffectGroupKey, knob.getValue()) : '';
      row.classList.toggle('unused-param', !used);
      if (infoIcon) {
        infoIcon.dataset.tooltip = used
          ? (EFFECT_PARAM_INFO[el.textContent] || 'Meaning defined by the currently selected effect Type.')
          : EFFECT_PARAM_UNUSED_INFO;
      }
    }
  }

  for (const { rows, combineSend } of groups) {
    const firstRow = rows[0];
    const grouped = rows.length > 1;
    const baseName = grouped
      ? firstRow.name.replace(/ \([^)]*\)$/, '').replace(/ (MSB|LSB)$/, '')
      : firstRow.name;

    const paramNumMatch = effectTypeParam && baseName.match(/ Param(?:eter)? (\d+)$/);

    const div = document.createElement('div');
    div.className = 'param-row';
    const dynamicDesc = DYNAMIC_PARAM_DESC[firstRow.name];
    const showStaticDesc = !dynamicDesc && !SUPPRESSED_PARAM_DESC.has(firstRow.name) && firstRow.description;
    const desc = showStaticDesc ? `<span class="param-desc">${firstRow.description}</span>` : '<span class="param-desc"></span>';
    const infoText = PARAM_INFO[baseName] || (!showStaticDesc && firstRow.description) || '';
    // paramNumMatch rows always get an icon even with no infoText yet - its
    // tooltip is filled in live by refreshEffectParamNames() once the
    // selected effect Type says whether the slot is used and what it means.
    // Uses data-tooltip + CSS (see .info-icon rules) instead of the native
    // title attribute, which has a slow, browser-controlled hover delay.
    const infoIcon = (infoText || paramNumMatch)
      ? `<button type="button" class="info-icon" data-tooltip="${infoText.replace(/"/g, '&quot;')}">i</button>` : '';
    div.innerHTML = `${infoIcon}<span class="param-name">${baseName}</span>${desc}`;
    const descEl = div.querySelector('.param-desc');
    const nameEl = div.querySelector('.param-name');

    const isEffectTypeRow = effectTypeParam && baseName === effectTypeParam.paramName;
    let effectSelect;
    const knobGroup = document.createElement('div');
    knobGroup.className = 'knob-group';
    const knobs = [];
    const defaults = [];

    // The generic slots' JSON default (0) is only right for some meanings -
    // e.g. a Feedback Level of 0dB (data 64), not -63dB, is the sane resting
    // point - so override it once we know what this slot currently means.
    let effectParamDefault;
    if (paramNumMatch) {
      const { group } = currentEffectGroup();
      const label = (group && group[Number(paramNumMatch[1]) - 1]) || baseName;
      effectParamDefault = EFFECT_PARAM_DEFAULT[label];
    }

    for (const row of rows) {
      const caption = grouped ? (row.name.match(/\(([^)]*)\)$/)?.[1] ?? row.name.match(/ (MSB|LSB)$/)?.[1]) : undefined;
      const defaultValue = effectParamDefault ?? resolveDefault(row, context);
      defaults.push(defaultValue);
      const widgetOptions = {
        value: defaultValue ?? row.dataMin,
        resetValue: defaultValue,
        // Live-transmit while dragging, for performance-style tweaking of a
        // sound while it's playing - except for knobs that pick an identity
        // (which voice, which effect Type) rather than a smooth quality,
        // where sweeping through every value in between is just noise.
        continuousSend: !isEffectTypeRow && !NON_CONTINUOUS_PARAMS.has(baseName),
        onInput: (value) => {
          if (dynamicDesc) descEl.textContent = dynamicDesc(value);
          if (isEffectTypeRow) {
            effectSelect?.syncFromKnobs();
            refreshEffectParamNames();
          }
          if (paramNumMatch) {
            descEl.textContent = computeEffectParamDesc(nameEl.textContent, currentEffectGroupKey, value);
          }
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

    if (isEffectTypeRow) {
      effectTypeKnobs = knobs;
      if (effectTypes[effectTypeParam.dataKey]) {
        effectSelect = buildEffectTypeSelect(effectTypes[effectTypeParam.dataKey], knobs[0], knobs[1]);
        descEl.appendChild(effectSelect.element);
      }
    }

    if (paramNumMatch) {
      paramNameEls.push({
        el: nameEl, num: Number(paramNumMatch[1]), fallback: baseName, descEl, knob: knobs[0],
        row: div, infoIcon: div.querySelector('.info-icon'),
      });
    }

    // Reset All: set every knob in this row back to its own default, firing
    // only the last one's onChange - combineSend rows read every knob's
    // current value at send time, so the others just need to be in place
    // first. Rows with no documented default (resetValue disabled on the
    // per-row Reset button too) are left untouched.
    const resettableIdx = defaults.reduce((acc, d, i) => (d !== undefined && d !== null ? [...acc, i] : acc), []);
    if (resettableIdx.length) {
      const lastIdx = resettableIdx[resettableIdx.length - 1];
      currentSectionResetFns.push(() => {
        for (const i of resettableIdx) knobs[i].setValue(defaults[i], i === lastIdx);
      });
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
  refreshEffectParamNames();
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
  [voices, parameters, drumNotes, presets, effectTypes, effectParams, effectValueTables] = await Promise.all(
    [loadVoices(), loadParameters(), loadDrumNotes(), loadPresets(), loadEffectTypes(), loadEffectParams(), loadEffectValueTables()]);
  refreshCategoryOptions();
  renderVoiceList();
  populatePartSelect();
  populateDrumkitSelect();
  populateNoteSelect();
  renderParamPanel();
})();
