import { MidiLink } from './midi.js';
import { buildXgSystemOn } from './sysex.js';
import { loadVoices, selectVoice, filterVoices, categoriesFor, bankLabel, voiceDisplayName } from './voices.js';
import { loadParameters, expandRows, sendParam } from './params.js';
import { createKnob } from './knob.js';

const link = new MidiLink();
let voices = [];
let selectedVoiceKey = null;

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

for (let i = 1; i <= 16; i++) {
  const opt = document.createElement('option');
  opt.value = i - 1;
  opt.textContent = `${i}`;
  channelSelect.appendChild(opt);
}

// Timing Clock (F8) and Active Sensing (FE) are real-time bytes a device can
// send continuously (Active Sensing every ~200ms per spec) - logging them
// would flood the panel with nothing diagnostically useful.
const TIMING_STATUS_BYTES = new Set([0xf8, 0xfe]);

function log(direction, bytes) {
  if (bytes.length === 1 && TIMING_STATUS_BYTES.has(bytes[0])) return;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const line = `${new Date().toLocaleTimeString()} ${direction} ${hex}\n`;
  logOutput.textContent += line;
  logOutput.scrollTop = logOutput.scrollHeight;
}

const originalSend = link.send.bind(link);
link.send = (bytes) => {
  log('OUT', bytes);
  originalSend(bytes);
};
link.onMessage = (bytes) => log('IN ', bytes);

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
    statusEl.textContent = 'MIDI access granted - select devices above';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

inputSelect.addEventListener('change', () => {
  link.selectInput(inputSelect.value);
  statusEl.textContent = inputSelect.value ? `Input: ${inputSelect.selectedOptions[0].textContent}` : 'No input selected';
});

outputSelect.addEventListener('change', () => {
  link.selectOutput(outputSelect.value);
  statusEl.textContent = outputSelect.value ? `Output: ${outputSelect.selectedOptions[0].textContent}` : 'No output selected';
});

function currentChannel() {
  return Number(channelSelect.value || 0);
}

function refreshCategoryOptions() {
  const cats = categoriesFor(voices, bankSelect.value).sort();
  categorySelect.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${c}">${c}</option>`).join('');
}

function currentFilteredVoices() {
  return filterVoices(voices, {
    bank: bankSelect.value,
    category: categorySelect.value,
    search: searchBox.value.trim(),
  });
}

function renderVoiceList() {
  const filtered = currentFilteredVoices();
  voiceListEl.innerHTML = '';
  for (const v of filtered) {
    const key = `${v.bank}:${v.program}:${v.bankMsb}:${v.bankLsb}`;
    const li = document.createElement('li');
    li.dataset.key = key;
    if (key === selectedVoiceKey) li.classList.add('selected');
    if (v.qy100Only) li.classList.add('qy100-only');
    const badge = v.qy100Only ? '<span class="qy100-badge" title="QY100 only - not present on QY70">QY100</span>' : '';
    li.innerHTML = `<span>${voiceDisplayName(v)}${badge}</span>` +
      `<span class="voice-meta">${bankLabel(v.bank)} P${v.program} B${v.bankLsb}</span>`;
    li.addEventListener('click', () => {
      try {
        selectVoice(link, currentChannel(), v);
        selectedVoiceKey = key;
        renderVoiceList();
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
    });
    voiceListEl.appendChild(li);
  }
}

bankSelect.addEventListener('change', () => { refreshCategoryOptions(); renderVoiceList(); });
categorySelect.addEventListener('change', renderVoiceList);
searchBox.addEventListener('input', renderVoiceList);

el('xg-on-btn').addEventListener('click', () => {
  try {
    link.send(buildXgSystemOn(0));
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

el('clear-log-btn').addEventListener('click', () => { logOutput.textContent = ''; });

// ---- Parameters (generic, data-driven from parameters.json) ----

let parameters = {};
let drumNotes = {};
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

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// QY70 numbers notes from C-2 (note 0), per the manual's NOTE NUMBER field.
function noteName(n) {
  const octave = Math.floor(n / 12) - 2;
  return `${NOTE_NAMES[n % 12]}${octave}`;
}

function populatePartSelect() {
  partSelect.innerHTML = Array.from({ length: 32 }, (_, i) =>
    `<option value="${i}">Part ${i + 1}</option>`).join('');
}

function populateDrumkitSelect() {
  const kits = voices.filter((v) => v.bank === 'drum' || v.bank === 'sfxkit');
  drumkitSelect.innerHTML = kits.map((k, i) =>
    `<option value="${i}">${k.name}</option>`).join('');
}

// Only DR1 (Standard), DR2 (Standard2), and DR3 (Dry) have per-note
// instrument names; other kits fall back to the Standard kit's names as
// the closest available reference.
const DRUM_KIT_NOTE_KEYS = ['standard', 'standard2', 'dry'];

function populateNoteSelect() {
  const [lo, hi] = parameters.drumSetup.noteRange;
  const kitKey = DRUM_KIT_NOTE_KEYS[Number(drumkitSelect.value || 0)] || 'standard';
  const opts = [];
  for (let n = lo; n <= hi; n++) {
    const entry = drumNotes[n];
    const label = entry ? `${entry[kitKey] || entry.standard}` : noteName(n);
    opts.push(`<option value="${n}">${n} ${label}</option>`);
  }
  noteSelect.innerHTML = opts.join('');
}

function currentContext(sectionKey) {
  if (sectionKey === 'multiPart') {
    return { part: Number(partSelect.value || 0) };
  }
  if (sectionKey === 'drumSetup') {
    // The "3n" address high nibble only has 16 possible values (0-F), so it
    // indexes by MIDI channel rather than by kit name (there are 20+ kits) -
    // it always affects whatever kit is playing on that channel, regardless
    // of the kit name selected in the dropdown below.
    return { drumHigh: 0x30 + currentChannel(), note: Number(noteSelect.value || 0) };
  }
  return {};
}

// Some defaults depend on the current context rather than being a fixed
// number - e.g. Multi Part's Rcv Channel defaults to the part's own number.
function resolveDefault(row, context) {
  if (row.default === 'part') return context.part ?? 0;
  return row.default;
}

function renderParamPanel() {
  const sectionKey = sectionSelect.value;
  const section = parameters[sectionKey];
  partSelect.hidden = sectionKey !== 'multiPart';
  drumkitSelect.hidden = sectionKey !== 'drumSetup';
  noteSelect.hidden = sectionKey !== 'drumSetup';
  drumSetupHint.hidden = sectionKey !== 'drumSetup';

  const context = currentContext(sectionKey);
  const rows = expandRows(section.params);
  paramListEl.innerHTML = '';
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'param-row';
    const desc = row.description ? `<span class="param-desc">${row.description}</span>` : '<span class="param-desc"></span>';
    div.innerHTML = `<span class="param-name">${row.name}</span>${desc}`;

    const defaultValue = resolveDefault(row, context);
    const knob = createKnob({
      min: row.dataMin,
      max: row.dataMax,
      value: defaultValue ?? row.dataMin,
      onChange: (value) => {
        try {
          sendParam(link, 0, section, context, row, value);
        } catch (err) {
          statusEl.textContent = `Error: ${err.message}`;
        }
      },
    });
    div.appendChild(knob.element);

    if (defaultValue !== null && defaultValue !== undefined) {
      const resetBtn = document.createElement('button');
      resetBtn.className = 'reset-btn';
      resetBtn.textContent = 'Reset';
      resetBtn.title = `Reset to default (${defaultValue})`;
      resetBtn.addEventListener('click', () => knob.setValue(defaultValue, true));
      div.appendChild(resetBtn);
    }

    paramListEl.appendChild(div);
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
  [voices, parameters, drumNotes] = await Promise.all([loadVoices(), loadParameters(), loadDrumNotes()]);
  refreshCategoryOptions();
  renderVoiceList();
  populatePartSelect();
  populateDrumkitSelect();
  populateNoteSelect();
  renderParamPanel();
})();
