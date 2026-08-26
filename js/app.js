// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

import { MidiLink } from './midi.js';
import { buildXgSystemOn } from './sysex.js';
import { loadVoices, filterVoices, categoriesFor, bankLabel, voiceDisplayName } from './voices.js';
import { loadParameters, expandRows, sendParam, sendParamGroup } from './params.js';
import { createKnob, createToggle, createMultiToggle } from './knob.js';

const link = new MidiLink();
let voices = [];
let presets = [];
let selectedVoiceKey = null;
// Display name of whatever selectedVoiceKey currently points at - kept
// alongside it (rather than re-derived from the DOM) so Save Voice/Save Kit
// have a clean name to suggest as the saved file's name.
let selectedVoiceLabel = null;
// The raw voice object behind selectedVoiceKey, when it's a plain Drum
// Kit/SFX Kit voice (not a preset) - Save Kit needs its bank/program to
// embed in the .qykit file so Load Kit can select the right kit voice.
let selectedVoiceObj = null;
const expandedVoices = new Set();

// A live mirror of every parameter the user has touched this session, kept
// independent of the DOM (only one section/part's knobs are ever actually
// rendered at a time) so a full .qyparam snapshot can be built regardless of
// which section/part is currently on screen, and so switching away from a
// part/section and back doesn't forget what was dialed in.
const paramState = {
  system: {}, reverb: {}, chorus: {}, variation: {},
  multiPart: {}, // { [part]: { [rowName]: value } }
  // Drum Setup parameter memory belongs to whichever kit VOICE it's dialed
  // in on, not to a MIDI channel - the same kit sounds identical no matter
  // which channel happens to be playing it, and a channel can play a
  // different kit entirely from one moment to the next. Keying storage by
  // kit (bankMsb:program) rather than by channel means a value dialed in
  // while Channel 3 had DR1 loaded is still found later when DR1 is being
  // viewed on Channel 7, or when saving/loading a .qykit for DR1 - none of
  // which have any particular channel in common.
  drumSetup: {}, // { [`${bankMsb}:${program}:${note}`]: { [rowName]: value } }
};
function paramContextKey(sectionKey, context) {
  if (sectionKey === 'multiPart') return String(context.part);
  if (sectionKey === 'drumSetup') return `${context.kitKey}:${context.note}`;
  return 'global';
}

function getParamStore(sectionKey, contextKey) {
  const bucket = paramState[sectionKey];
  if (contextKey === 'global') return bucket;
  if (!bucket[contextKey]) bucket[contextKey] = {};
  return bucket[contextKey];
}

// One store per section/context - kept as a one-element array (rather than
// a bare store) so the row-building code that writes into it doesn't need
// two different code paths for Drum Setup vs everything else.
function paramStoresForContext(sectionKey, context) {
  const key = paramContextKey(sectionKey, context);
  const store = getParamStore(sectionKey, key);
  return store ? [store] : [];
}

// Mirrors paramState, one boolean per row name per context: true means that
// row's "Active"/"Ignored" toggle is set to Ignored - live edits (including
// Reset) still update paramState as normal so Save keeps whatever's dialed
// in, but no SysEx goes out for it, and loading a .qyparam skips resending
// it too. Uses the same context keys as paramState (paramContextKey), so an
// ignored flag set while editing Part 3 only ever applies to Part 3, etc.
const ignoredState = {
  system: {}, reverb: {}, chorus: {}, variation: {},
  multiPart: {}, drumSetup: {},
};
function getIgnoredStore(sectionKey, contextKey) {
  const bucket = ignoredState[sectionKey];
  if (contextKey === 'global') return bucket;
  if (!bucket[contextKey]) bucket[contextKey] = {};
  return bucket[contextKey];
}

const el = (id) => document.getElementById(id);

// User-supplied names (a loaded .qyvoice/.qykit's filename or its embedded
// JSON "name" field) get displayed via innerHTML in a few places below - a
// shared file with a name like "<img src=x onerror=...>" would otherwise
// execute as markup rather than showing as plain text. Escape any such
// string before interpolating it into an innerHTML template.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
const inputSelect = el('input-select');
const outputSelect = el('output-select');
const channelSelect = el('channel-select');
const connectBtn = el('connect-btn');
const statusEl = el('status');
const resetSectionBtn = el('reset-section-btn');
const savePatchBtn = el('save-patch-btn');
const loadPatchBtn = el('load-patch-btn');
const patchFileInput = el('patch-file-input');
const voicePartSelect = el('voice-part-select');
const bankSelect = el('bank-select');
const categorySelect = el('category-select');
const searchBox = el('search-box');
const saveVoiceBtn = el('save-voice-btn');
const loadVoiceBtn = el('load-voice-btn');
const voiceFileInput = el('voice-file-input');
const saveKitBtn = el('save-kit-btn');
const loadKitBtn = el('load-kit-btn');
const kitFileInput = el('kit-file-input');
const voiceListEl = el('voice-list');
const logOutput = el('log-output');

// iPadOS 13+ reports navigator.platform as 'MacIntel', same as a real Mac -
// maxTouchPoints is what actually distinguishes the two.
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Web MIDI is Chromium-only (no Safari, historically no Firefox) - flag it
// up front instead of only surfacing an error once someone clicks Connect.
// iOS gets its own message: every iOS browser (Safari, Chrome, Firefox) is
// required by Apple to use WebKit, which has never implemented Web MIDI, so
// "open this in Chrome" - correct advice on desktop or Android - is actively
// wrong there.
if (!navigator.requestMIDIAccess) {
  if (isIOS()) {
    el('no-midi-banner').innerHTML =
      "iOS doesn't support Web MIDI in any browser - Safari, Chrome, and " +
      "Firefox for iOS all use Apple's WebKit engine under the hood, which " +
      "hasn't implemented it. Open this page on a desktop browser, or on " +
      '<strong>Chrome</strong>/<strong>Edge</strong> on Android, instead.';
  }
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

// Tooltip open state is tracked with a class toggled only by this exact
// button's own mouseenter/mouseleave, rather than a bare CSS :hover on
// .attention-icon - see the .tooltip-open rule in style.css for why.
document.querySelectorAll('.attention-icon').forEach((btn) => {
  btn.addEventListener('mouseenter', () => btn.classList.add('tooltip-open'));
  btn.addEventListener('mouseleave', () => btn.classList.remove('tooltip-open'));
});

function currentChannel() {
  return channelSelect.value === 'all' ? 'all' : Number(channelSelect.value || 0);
}

function refreshCategoryOptions() {
  categorySelect.hidden = bankSelect.value === 'sfxkit' || bankSelect.value === 'userVoice' || bankSelect.value === 'userKit';
  const cats = categoriesFor(voices, bankSelect.value).sort();
  categorySelect.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${c}">${c}</option>`).join('');
  categorySelect.value = '';
  el('drum-kit-hint').hidden = bankSelect.value !== 'drum' && bankSelect.value !== 'sfxkit' && bankSelect.value !== 'userKit';
}

// User Voice/User Kit are loaded from .qyvoice/.qykit files rather than
// voices.json, so they live in their own arrays instead of the shared
// `voices` list - each entry is self-contained (no bank/category to filter
// by, no XG address of its own).
let userVoices = [];
let userKits = [];

// Save Voice only makes sense once a real Normal/SFX voice (or one of its
// presets) is highlighted as the thing to snapshot; Save Kit only makes
// sense once a Drum Kit/SFX Kit voice is highlighted. selectedVoiceKey
// always starts with the bank string for whatever's selected (plain voice
// keys are "bank:program:msb:lsb", preset keys prefix that same voice key),
// so its first segment tells us which case (if either) currently applies.
function updateSaveButtonsState() {
  const bank = selectedVoiceKey?.split(':')[0];
  saveVoiceBtn.disabled = !(bank === 'normal' || bank === 'sfx' || bank === 'userVoice');
  saveKitBtn.disabled = !(bank === 'drum' || bank === 'sfxkit' || bank === 'userKit');
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

// Picking a voice or preset only ever targets the one part selected in the
// Voice Browser's own Part picker - it used to blast to every part (or ride
// the connect bar's Channel for 1-16 and leave 17-32 unreachable), which
// meant one click could silently change everything else playing on the
// device. Voice selection goes through Multi Part's own Bank Select/Program
// Number XG Parameter Change rows (part-addressed) rather than plain MIDI
// Bank Select/Program Change (channel-addressed), so it works identically
// for all 32 parts, not just the 16 that map to a live channel.
function applyVoiceToPart(part, voice) {
  const section = parameters.multiPart;
  const store = getParamStore('multiPart', String(part));
  const fields = [
    ['Bank Select MSB', voice.bankMsb],
    ['Bank Select LSB', voice.bankLsb],
    ['Program Number', voice.program - 1], // voices.json's Program # is 1-128; wire value is 0-127
  ];
  for (const [name, value] of fields) {
    const row = section.params.find((r) => r.name === name);
    if (!row) continue;
    store[row.name] = value;
    try {
      sendParam(link, 0, section, { part }, row, value);
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  }
}

// Selecting a Drum Kit/SFX Kit voice for a Ds1/Ds2/Ds3 slot can't go through
// applyVoiceToPart above - that's Part-addressed, and there's no reliable
// way to know which Part (if any) has its Rcv Channel pointed at the Ds
// slot's fixed Channel (Ds1->1, Ds2->2, Ds3->3 - see README.md). Sending
// plain real-time MIDI Bank Select (CC0/CC32) + Program Change directly on
// that Channel instead matches exactly what turning the datawheel on the
// device's own front panel produces (see handleIncomingVoiceChange, which
// listens for this same message shape), so it reaches whatever's actually
// listening on that Channel without needing to guess a Part.
function sendVoiceSelectToChannel(channel, voice) {
  try {
    link.send(new Uint8Array([0xb0 | channel, 0, voice.bankMsb]));
    link.send(new Uint8Array([0xb0 | channel, 32, voice.bankLsb]));
    link.send(new Uint8Array([0xc0 | channel, voice.program - 1]));
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

// Selecting a new voice or preset is meant to be a fresh start for the
// part - every Multi Part knob resets to its own default first, then the
// voice's Bank Select/Program Number (and, for a preset, its own specific
// overrides) get applied on top. This used to only reset a small curated
// list of "preset-touched" params (filter/EG/effects sends/vibrato),
// leaving everything else (Note Shift, Detune, Velocity Sense, etc.) stuck
// at whatever a previously-selected voice/preset had left on the part.
function resetPartToDefaults(part) {
  const section = parameters.multiPart;
  const store = getParamStore('multiPart', String(part));
  const context = { part };
  for (const row of expandRows(section.params)) {
    const value = resolveDefault(row, context);
    if (typeof value !== 'number') continue;
    // Record before sending (and keep going even if a send fails) so one
    // bad message can't both abort the rest of the reset and leave Save
    // holding a stale value for the parts it never reached.
    store[row.name] = value;
    try {
      sendParam(link, 0, section, { part }, row, value);
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  }
}

// The knobs on screen only reflect whatever part/section was rendered last -
// refresh them now if the part just touched is also the one currently on
// screen, otherwise a voice/preset pick would silently update the
// device/paramState but leave stale values visible until the user
// navigates away and back.
function refreshIfViewingPart(part) {
  if (sectionSelect.value === 'multiPart' && Number(partSelect.value) === part) renderParamPanel();
}

function applyPreset(preset, part) {
  const voice = voices.find((v) => v.bank === preset.voice.bank && v.bankMsb === preset.voice.bankMsb &&
    v.bankLsb === preset.voice.bankLsb && v.program === preset.voice.program);
  if (!voice) return;
  resetPartToDefaults(part);
  applyVoiceToPart(part, voice);
  const section = parameters.multiPart;
  const store = getParamStore('multiPart', String(part));
  for (const p of preset.params) {
    const row = section.params.find((r) => r.name === p.name);
    if (row) {
      store[row.name] = p.value;
      try {
        sendParam(link, 0, section, { part }, row, p.value);
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
    }
  }
  refreshIfViewingPart(part);
}

// A preset built from a full 32-part .qyvoice snapshot (see promptDsSlotChannel's
// sibling saveVoiceBtn handler) has its own per-part voice baked into each
// part's own Bank Select/Program Number - unlike a curated single-part
// preset, there's no single shared base voice to apply first, so this just
// replays every part's full row data as-is (reusing
// applyUserVoiceParamsToPart, which already handles a full row object).
// Ignores "Apply to" Part entirely, same reasoning as loading a full User
// Voice. Yields between parts and reports progress since this is a lot of
// data (up to 32 x ~48 messages).
async function applyPresetAllParts(preset, onProgress) {
  const partKeys = Object.keys(preset.parts);
  for (let i = 0; i < partKeys.length; i++) {
    applyUserVoiceParamsToPart(Number(partKeys[i]), preset.parts[partKeys[i]]);
    onProgress?.(i + 1, partKeys.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Full current-value snapshot of every Multi Part row for one part - unlike
// paramState (which only ever holds rows the user has actually rendered/
// touched), this always returns a complete set by falling back through the
// same stored -> default -> dataMin chain each knob itself uses, so Save
// Voice captures a real, complete voice even for a part never opened here.
// Rcv Channel is routing (which MIDI channel feeds this part), not part of
// the sound - it isn't captured, so applying a saved voice to any part
// leaves that part's own Rcv Channel alone (which follows the part number
// by default) instead of carrying over whatever channel the source part
// happened to be listening on.
const VOICE_SNAPSHOT_EXCLUDE = new Set(['Rcv Channel']);

function snapshotPartVoice(part) {
  const section = parameters.multiPart;
  const store = getParamStore('multiPart', String(part));
  const context = { part };
  const params = {};
  for (const row of expandRows(section.params)) {
    if (VOICE_SNAPSHOT_EXCLUDE.has(row.name)) continue;
    params[row.name] = store[row.name] ?? resolveDefault(row, context) ?? row.dataMin;
  }
  return params;
}

// Sends and records every field of a saved User Voice snapshot onto a part.
// Unlike applyPreset, there's no "reset touched params first" step needed -
// a snapshot already has a value for every row, so it fully overwrites the
// part on its own.
function applyUserVoiceParamsToPart(part, params) {
  const section = parameters.multiPart;
  const store = getParamStore('multiPart', String(part));
  for (const row of expandRows(section.params)) {
    if (VOICE_SNAPSHOT_EXCLUDE.has(row.name) || !(row.name in params)) continue;
    const value = params[row.name];
    store[row.name] = value;
    try {
      sendParam(link, 0, section, { part }, row, value);
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  }
}

// Applies every one of a saved User Voice's 32 Parts - a lot more data than
// a single part, so this yields back to the event loop between parts
// (keeping the tab responsive and letting a progress popup actually
// repaint) and reports progress.
async function applyUserVoiceAllParts(parts, onProgress) {
  const partKeys = Object.keys(parts);
  for (let i = 0; i < partKeys.length; i++) {
    applyUserVoiceParamsToPart(Number(partKeys[i]), parts[partKeys[i]]);
    onProgress?.(i + 1, partKeys.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Full current-value snapshot of every Drum Setup row for every note (the
// QY70/QY100's usable note range) for one kit - same complete-snapshot
// reasoning as snapshotPartVoice, just per-note instead of per-part.
function snapshotKitParams(kitKey) {
  const section = parameters.drumSetup;
  const [lo, hi] = section.noteRange;
  const notes = {};
  for (let note = lo; note <= hi; note++) {
    const store = getParamStore('drumSetup', `${kitKey}:${note}`);
    const context = { note };
    const params = {};
    for (const row of expandRows(section.params)) {
      params[row.name] = store[row.name] ?? resolveDefault(row, context) ?? row.dataMin;
    }
    notes[note] = params;
  }
  return notes;
}

// Loads a saved User Kit snapshot into the app's own state under the kit's
// own identity, purely local - Drum Setup has no "which channel" concept for
// this (a kit's parameters aren't tied to any channel - see paramState), so
// this just restores what you'll see/edit in the web console.
function loadKitParamsIntoStore(kitKey, notes) {
  const section = parameters.drumSetup;
  for (const [noteStr, params] of Object.entries(notes)) {
    const note = Number(noteStr);
    const store = getParamStore('drumSetup', `${kitKey}:${note}`);
    for (const row of expandRows(section.params)) {
      if (row.name in params) store[row.name] = params[row.name];
    }
  }
}

const KIT_PUSH_WARNING = "This briefly plays through every note in the kit to register each one's settings on the device - avoid touching the QY70/QY100 until it finishes.";

// The QY70/QY100's Drum Setup edit target follows whichever note was most
// recently played - same as the front panel's own Drum Edit screen (see the
// "Tip: Playing a note..." hint above), and confirmed by hardware testing:
// sending Parameter Change data for a note that was never actually
// triggered gets silently ignored. So each note gets a brief Note On/Off
// first, to make the device treat it as the current edit target, before its
// parameters go out.
const NOTE_TRIGGER_MS = 30;

// Loading a saved User Kit/kit preset only ever pushed its per-note Drum
// Setup Parameter Change data, deliberately never a voice select - that
// avoided an old bug where re-selecting a voice reset a channel's Drum
// Setup memory and raced the freshly-pushed data (see git history). But
// that meant loading only "worked" if the device already happened to be on
// the right kit for that Ds slot already - unlike pushing the same kit as a
// plain Voice Browser entry, which does select the voice and reportedly
// works correctly. sendVoiceSelectToChannel (added later) sends real-time
// MIDI directly on the exact numeric Channel rather than hoping a Part's
// Rcv Channel lines up with it, which is what the old bug actually traced
// back to - so selecting the voice first here, then waiting this long
// before pushing notes (giving the device's own reset time to settle),
// should get the same reliable behavior without the old race. Unverified
// against real hardware - the exact settle time may need adjusting.
const VOICE_SETTLE_MS = 80;

// Pushes a saved User Kit snapshot's note parameters live to the device on
// one channel - separate from loadKitParamsIntoStore (which just updates
// the app's own state) so a caller with no live output selected still gets
// its knobs updated even though these sends fail. A full kit means playing
// and re-parameterizing every one of its ~79 notes in turn, so this yields
// back to the event loop every note (keeping the tab responsive and letting
// a progress popup actually repaint) and reports progress if the caller
// wants to show one.
async function sendKitNotesToChannel(drumHigh, notes, onProgress) {
  const section = parameters.drumSetup;
  const channel = (drumHigh - 0x30) & 0x0f;
  const entries = Object.entries(notes);
  for (let i = 0; i < entries.length; i++) {
    const [noteStr, params] = entries[i];
    const note = Number(noteStr);
    try {
      link.send(new Uint8Array([0x90 | channel, note, 100]));
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
    // Also yields back to the event loop every note - a backgrounded/
    // unfocused tab still runs timers (just throttled), keeping a long push
    // from stalling if the user alt-tabs away mid-push.
    await new Promise((resolve) => setTimeout(resolve, NOTE_TRIGGER_MS));
    try {
      link.send(new Uint8Array([0x80 | channel, note, 0]));
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
    for (const row of expandRows(section.params)) {
      if (!(row.name in params)) continue;
      try {
        sendParam(link, 0, section, { drumHigh, note }, row, params[row.name]);
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
    }
    onProgress?.(i + 1, entries.length);
  }
  // Belt-and-suspenders All Notes Off (CC 123) once the whole push/load is
  // done - every note above already gets its own matched Note On/Off, but
  // this guarantees nothing is left ringing on the channel even if a Note
  // Off got dropped, or something was already sounding before the push
  // started.
  try {
    link.send(new Uint8Array([0xb0 | channel, 123, 0]));
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

function renderUserVoiceList() {
  voiceListEl.innerHTML = '';
  for (const entry of userVoices) {
    const key = `userVoice:${entry.id}`;
    const li = document.createElement('li');
    li.dataset.key = key;
    if (key === selectedVoiceKey) li.classList.add('selected');
    li.innerHTML = `<span class="preset-toggle-spacer"></span><span>${escapeHtml(entry.name)}</span>` +
      `<button type="button" class="push-voice-btn">Push</button>`;
    li.addEventListener('click', () => {
      selectedVoiceKey = key;
      selectedVoiceLabel = entry.name;
      renderVoiceList();
    });
    li.querySelector('.push-voice-btn').addEventListener('click', async (evt) => {
      evt.stopPropagation();
      if (entry.parts) {
        const ok = await showConfirm('Are you sure?', confirmApplyMessage(entry.name, 'all 32 Multi Part parts'), 'Apply', { html: true });
        if (!ok) return;
        showProgress(`Loading ${entry.name}`, 'This applies all 32 Multi Part parts - avoid touching the QY70/QY100 until it finishes.');
        try {
          await applyUserVoiceAllParts(entry.parts, updateProgress);
        } catch (err) {
          statusEl.textContent = `Error: ${err.message}`;
        } finally {
          hideProgress();
        }
        selectedVoiceKey = key;
        selectedVoiceLabel = entry.name;
        renderVoiceList();
        renderParamPanel();
      } else {
        // Legacy single-part .qyvoice files (saved before Save Voice
        // started capturing all 32 parts at once) still apply to whichever
        // Part is picked in "Apply to" above.
        const part = Number(voicePartSelect.value);
        const ok = await showConfirm('Are you sure?', confirmApplyMessage(entry.name, partLabel(part)), 'Apply', { html: true });
        if (!ok) return;
        try {
          applyUserVoiceParamsToPart(part, entry.params);
        } catch (err) {
          statusEl.textContent = `Error: ${err.message}`;
        }
        selectedVoiceKey = key;
        selectedVoiceLabel = entry.name;
        renderVoiceList();
        refreshIfViewingPart(part);
      }
    });
    voiceListEl.appendChild(li);
  }
  updateSaveButtonsState();
}

function renderUserKitList() {
  voiceListEl.innerHTML = '';
  for (const entry of userKits) {
    const key = `userKit:${entry.id}`;
    const li = document.createElement('li');
    li.dataset.key = key;
    if (key === selectedVoiceKey) li.classList.add('selected');
    li.innerHTML = `<span class="preset-toggle-spacer"></span><span>${escapeHtml(entry.name)}</span>` +
      `<button type="button" class="push-voice-btn">Push</button>`;
    li.addEventListener('click', () => {
      selectedVoiceKey = key;
      selectedVoiceLabel = entry.name;
      const kitIndex = drumKits.findIndex((k) => k.bankMsb === entry.voice.bankMsb && k.program === entry.voice.program);
      selectedVoiceObj = kitIndex === -1 ? null : drumKits[kitIndex];
      renderVoiceList();
      if (kitIndex !== -1) {
        sectionSelect.value = 'drumSetup';
        drumkitSelect.value = kitIndex;
        populateNoteSelect();
        renderParamPanel();
      }
    });
    li.querySelector('.push-voice-btn').addEventListener('click', async (evt) => {
      evt.stopPropagation();
      const kitIndex = drumKits.findIndex((k) => k.bankMsb === entry.voice.bankMsb && k.program === entry.voice.program);
      if (kitIndex === -1) {
        statusEl.textContent = 'Error: this kit voice isn\'t in the current voice list.';
        return;
      }
      const ok = await showConfirm('Are you sure?', confirmApplyToHighlightedTrackMessage(entry.name), 'Apply', { html: true });
      if (!ok) return;
      const kit = drumKits[kitIndex];
      loadKitParamsIntoStore(`${kit.bankMsb}:${kit.program}`, entry.notes);
      const ch = await promptDsSlotChannel('Which Drum Setup slot are you loading to?', {
        kitTypeLabel: entry.voice.bank === 'sfxkit' ? 'SFX' : 'drum',
      });
      if (ch === null) return;
      showProgress(`Loading ${entry.name}`, KIT_PUSH_WARNING);
      try {
        // Select the kit's own voice on this Ds slot's Channel first (same
        // real-time MIDI mechanism the plain Voice Browser entry uses, not
        // Part-addressed XG SysEx - see VOICE_SETTLE_MS above for why this
        // is safe here where it wasn't before), then wait for the device's
        // own voice-change reset to settle before pushing the saved notes -
        // otherwise this only actually "loads" the kit when the device
        // already happens to be on it already.
        sendVoiceSelectToChannel(ch, entry.voice);
        await new Promise((resolve) => setTimeout(resolve, VOICE_SETTLE_MS));
        await sendKitNotesToChannel(0x30 + ch, entry.notes, updateProgress);
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      } finally {
        hideProgress();
      }
      selectedVoiceKey = key;
      selectedVoiceLabel = entry.name;
      selectedVoiceObj = kit;
      renderVoiceList();
      sectionSelect.value = 'drumSetup';
      drumkitSelect.value = kitIndex;
      populateNoteSelect();
      renderParamPanel();
      await showAlert(
        'Kit loaded',
        `Ds${ch + 1}'s parameters have been set to ${entry.name}. Navigate to Ds${ch + 1} on any track on your device to hear it.`
      );
    });
    voiceListEl.appendChild(li);
  }
  updateSaveButtonsState();
}

function renderVoiceList() {
  if (bankSelect.value === 'userVoice') { renderUserVoiceList(); return; }
  if (bankSelect.value === 'userKit') { renderUserKitList(); return; }
  const filtered = currentFilteredVoices();
  const search = searchBox.value.trim().toLowerCase();
  voiceListEl.innerHTML = '';
  let lastCategory = null;
  for (const v of filtered) {
    if (v.category && v.category !== lastCategory) {
      const divider = document.createElement('li');
      divider.className = 'voice-category-divider';
      divider.textContent = v.category;
      voiceListEl.appendChild(divider);
    }
    lastCategory = v.category || lastCategory;
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
    li.innerHTML = `${toggle}<span>${escapeHtml(voiceDisplayName(v))}${badge}</span>` +
      `<span class="voice-meta">${escapeHtml(bankLabel(v.bank))} P${v.program} B${v.bankLsb}</span>` +
      `<button type="button" class="push-voice-btn">Push</button>`;
    if (voicePresets.length) {
      li.querySelector('.preset-toggle').addEventListener('click', (evt) => {
        evt.stopPropagation();
        if (expandedVoices.has(key)) expandedVoices.delete(key);
        else expandedVoices.add(key);
        renderVoiceList();
      });
    }
    li.addEventListener('click', () => {
      selectedVoiceKey = key;
      selectedVoiceLabel = voiceDisplayName(v);
      selectedVoiceObj = v;
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
    li.querySelector('.push-voice-btn').addEventListener('click', async (evt) => {
      evt.stopPropagation();
      const name = voiceDisplayName(v);
      let part;
      if (v.bank === 'drum' || v.bank === 'sfxkit') {
        const ok = await showConfirm('Are you sure?', confirmApplyMessage(name, partLabel(Number(voicePartSelect.value))), 'Apply', { html: true });
        if (!ok) return;
        const ch = await promptDsSlotChannel('Which Drum Setup slot are you selecting this kit for?', {
          allowOtherTrack: true,
          otherTrackLabel: v.bank === 'sfxkit' ? 'Sfx' : 'Dr',
          kitTypeLabel: v.bank === 'sfxkit' ? 'SFX' : 'drum',
        });
        if (ch === null) return;
        if (ch === 'other') {
          // Falls through to the regular Part-addressed apply below, same as
          // any non-drum voice.
          part = Number(voicePartSelect.value);
        } else {
          sendVoiceSelectToChannel(ch, v);
          selectedVoiceKey = key;
          selectedVoiceLabel = name;
          selectedVoiceObj = v;
          renderVoiceList();
          const kitIndex = drumKits.findIndex((k) => k.bankMsb === v.bankMsb && k.program === v.program);
          if (kitIndex !== -1) {
            sectionSelect.value = 'drumSetup';
            drumkitSelect.value = kitIndex;
            populateNoteSelect();
            renderParamPanel();
          }
          await showAlert('Kit selected', `${name} has been selected for Ds${ch + 1} (Channel ${ch + 1}). Navigate to Ds${ch + 1} on your device to hear it.`);
          return;
        }
      } else {
        part = Number(voicePartSelect.value);
        const ok = await showConfirm('Are you sure?', confirmApplyMessage(name, partLabel(part)), 'Apply', { html: true });
        if (!ok) return;
      }
      try {
        resetPartToDefaults(part);
        applyVoiceToPart(part, v);
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
      selectedVoiceKey = key;
      selectedVoiceLabel = name;
      selectedVoiceObj = v;
      renderVoiceList();
      refreshIfViewingPart(part);
    });
    voiceListEl.appendChild(li);

    if (voicePresets.length && expanded) {
      for (const preset of voicePresets) {
        const presetKey = `${key}:preset:${preset.id}`;
        const presetLi = document.createElement('li');
        presetLi.className = 'preset-item';
        presetLi.dataset.key = presetKey;
        if (presetKey === selectedVoiceKey) presetLi.classList.add('selected');
        presetLi.innerHTML = `<span>${escapeHtml(preset.name)}</span><button type="button" class="push-voice-btn">Push</button>`;
        presetLi.addEventListener('click', () => {
          selectedVoiceKey = presetKey;
          selectedVoiceLabel = preset.name;
          if (preset.notes) selectedVoiceObj = v;
          renderVoiceList();
          if (preset.notes) {
            const kitIndex = drumKits.findIndex((k) => k.bankMsb === v.bankMsb && k.program === v.program);
            if (kitIndex !== -1) {
              sectionSelect.value = 'drumSetup';
              drumkitSelect.value = kitIndex;
              populateNoteSelect();
              renderParamPanel();
            }
          }
        });
        presetLi.querySelector('.push-voice-btn').addEventListener('click', async (evt) => {
          evt.stopPropagation();
          if (preset.notes) {
            const kitIndex = drumKits.findIndex((k) => k.bankMsb === v.bankMsb && k.program === v.program);
            if (kitIndex === -1) { statusEl.textContent = 'Error: this kit voice isn\'t in the current voice list.'; return; }
            const ok = await showConfirm('Are you sure?', confirmApplyMessage(preset.name, partLabel(Number(voicePartSelect.value))), 'Apply', { html: true });
            if (!ok) return;
            const kitKey = `${v.bankMsb}:${v.program}`;
            loadKitParamsIntoStore(kitKey, preset.notes);
            const ch = await promptDsSlotChannel('Which Drum Setup slot are you loading to?', {
              kitTypeLabel: v.bank === 'sfxkit' ? 'SFX' : 'drum',
            });
            if (ch === null) return;
            showProgress(`Loading ${preset.name}`, KIT_PUSH_WARNING);
            try {
              // Select the preset's own kit voice first, then settle - see
              // VOICE_SETTLE_MS above.
              sendVoiceSelectToChannel(ch, v);
              await new Promise((resolve) => setTimeout(resolve, VOICE_SETTLE_MS));
              await sendKitNotesToChannel(0x30 + ch, preset.notes, updateProgress);
            } catch (err) {
              statusEl.textContent = `Error: ${err.message}`;
            } finally {
              hideProgress();
            }
            selectedVoiceKey = presetKey;
            selectedVoiceLabel = preset.name;
            selectedVoiceObj = v;
            renderVoiceList();
            sectionSelect.value = 'drumSetup';
            drumkitSelect.value = kitIndex;
            populateNoteSelect();
            renderParamPanel();
            await showAlert('Kit loaded', `Ds${ch + 1}'s parameters have been set to ${preset.name}. Navigate to Ds${ch + 1} on any track on your device to hear it.`);
            return;
          } else if (preset.parts) {
            const ok = await showConfirm('Are you sure?', confirmApplyMessage(preset.name, 'all 32 Multi Part parts'), 'Apply', { html: true });
            if (!ok) return;
            showProgress(`Applying ${preset.name}`, 'This applies all 32 Multi Part parts - avoid touching the QY70/QY100 until it finishes.');
            try {
              await applyPresetAllParts(preset, updateProgress);
            } catch (err) {
              statusEl.textContent = `Error: ${err.message}`;
            } finally {
              hideProgress();
            }
            renderParamPanel();
          } else {
            const part = Number(voicePartSelect.value);
            const ok = await showConfirm('Are you sure?', confirmApplyMessage(preset.name, partLabel(part)), 'Apply', { html: true });
            if (!ok) return;
            try {
              applyPreset(preset, part);
            } catch (err) {
              statusEl.textContent = `Error: ${err.message}`;
            }
          }
          selectedVoiceKey = presetKey;
          selectedVoiceLabel = preset.name;
          renderVoiceList();
        });
        voiceListEl.appendChild(presetLi);
      }
    }
  }
  updateSaveButtonsState();
}

// Parts 25-32 (the "Hidden" group in populatePartSelect, 0-indexed 24-31)
// have no real bearing on Drum Setup's Ds1/Ds2/Ds3 slots or any live channel
// (see promptDsSlotChannel/README.md) - a Drum Kit/SFX Kit/User Kit picked
// for one of them can't ever be selected for a Ds slot or a channel that
// matters, so those banks are removed from the dropdown entirely there
// rather than letting the click end up going nowhere useful. "User Voice"
// is never removed, so it doubles as the stable insertion point these are
// restored relative to.
const KIT_ONLY_BANKS = ['drum', 'sfxkit', 'userKit'];
const kitOnlyBankOptions = Object.fromEntries(
  KIT_ONLY_BANKS.map((bank) => [bank, bankSelect.querySelector(`option[value="${bank}"]`)]));
const userVoiceOption = bankSelect.querySelector('option[value="userVoice"]');
function isHiddenPart(part) {
  return part >= 24 && part <= 31;
}
function updateBankSelectAvailability() {
  const hidden = isHiddenPart(Number(voicePartSelect.value));
  if (hidden) {
    if (KIT_ONLY_BANKS.includes(bankSelect.value)) {
      bankSelect.value = 'normal';
      bankSelect.dispatchEvent(new Event('change'));
    }
    for (const bank of KIT_ONLY_BANKS) kitOnlyBankOptions[bank].remove();
  } else {
    if (!kitOnlyBankOptions.drum.isConnected) bankSelect.insertBefore(kitOnlyBankOptions.drum, userVoiceOption);
    if (!kitOnlyBankOptions.sfxkit.isConnected) bankSelect.insertBefore(kitOnlyBankOptions.sfxkit, userVoiceOption);
    if (!kitOnlyBankOptions.userKit.isConnected) bankSelect.appendChild(kitOnlyBankOptions.userKit);
  }
}
voicePartSelect.addEventListener('change', updateBankSelectAvailability);

// Switching banks shows a whole different list, so whatever was selected
// before almost never still applies (Save Voice/Kit would otherwise stay
// enabled from a stale selection nothing in the new list is highlighting).
bankSelect.addEventListener('change', () => {
  selectedVoiceKey = null;
  selectedVoiceLabel = null;
  selectedVoiceObj = null;
  searchBox.value = '';
  refreshCategoryOptions();
  renderVoiceList();
});
categorySelect.addEventListener('change', () => {
  searchBox.value = '';
  renderVoiceList();
});
searchBox.addEventListener('input', renderVoiceList);

// No "which Part" prompt - captures every one of the 32 Multi Part parts in
// one file, so this is a full Multi Part snapshot rather than a single
// instrument sound.
// Same Song Mode/Pattern Mode/Hidden groups as "Apply to" above, plus an
// "All 32 Parts" choice up front - lets Save Voice capture either a single
// edited Part (giving Load Voice/Push its own Part picker again, same as a
// legacy single-part preset) or a full multitimbral snapshot.
function populateSaveVoiceTargetSelect(selectEl) {
  populatePartSelect(selectEl);
  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'All 32 Parts';
  selectEl.insertBefore(allOption, selectEl.firstChild);
}

saveVoiceBtn.addEventListener('click', async () => {
  const name = selectedVoiceLabel;
  const target = await showSaveAsDialog({
    title: 'Select Part to Save',
    targetLabelText: 'Part',
    populateTarget: populateSaveVoiceTargetSelect,
    defaultTarget: voicePartSelect.value,
  });
  if (target === null) return;
  let voiceFile;
  let savedDesc;
  if (target === 'all') {
    const parts = {};
    for (let part = 0; part < 32; part++) {
      parts[part] = snapshotPartVoice(part);
    }
    voiceFile = { format: 'qyvoice', version: 2, savedAt: new Date().toISOString(), name, parts };
    savedDesc = 'all 32 Parts';
  } else {
    const part = Number(target);
    voiceFile = { format: 'qyvoice', version: 1, savedAt: new Date().toISOString(), name, params: snapshotPartVoice(part) };
    savedDesc = partLabel(part);
  }
  try {
    const savedName = await writeFile(`${name}.qyvoice`, JSON.stringify(voiceFile, null, 1), 'QY70/QY100 Voice', '.qyvoice');
    await showAlert('Voice saved', `Saved ${savedDesc} as ${savedName}.`);
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

// A short random suffix keeps ids unique even when several files load in
// the same millisecond (batch-loading multiple .qyvoice/.qykit files at
// once - see loadVoiceFiles/loadKitFiles below - can easily hit that).
function newLoadedFileId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// silent skips this file's own list refresh/alert - used by loadVoiceFiles
// to load a batch and only refresh/report once, at the end. Returns
// whether the voice was actually loaded (false on a parse error or a
// cancelled overwrite).
async function loadVoiceFile(text, filename, { silent = false } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    statusEl.textContent = 'Error: not a valid .qyvoice file.';
    return false;
  }
  if (data?.format !== 'qyvoice' || (!data.parts && !data.params)) {
    statusEl.textContent = 'Error: not a valid .qyvoice file.';
    return false;
  }
  const name = filename?.replace(/\.qyvoice$/i, '') || data.name || 'User Voice';
  const existingIndex = userVoices.findIndex((v) => v.name === name);
  if (existingIndex !== -1) {
    const overwrite = await showConfirm(
      'Voice already loaded',
      `A voice named "${name}" is already in User Voice. Overwrite it, or cancel to abort loading?`,
      'Overwrite'
    );
    if (!overwrite) return false;
    userVoices.splice(existingIndex, 1);
  }
  // data.parts is the current (all-32-parts) format; data.params is the
  // older single-part format, kept loadable for files saved before Save
  // Voice started capturing everything at once.
  userVoices.push(data.parts
    ? { id: newLoadedFileId(), name, parts: data.parts }
    : { id: newLoadedFileId(), name, params: data.params });
  if (!silent) {
    bankSelect.value = 'userVoice';
    refreshCategoryOptions();
    renderVoiceList();
    await showAlert('Voice loaded', `Loaded ${filename || 'voice'} into User Voice.`);
  }
  return true;
}

// Loads one or more .qyvoice files (a multi-select file picker can hand
// over several at once) - each file still gets its own overwrite-conflict
// prompt if its name collides, but the voice list only re-renders and
// reports a result once, at the end, instead of once per file.
async function loadVoiceFiles(files) {
  if (files.length === 1) {
    await loadVoiceFile(await files[0].text(), files[0].name);
    return;
  }
  let loaded = 0;
  for (const file of files) {
    if (await loadVoiceFile(await file.text(), file.name, { silent: true })) loaded++;
  }
  if (loaded > 0) {
    bankSelect.value = 'userVoice';
    refreshCategoryOptions();
    renderVoiceList();
  }
  await showAlert('Voices loaded', `Loaded ${loaded} of ${files.length} voice${files.length === 1 ? '' : 's'} into User Voice.`);
}

loadVoiceBtn.addEventListener('click', async () => {
  try {
    if (window.showOpenFilePicker) {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'QY70/QY100 Voice', accept: { 'application/json': ['.qyvoice'] } }],
      });
      await loadVoiceFiles(await Promise.all(handles.map((h) => h.getFile())));
    } else {
      voiceFileInput.click();
    }
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

voiceFileInput.addEventListener('change', async () => {
  const files = [...voiceFileInput.files];
  voiceFileInput.value = '';
  if (files.length) await loadVoiceFiles(files);
});

// Lists the drum/SFX kit voices from the Parameters > Drum Setup kit picker
// (DR1, DR2, ...) rather than a raw channel number - Save Kit only needs a
// channel internally to actually read the live parameter data (Drum Setup
// is channel-addressed), but what the user actually cares about naming is
// which kit these note edits belong to.
function populateDrumKitVoiceSelect(selectEl, bank) {
  const kits = drumKits.filter((k) => k.bank === bank);
  selectEl.innerHTML = kits.map((k) => `<option value="${k.bankMsb}:${k.program}">${escapeHtml(voiceDisplayName(k))}</option>`).join('');
}

saveKitBtn.addEventListener('click', async () => {
  // Selecting (not pushing) a User Kit whose voice isn't in the current
  // voice list (e.g. QY70-only view) leaves selectedVoiceObj unset even
  // though the button's enabled by bank prefix alone - guard against that.
  if (!selectedVoiceObj) { statusEl.textContent = 'Error: this kit voice isn\'t in the current voice list.'; return; }
  const kitBank = selectedVoiceObj.bank;
  const target = await showSaveAsDialog({
    title: 'Select Drum Kit to Save',
    targetLabelText: 'Drum Kit',
    populateTarget: (selectEl) => populateDrumKitVoiceSelect(selectEl, kitBank),
    defaultTarget: `${selectedVoiceObj.bankMsb}:${selectedVoiceObj.program}`,
  });
  if (target === null) return;
  const [bankMsb, program] = target.split(':').map(Number);
  const kitVoice = drumKits.find((k) => k.bank === kitBank && k.bankMsb === bankMsb && k.program === program);
  const kitName = voiceDisplayName(kitVoice);
  const kitFile = {
    format: 'qykit', version: 1, savedAt: new Date().toISOString(),
    name: kitName,
    voice: { bank: kitVoice.bank, bankMsb: kitVoice.bankMsb, bankLsb: kitVoice.bankLsb, program: kitVoice.program },
    notes: snapshotKitParams(`${bankMsb}:${program}`),
  };
  try {
    const savedName = await writeFile(`${kitName}.qykit`, JSON.stringify(kitFile, null, 1), 'QY70/QY100 Drum Kit', '.qykit');
    await showAlert('Kit saved', `Saved ${kitName}'s drum parameters as ${savedName}.`);
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

// silent skips this file's own list refresh/alert - see loadVoiceFile above
// for why. Returns whether the kit was actually loaded.
async function loadKitFile(text, filename, { silent = false } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    statusEl.textContent = 'Error: not a valid .qykit file.';
    return false;
  }
  if (data?.format !== 'qykit' || !data.notes || !data.voice) {
    statusEl.textContent = 'Error: not a valid .qykit file.';
    return false;
  }
  const name = filename?.replace(/\.qykit$/i, '') || data.name || 'User Kit';
  const existingIndex = userKits.findIndex((k) => k.name === name);
  if (existingIndex !== -1) {
    const overwrite = await showConfirm(
      'Kit already loaded',
      `A kit named "${name}" is already in User Kit. Overwrite it, or cancel to abort loading?`,
      'Overwrite'
    );
    if (!overwrite) return false;
    userKits.splice(existingIndex, 1);
  }
  userKits.push({ id: newLoadedFileId(), name, voice: data.voice, notes: data.notes });
  if (!silent) {
    bankSelect.value = 'userKit';
    refreshCategoryOptions();
    renderVoiceList();
    await showAlert('Kit loaded', `Loaded ${filename || 'kit'} into User Kit.`);
  }
  return true;
}

// Loads one or more .qykit files at once - see loadVoiceFiles above.
async function loadKitFiles(files) {
  if (files.length === 1) {
    await loadKitFile(await files[0].text(), files[0].name);
    return;
  }
  let loaded = 0;
  for (const file of files) {
    if (await loadKitFile(await file.text(), file.name, { silent: true })) loaded++;
  }
  if (loaded > 0) {
    bankSelect.value = 'userKit';
    refreshCategoryOptions();
    renderVoiceList();
  }
  await showAlert('Kits loaded', `Loaded ${loaded} of ${files.length} kit${files.length === 1 ? '' : 's'} into User Kit.`);
}

loadKitBtn.addEventListener('click', async () => {
  try {
    if (window.showOpenFilePicker) {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'QY70/QY100 Drum Kit', accept: { 'application/json': ['.qykit'] } }],
      });
      await loadKitFiles(await Promise.all(handles.map((h) => h.getFile())));
    } else {
      kitFileInput.click();
    }
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

kitFileInput.addEventListener('change', async () => {
  const files = [...kitFileInput.files];
  kitFileInput.value = '';
  if (files.length) await loadKitFiles(files);
});

const confirmDialog = el('confirm-dialog');
const confirmDialogOk = el('confirm-dialog-ok');
const confirmDialogCancel = el('confirm-dialog-cancel');

// message is plain text by default; pass html: true to instead set it via
// innerHTML (e.g. for <strong> emphasis) - callers doing that must escape
// any dynamic text themselves (see escapeHtml) since it's not double-escaped.
function showConfirm(title, message, okLabel = 'Send', { html = false } = {}) {
  return new Promise((resolve) => {
    el('confirm-dialog-title').textContent = title;
    if (html) el('confirm-dialog-message').innerHTML = message;
    else el('confirm-dialog-message').textContent = message;
    confirmDialogCancel.hidden = false;
    confirmDialogOk.textContent = okLabel;
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

// Builds the "Apply <name> to <target>?" message showConfirm's callers use
// before applying a voice/preset, with both the name and target bolded to
// stand out - name is untrusted (can come from an uploaded file's name), so
// it's escaped same as anywhere else it's shown as HTML. target is omitted
// for the kit flows, where it isn't decided yet (Ds1/Ds2/Ds3/Dr/Sfx is asked
// in a separate prompt right after this one).
function confirmApplyMessage(name, target) {
  const boldName = `<strong>${escapeHtml(name)}</strong>`;
  return target ? `Apply ${boldName} to <strong>${escapeHtml(target)}</strong>?` : `Apply ${boldName}?`;
}

// User Kit pushes always land wherever the Ds slot resolves to on the
// device itself (see promptDsSlotChannel) - unlike a plain voice, there's
// no "Apply to" Part fallback, so the confirm wording says so directly
// instead of naming a Part that was never actually the target.
function confirmApplyToHighlightedTrackMessage(name) {
  const boldName = `<strong>${escapeHtml(name)}</strong>`;
  return `Apply ${boldName} to currently highlighted track on the QY70/QY100?\n\n` +
    '<span class="confirm-note"><strong>Note:</strong> User Kits are applied to whichever track is currently highlighted on the device.</span>';
}

// A plain acknowledgement popup (OK only, no Cancel) - reuses the same
// dialog as showConfirm for a consistent look, e.g. after a Save/Load
// finishes, rather than a yes/no prompt.
function showAlert(title, message) {
  return new Promise((resolve) => {
    el('confirm-dialog-title').textContent = title;
    el('confirm-dialog-message').textContent = message;
    confirmDialogCancel.hidden = true;
    confirmDialogOk.textContent = 'OK';
    const onOk = () => settle();
    const onBackdropClick = (evt) => { if (evt.target === confirmDialog) settle(); };
    function settle() {
      confirmDialogOk.removeEventListener('click', onOk);
      confirmDialog.removeEventListener('cancel', onOk);
      confirmDialog.removeEventListener('click', onBackdropClick);
      confirmDialog.close();
      resolve();
    }
    confirmDialogOk.addEventListener('click', onOk);
    confirmDialog.addEventListener('cancel', onOk);
    confirmDialog.addEventListener('click', onBackdropClick);
    confirmDialog.showModal();
  });
}

const saveAsDialog = el('save-as-dialog');
const saveAsTitle = el('save-as-title');
const saveAsTargetLabelText = el('save-as-target-label-text');
const saveAsTargetSelect = el('save-as-target-select');
const saveAsOk = el('save-as-ok');
const saveAsCancel = el('save-as-cancel');

// A prompt with just a single dropdown (Part for Save Voice, Drum Kit for
// Save Kit) - picks what gets captured before the browser's own native save
// dialog (if available) opens to let the user name/place the file.
function showSaveAsDialog({ title, targetLabelText, populateTarget, defaultTarget, message }) {
  return new Promise((resolve) => {
    saveAsTitle.textContent = title;
    saveAsTargetLabelText.textContent = targetLabelText;
    populateTarget(saveAsTargetSelect);
    saveAsTargetSelect.value = defaultTarget;
    const messageEl = el('save-as-message');
    // message may be a fixed string, or a function of the target select's
    // current value - the latter lets the explanation change live as the
    // user switches targets (see promptDsSlotChannel's Dr option).
    function refreshMessage() {
      const text = typeof message === 'function' ? message(saveAsTargetSelect.value) : message;
      messageEl.textContent = text || '';
      messageEl.hidden = !text;
    }
    refreshMessage();
    const onOk = () => settle(saveAsTargetSelect.value);
    const onCancel = () => settle(null);
    const onBackdropClick = (evt) => { if (evt.target === saveAsDialog) settle(null); };
    const onTargetChange = () => refreshMessage();
    function settle(result) {
      saveAsOk.removeEventListener('click', onOk);
      saveAsCancel.removeEventListener('click', onCancel);
      saveAsDialog.removeEventListener('cancel', onCancel);
      saveAsDialog.removeEventListener('click', onBackdropClick);
      saveAsTargetSelect.removeEventListener('change', onTargetChange);
      saveAsDialog.close();
      resolve(result);
    }
    saveAsOk.addEventListener('click', onOk);
    saveAsCancel.addEventListener('click', onCancel);
    saveAsDialog.addEventListener('cancel', onCancel);
    saveAsDialog.addEventListener('click', onBackdropClick);
    saveAsTargetSelect.addEventListener('change', onTargetChange);
    saveAsDialog.showModal();
  });
}

// Drum Setup only has three editable slots on the device itself (Ds1/Ds2
// Song mode, Ds3 Pattern mode), each hardwired to a fixed MIDI Channel
// (Ds1->1, Ds2->2, Ds3->3) no matter what Channel a track is actually
// assigned elsewhere - see README.md. There's no way to tell which one is
// open on the device over MIDI (it can only be picked on the device
// itself), so this asks directly rather than guessing from the connect
// bar's Channel selector. Returns the Channel (0-indexed) or null if
// canceled.
// allowOtherTrack adds a 4th "Dr" choice, only meaningful for a plain voice
// select (there's no per-note data to push, so it's free to target any Part
// instead of one of the 3 hardwired Ds channels) - Push Parameters/Load Kit
// callers push real Drum Setup parameter data, which only a genuine Ds1/2/3
// channel can receive, so they never pass this.
async function promptDsSlotChannel(title, { allowOtherTrack = false, otherTrackLabel = 'Dr', kitTypeLabel = 'drum' } = {}) {
  const EDITABLE_PARAGRAPH = `For editable ${kitTypeLabel} kits, navigate to Ds1 or Ds2 (in Song Mode), or Ds3 (in Pattern Mode) on the QY70/QY100's target track part.`;
  const NON_EDITABLE_PARAGRAPH = `For non-editable ${kitTypeLabel} kits, navigate to ${otherTrackLabel} on the QY70/QY100's target track part.`;
  const message = [
    ...(allowOtherTrack ? [NON_EDITABLE_PARAGRAPH, EDITABLE_PARAGRAPH] : [EDITABLE_PARAGRAPH]),
    'This must be done before proceeding.',
  ].join('\n\n');
  const dsSlot = await showSaveAsDialog({
    title,
    targetLabelText: kitTypeLabel === 'SFX' ? 'Drum Setup/SFX slot' : 'Drum Setup slot',
    populateTarget: (selectEl) => {
      const options = ['Ds1 (Song Mode) - Channel 1', 'Ds2 (Song Mode) - Channel 2', 'Ds3 (Pattern Mode) - Channel 3'];
      if (allowOtherTrack) options.push(`${otherTrackLabel} - Other track (not live-editable)`);
      selectEl.innerHTML = options.map((label, i) => `<option value="${i}">${label}</option>`).join('');
    },
    defaultTarget: '0',
    message,
  });
  if (dsSlot === null) return null;
  const idx = Number(dsSlot);
  return allowOtherTrack && idx === 3 ? 'other' : idx;
}

const progressDialog = el('progress-dialog');
const progressDialogTitle = el('progress-dialog-title');
const progressDialogBar = el('progress-dialog-bar');
const progressDialogWarning = el('progress-dialog-warning');
const progressDialogStatus = el('progress-dialog-status');

// A non-interactive popup (no buttons - closed by the caller once its work
// finishes) for operations that send enough MIDI messages to take a
// perceptible amount of time, e.g. pushing a full kit's worth of note data
// (which also briefly plays every note on the device - see
// sendKitNotesToChannel), hence the optional warning text.
function showProgress(title, warning) {
  progressDialogTitle.textContent = title;
  progressDialogWarning.textContent = warning || '';
  progressDialogWarning.hidden = !warning;
  progressDialogBar.value = 0;
  progressDialogStatus.textContent = '';
  progressDialog.showModal();
}

function updateProgress(current, total) {
  progressDialogBar.value = total ? Math.round((current / total) * 100) : 0;
  progressDialogStatus.textContent = `${current} of ${total}`;
}

function hideProgress() {
  progressDialog.close();
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

// Its own dialog rather than showConfirm/showAlert - the pitch has headings,
// a bulleted list, and an image, well past what that dialog's single <p>
// message is meant to hold.
const supportDialog = el('support-dialog');
el('join-btn').addEventListener('click', () => supportDialog.showModal());
el('support-dialog-cancel').addEventListener('click', () => supportDialog.close());
el('support-dialog-join').addEventListener('click', () => {
  window.open('https://www.patreon.com/doffu', '_blank', 'noopener');
  supportDialog.close();
});
supportDialog.addEventListener('click', (evt) => { if (evt.target === supportDialog) supportDialog.close(); });

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
const pushDrumParamsBtn = el('push-drum-params-btn');
const pushParamsBtn = el('push-params-btn');
const pushAllPartsBtn = el('push-all-parts-btn');
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

// Pattern Mode's 8 parts (17-24) are the QY70/QY100's fixed Drum1/Drum2/
// Phrase-Chord/Bass/Chord1-4 pattern tracks, in this order - unlike Song
// Mode's 16 general-purpose parts, so labeling them helps identify which
// pattern track "Apply to" is targeting.
const PATTERN_MODE_PART_LABELS = ['D1', 'D2', 'PC', 'BA', 'C1', 'C2', 'C3', 'C4'];

// Matches the "Part N - D1" style labeling populatePartSelect gives Pattern
// Mode's options, for reuse in confirmation dialog wording.
function partLabel(part) {
  if (part >= 16 && part <= 23) return `Part ${part + 1} - ${PATTERN_MODE_PART_LABELS[part - 16]}`;
  return `Part ${part + 1}`;
}

function populatePartSelect(selectEl) {
  const group = (label, from, to, labels) =>
    `<optgroup label="${label}">${Array.from({ length: to - from + 1 }, (_, i) =>
      `<option value="${from + i}">Part ${from + i + 1}${labels ? ` - ${labels[i]}` : ''}</option>`).join('')}</optgroup>`;
  selectEl.innerHTML =
    group('Song Mode', 0, 15) +
    group('Pattern Mode', 16, 23, PATTERN_MODE_PART_LABELS) +
    group('Hidden', 24, 31);
}

let drumKits = [];

function populateDrumkitSelect() {
  drumKits = voices.filter((v) => v.bank === 'drum' || v.bank === 'sfxkit');
  drumkitSelect.innerHTML = drumKits.map((k, i) =>
    `<option value="${i}">${escapeHtml(k.name)}</option>`).join('');
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
// Program Change can be resolved to the voice it selects - the device
// always sends Bank Select MSB/LSB followed by Program Change as a group
// when its own front panel picks a voice.
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
    // The "3n" address high nibble only has 16 possible values (0-F), so on
    // the wire it addresses a MIDI channel rather than a kit name (there are
    // 20+ kits) - it always affects whatever kit is playing on that channel.
    // Channel "All" sends the same edit to every one of the 16 possible
    // addresses at once. drumHigh/allChannels below are only used to pick
    // where to actually SEND; what gets STORED is keyed by kitKey (the kit
    // selected in the dropdown), independent of which channel is playing it.
    const ch = currentChannel();
    const kit = drumKits[Number(drumkitSelect.value || 0)];
    return {
      drumHigh: ch === 'all' ? null : 0x30 + ch,
      allChannels: ch === 'all',
      note: Number(noteSelect.value || 0),
      kitKey: kit ? `${kit.bankMsb}:${kit.program}` : '0:0',
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
const TOGGLE_PARAMS = new Set(['VariMode', 'Mono/Poly Mode', 'Portamento Switch', 'Key Assign', 'Rcv Note Off', 'Rcv Note On']);

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
// Shared "0-127 raw, centered at 64" relative-adjustment readout.
const rel64Desc = (value) => {
  const n = Math.round(value) - 64;
  return `${n >= 0 ? '+' : ''}${n}`;
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

  // Drum Setup (per-note) - Filter Cutoff Frequency/Filter Resonance are
  // shared with Multi Part, which uses the same 0-127-centered-on-64 scale.
  'Pitch Coarse': semitoneDesc,
  'Pitch Fine': (value) => {
    const cents = Math.round(value) - 64;
    return `${cents >= 0 ? '+' : ''}${cents} cent`;
  },
  'Filter Cutoff Frequency': rel64Desc,
  'Filter Resonance': rel64Desc,
  'EG Attack Rate': rel64Desc,
  'EG Decay1 Rate': rel64Desc,
  'EG Decay2 Rate': rel64Desc,
  'Alternate Group': (value) => (Math.round(value) === 0 ? 'Off' : `Group ${Math.round(value)}`),
  'Key Assign': (value) => (Math.round(value) === 1 ? 'Multi' : 'Single'),
  'Rcv Note Off': (value) => (Math.round(value) === 1 ? 'On' : 'Off'),
  'Rcv Note On': (value) => (Math.round(value) === 1 ? 'On' : 'Off'),
  'Rcv Note Off': (value) => (Math.round(value) === 1 ? 'On' : 'Off'),
  'Rcv Note On': (value) => (Math.round(value) === 1 ? 'On' : 'Off'),
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
  VariMode: 'Whether Variation acts as a shared bus effect like Reverb/Chorus (System - any part can send into it) or is patched directly into one specific part\'s signal path (Insertion - see Variation Part below). Only works in Song Mode.',
  'Variation Part': 'Which part receives the Variation effect directly in its signal chain, when VariMode is set to Insertion. Only works in Song Mode.',
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

// Every voice across every bank, grouped into <optgroup>s, for the Multi
// Part voice picker below - built once and cached since `voices` never
// changes after boot, unlike renderParamPanel which rebuilds its DOM on
// every section/part switch.
let voicePickerOptionsHtml = null;
function voicePickerOptions() {
  if (voicePickerOptionsHtml) return voicePickerOptionsHtml;
  const byBank = new Map();
  for (const v of voices) {
    if (!byBank.has(v.bank)) byBank.set(v.bank, []);
    byBank.get(v.bank).push(v);
  }
  let html = '<option value="">(no match)</option>';
  for (const [bank, list] of byBank) {
    html += `<optgroup label="${escapeHtml(bankLabel(bank))}">`;
    for (const v of list) {
      const label = escapeHtml(voiceDisplayName(v)) + (v.qy100Only ? ' [QY100]' : '');
      html += `<option value="${v.bankMsb}:${v.bankLsb}:${v.program}">${label}</option>`;
    }
    html += '</optgroup>';
  }
  voicePickerOptionsHtml = html;
  return html;
}

function renderParamPanel() {
  const sectionKey = sectionSelect.value;
  const section = parameters[sectionKey];
  partSelect.hidden = sectionKey !== 'multiPart';
  drumkitSelect.hidden = sectionKey !== 'drumSetup';
  noteSelect.hidden = sectionKey !== 'drumSetup';
  drumSetupHint.hidden = sectionKey !== 'drumSetup';
  pushDrumParamsBtn.hidden = sectionKey !== 'drumSetup';
  pushParamsBtn.hidden = sectionKey === 'drumSetup';
  pushAllPartsBtn.hidden = sectionKey !== 'multiPart';

  const context = currentContext(sectionKey);
  const stores = paramStoresForContext(sectionKey, context);
  const ignoredStore = getIgnoredStore(sectionKey, paramContextKey(sectionKey, context));
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

  // Multi Part's Bank Select (MSB+LSB) and Program Number are two separate
  // rows, but together they identify one specific voice - shows that
  // voice's name as each row's live description, refreshed from all three
  // knobs' current values whenever any of them changes. A picker above both
  // rows offers the same thing in reverse: pick a voice by name and have it
  // drive the Bank Select/Program Number knobs (see below, after the groups
  // loop builds the knobs it needs).
  let bankSelectKnobs;
  let bankSelectDescEl;
  let programNumberKnob;
  let programNumberDescEl;
  let voicePickerSelect;
  if (sectionKey === 'multiPart') {
    const pickerRow = document.createElement('div');
    pickerRow.className = 'param-row voice-picker-row';
    // Reuses the Voice Browser's spacer class to roughly line up "Voice"
    // under the info-icon column the rows below it have.
    pickerRow.innerHTML = '<span class="preset-toggle-spacer"></span><span class="param-name">Voice</span>';
    voicePickerSelect = document.createElement('select');
    voicePickerSelect.className = 'voice-picker-select';
    voicePickerSelect.innerHTML = voicePickerOptions();
    voicePickerSelect.addEventListener('change', () => {
      if (!voicePickerSelect.value || !bankSelectKnobs || !programNumberKnob) return;
      const [bankMsb, bankLsb, program] = voicePickerSelect.value.split(':').map(Number);
      const [msbKnob, lsbKnob] = bankSelectKnobs;
      // Bank Select MSB/LSB don't combineSend (see the onChange comment
      // below), so each knob has to fire its own send independently -
      // firing only one would leave the device with a mismatched byte.
      msbKnob.setValue(bankMsb, true);
      lsbKnob.setValue(bankLsb, true);
      programNumberKnob.setValue(program - 1, true);
    });
    pickerRow.appendChild(voicePickerSelect);
    paramListEl.appendChild(pickerRow);
  }
  function refreshBankProgramVoiceName() {
    if (!bankSelectKnobs || !programNumberKnob) return;
    const [msbKnob, lsbKnob] = bankSelectKnobs;
    const bankMsb = Math.round(msbKnob.getValue());
    const bankLsb = Math.round(lsbKnob.getValue());
    const program = Math.round(programNumberKnob.getValue()) + 1; // wire 0-127 -> voices.json 1-128
    const match = voices.find((v) => v.bankMsb === bankMsb && v.bankLsb === bankLsb && v.program === program);
    const text = match ? voiceDisplayName(match) : 'No matching voice';
    if (bankSelectDescEl) bankSelectDescEl.textContent = text;
    if (programNumberDescEl) programNumberDescEl.textContent = text;
    if (voicePickerSelect) voicePickerSelect.value = match ? `${match.bankMsb}:${match.bankLsb}:${match.program}` : '';
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
      // Re-visiting a part/section the user already dialed something into
      // (or reloading a saved .qyparam) should start from that value, not
      // silently snap back to the default - the Reset button still targets
      // the true default via resetValue below, unaffected by this.
      const storedValue = stores[0]?.[row.name];
      const widgetOptions = {
        value: storedValue ?? defaultValue ?? row.dataMin,
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
          if (baseName === 'Bank Select' || baseName === 'Program Number') refreshBankProgramVoiceName();
        },
        // combineSend rows (e.g. Reverb Type's MSB+LSB) are one addressable
        // unit on the wire - the device rejects a message addressed to a
        // later byte alone, so send every knob's current value together.
        // Visually-paired-but-independent rows (e.g. Multi Part's Bank
        // Select MSB/LSB) keep sending their own separate messages.
        onChange: (value) => {
          // Record the whole group together (not just the row that changed)
          // so a partially-touched combineSend pair can't end up saved with
          // one byte stale. This happens before the send attempt below and
          // isn't undone if that send fails - what the user dialed in is
          // still what they dialed in even if the device didn't get it (no
          // output selected, momentary disconnect, etc.), and Save should
          // reflect that rather than silently reverting to the old value.
          for (const s of stores) rows.forEach((r, i) => { s[r.name] = knobs[i].getValue(); });
          if (baseName === 'Bank Select' || baseName === 'Program Number') refreshBankProgramVoiceName();
          // Ignored rows still update the store above (Save keeps whatever's
          // dialed in) but never transmit - covers a live drag/typed value
          // and Reset/Reset All alike, since both fire this same onChange.
          if (rows.some((r) => ignoredStore[r.name])) return;
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
      // Seed the store with this row's resolved starting value right away,
      // not just when the user changes it - otherwise a param that was only
      // ever viewed (never dragged) would be silently missing from Save.
      for (const s of stores) s[row.name] = knob.getValue();
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

    // "Active"/"Ignored" mute switch for this row - Ignored still lets the
    // knob/toggle/reset update its value (and Save still captures it), it
    // just stops that value from actually being transmitted, live or on a
    // .qyparam load (see the onChange handler below and resendSectionContext).
    const ignoreBtn = document.createElement('button');
    ignoreBtn.type = 'button';
    ignoreBtn.className = 'ignore-toggle';
    function renderIgnoreBtn(ignored) {
      ignoreBtn.textContent = ignored ? 'Ignored' : 'Active';
      ignoreBtn.classList.toggle('ignored', ignored);
      ignoreBtn.title = ignored
        ? 'Not sent to the device (value is still tracked and saved) - click to make Active again.'
        : 'Click to stop sending this parameter to the device - its value stays tracked and saved.';
    }
    renderIgnoreBtn(rows.some((r) => ignoredStore[r.name]));
    ignoreBtn.addEventListener('click', () => {
      const nowIgnored = !ignoreBtn.classList.contains('ignored');
      for (const r of rows) {
        if (nowIgnored) ignoredStore[r.name] = true;
        else delete ignoredStore[r.name];
      }
      renderIgnoreBtn(nowIgnored);
    });
    div.appendChild(ignoreBtn);

    paramListEl.appendChild(div);

    if (baseName === 'Bank Select') { bankSelectKnobs = knobs; bankSelectDescEl = descEl; }
    if (baseName === 'Program Number') { programNumberKnob = knobs[0]; programNumberDescEl = descEl; }
    if (baseName === 'VariMode') variModeKnob = knobs[0];
    if (baseName === 'Variation Part') variationPartRowEl = div;
    if (baseName === 'Send Variation To Reverb') sendToReverbRowEl = div;
    if (baseName === 'Send Variation To Chorus') sendToChorusRowEl = div;
    if (variModeKnob && ['VariMode', 'Variation Part', 'Send Variation To Reverb', 'Send Variation To Chorus'].includes(baseName)) {
      updateVariModeDimming(variModeKnob.getValue());
    }
  }
  refreshEffectParamNames();
  refreshBankProgramVoiceName();
}

// ---- Save / Load (.qyparam) ----
// Resends a captured section+context's worth of stored values, reusing the
// same grouping the live UI uses so a combineSend byte pair (e.g. Reverb
// Type MSB+LSB) still goes out as one message.
function resendSectionContext(sectionKey, context, values) {
  if (!values) return;
  const section = parameters[sectionKey];
  const ignoredStore = getIgnoredStore(sectionKey, paramContextKey(sectionKey, context));
  const groups = groupRows(expandRows(section.params));
  for (const { rows, combineSend } of groups) {
    if (rows.some((r) => ignoredStore[r.name])) continue;
    const grouped = rows.length > 1;
    const rowValues = rows.map((r) => values[r.name]);
    if (rowValues.every((v) => v === undefined)) continue;
    try {
      if (combineSend && grouped) {
        // A saved patch might only have captured one byte of a pair (the
        // other was never touched) - fill it with 0 rather than dropping
        // the whole group, so the message still goes out.
        sendParamGroup(link, 0, section, context, rows, rowValues.map((v) => v ?? 0));
      } else {
        rows.forEach((r, i) => { if (rowValues[i] !== undefined) sendParam(link, 0, section, context, r, rowValues[i]); });
      }
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  }
}

// .qyparam only covers System/Reverb/Chorus/Variation - Multi Part and Drum
// Setup are excluded (both Save/Load Parameters and the info-icon tooltip
// next to those buttons agree on this same list).
const QYPARAM_SECTIONS = ['system', 'reverb', 'chorus', 'variation'];

// Resending a whole saved session is still several sections' worth of
// messages, so this collects each resend as a step first, then runs them
// one at a time, yielding back to the event loop between steps (keeping the
// tab responsive and letting a progress popup actually repaint) and
// reporting progress.
async function resendAllFromState(onProgress) {
  const steps = QYPARAM_SECTIONS.map((sectionKey) => () => resendSectionContext(sectionKey, {}, paramState[sectionKey]));
  for (let i = 0; i < steps.length; i++) {
    steps[i]();
    onProgress?.(i + 1, steps.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function buildPatch() {
  const savedParamState = {};
  const savedIgnoredState = {};
  for (const sectionKey of QYPARAM_SECTIONS) {
    savedParamState[sectionKey] = paramState[sectionKey];
    savedIgnoredState[sectionKey] = ignoredState[sectionKey];
  }
  return { format: 'qyparam', version: 2, savedAt: new Date().toISOString(), paramState: savedParamState, ignoredState: savedIgnoredState };
}

// Returns the name actually saved under - the user can rename away from
// suggestedName in the native save dialog, so that's the only way to know
// what the file really ended up called.
async function writeFile(filename, text, description, extension) {
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description, accept: { 'application/json': [extension] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return handle.name;
  }
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return filename;
}

savePatchBtn.addEventListener('click', async () => {
  const filename = `qy-param-${new Date().toISOString().slice(0, 10)}.qyparam`;
  try {
    const savedName = await writeFile(filename, JSON.stringify(buildPatch(), null, 1), 'QY70/QY100 Parameters', '.qyparam');
    await showAlert('Parameters saved', `Saved the current state as ${savedName}.`);
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

async function loadPatchText(text, filename) {
  let patch;
  try {
    patch = JSON.parse(text);
  } catch {
    statusEl.textContent = 'Error: not a valid .qyparam file.';
    return;
  }
  if (patch?.format !== 'qyparam') {
    statusEl.textContent = 'Error: not a valid .qyparam file.';
    return;
  }
  const savedAt = patch.savedAt ? new Date(patch.savedAt).toLocaleString() : 'an unknown time';
  const confirmed = await showConfirm(
    'Load parameters?',
    `This replaces this session's System, Reverb, Chorus, and Variation parameters with the saved state (saved ${savedAt}) and sends it to the device now.`
  );
  if (!confirmed) return;
  Object.assign(paramState, patch.paramState || {});
  Object.assign(ignoredState, patch.ignoredState || {});
  showProgress('Loading parameters', 'This sends the full saved state to the device - avoid touching the QY70/QY100 until it finishes.');
  try {
    await resendAllFromState(updateProgress);
  } finally {
    hideProgress();
  }
  renderParamPanel();
  await showAlert('Parameters loaded', `Loaded ${filename || 'parameters'}.`);
}

loadPatchBtn.addEventListener('click', async () => {
  try {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'QY70/QY100 Parameters', accept: { 'application/json': ['.qyparam'] } }],
      });
      const file = await handle.getFile();
      await loadPatchText(await file.text(), handle.name);
    } else {
      patchFileInput.click();
    }
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

patchFileInput.addEventListener('change', async () => {
  const file = patchFileInput.files[0];
  patchFileInput.value = '';
  if (file) await loadPatchText(await file.text(), file.name);
});

sectionSelect.addEventListener('change', renderParamPanel);
partSelect.addEventListener('change', renderParamPanel);
// This dropdown only picks which note names to display/edit here - it does
// NOT push anything to the device (that's what Push Parameters is for,
// on-demand). See the hint text above: the kit that's actually live is
// whatever's playing on the Channel selected in the connect bar.
drumkitSelect.addEventListener('change', () => { populateNoteSelect(); renderParamPanel(); });
noteSelect.addEventListener('change', renderParamPanel);
// Drum Setup's address depends on the main Channel selector now.
channelSelect.addEventListener('change', () => {
  if (sectionSelect.value === 'drumSetup') renderParamPanel();
});

// Manual re-push of everything currently dialed in (or defaulted) for the
// selected kit across its whole note range - for when live edits didn't
// land on the device (output wasn't connected yet, a message got dropped)
// and switching kits away and back isn't convenient or didn't happen. Sends
// exactly what a manual knob/toggle edit would send for each row (down to
// fanning out to every Channel when Channel is "All" - see the onChange
// handler's context.allChannels branch) - it does NOT re-send Bank
// Select/Program Number the way selecting a kit does, since re-selecting a
// voice on real XG hardware re-initializes that channel's Drum Setup memory
// to factory defaults, which would race against (and wipe out) the very
// values being pushed right after. A single knob edit never re-selects the
// voice either.
// Drum Setup only has three editable slots on the device itself (Ds1/Ds2
// Song mode, Ds3 Pattern mode), and each one is hardwired to a fixed MIDI
// Channel (Ds1->1, Ds2->2, Ds3->3) no matter what Channel a track is
// actually assigned elsewhere - see README.md. The connect bar's Channel
// selector can't tell us which one is open on the device (that can only be
// picked on the device itself), so this asks directly instead of guessing.
pushDrumParamsBtn.addEventListener('click', async () => {
  const kit = drumKits[Number(drumkitSelect.value || 0)];
  if (!kit) return;
  const ch = await promptDsSlotChannel('Which Drum Setup slot is open on your device?');
  if (ch === null) return;
  const kitName = voiceDisplayName(kit);
  const notes = snapshotKitParams(`${kit.bankMsb}:${kit.program}`);
  showProgress(`Pushing ${kitName}'s parameters`, KIT_PUSH_WARNING);
  try {
    await sendKitNotesToChannel(0x30 + ch, notes, updateProgress);
  } finally {
    hideProgress();
  }
  await showAlert('Parameters pushed', `Pushed all of ${kitName}'s drum parameters to Ds${ch + 1} (Channel ${ch + 1}).`);
});

// System/Reverb/Chorus/Variation/Multi Part just resend whatever this app
// currently has stored for the section/context on screen - unlike Drum
// Setup, none of these need a note triggered first, so there's nothing more
// to it than replaying the same sends a live knob edit would make.
pushParamsBtn.addEventListener('click', () => {
  const sectionKey = sectionSelect.value;
  const context = currentContext(sectionKey);
  const values = sectionKey === 'multiPart' ? paramState.multiPart[context.part] : paramState[sectionKey];
  resendSectionContext(sectionKey, context, values);
  statusEl.textContent = 'Parameters pushed.';
});

// Pushes every Multi Part part this app has any stored parameters for (same
// "which parts have anything to push" rule resendAllFromState uses) rather
// than just the part currently on screen.
pushAllPartsBtn.addEventListener('click', async () => {
  const partKeys = Object.keys(paramState.multiPart);
  if (!partKeys.length) { statusEl.textContent = 'No Multi Part parameters to push yet.'; return; }
  showProgress('Pushing all Multi Part parts', 'This resends every part\'s parameters - avoid touching the QY70/QY100 until it finishes.');
  try {
    for (let i = 0; i < partKeys.length; i++) {
      resendSectionContext('multiPart', { part: Number(partKeys[i]) }, paramState.multiPart[partKeys[i]]);
      updateProgress(i + 1, partKeys.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    hideProgress();
  }
  statusEl.textContent = 'All parts pushed.';
});

// ---- Boot ----

(async () => {
  [voices, parameters, drumNotes, presets, effectTypes, effectParams, effectValueTables] = await Promise.all(
    [loadVoices(), loadParameters(), loadDrumNotes(), loadPresets(), loadEffectTypes(), loadEffectParams(), loadEffectValueTables()]);
  refreshCategoryOptions();
  renderVoiceList();
  populatePartSelect(partSelect);
  populatePartSelect(voicePartSelect);
  updateBankSelectAvailability();
  populateDrumkitSelect();
  populateNoteSelect();
  renderParamPanel();
})();
