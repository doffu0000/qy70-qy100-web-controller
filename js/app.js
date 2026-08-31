// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

import { MidiLink } from './midi.js';
import { buildXgSystemOn, buildGmSystemOn, buildMessageWindow, buildMessageWindowLine, buildSectionControl, SECTION, buildSongSelect, buildBitmapWindow } from './sysex.js';
import { encodeMonoBmp16x16, decodeMonoBmp } from './bmp.js';
import { encodeAnimatedGif, decodeAnimatedGif } from './gif.js';
import { loadVoices, filterVoices, categoriesFor, bankLabel, voiceDisplayName } from './voices.js';
import { loadParameters, expandRows, sendParam, sendParamGroup } from './params.js';
import { createKnob, createToggle, createMultiToggle } from './knob.js';

const link = new MidiLink();
let voices = [];
let presets = [];
// Built-in Reverb/Chorus/Variation presets (data/fx_presets.json), keyed by
// section - session-loaded ones (via Load) live alongside them in a
// separate per-section array so a page reload drops back to just the
// built-ins, same as User Voice/User Kit.
let fxPresets = { reverb: [], chorus: [], variation: [] };
const userFxPresets = { reverb: [], chorus: [], variation: [] };
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

// Object.assign(target, jsonParsedFile) is a real prototype-pollution
// vector: a loaded .qyparam/.qyvoice/.qykit/.qyrev/.qycho/.qyvar with an
// own "__proto__" key (JSON.parse happily creates one, no exploit needed
// to get it there) makes the assignment step - not the parse - reach
// through the accessor and swap target's own prototype out from under it.
// Used everywhere a loaded file's object gets merged into live app state,
// in place of a bare Object.assign.
function safeAssign(target, source) {
  for (const key of Object.keys(source || {})) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    target[key] = source[key];
  }
  return target;
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
const voiceFilterActive = el('voice-filter-active');

// User Voice/User Kit ignore the search box and category filter entirely
// (see renderUserVoiceList/renderUserKitList) - showing "results are
// filtered" there would be misleading since nothing's actually being
// filtered out.
function updateVoiceFilterIndicator() {
  const isUserBank = bankSelect.value === 'userVoice' || bankSelect.value === 'userKit';
  const hasSearch = searchBox.value.trim().length > 0;
  const hasCategory = !isUserBank && categorySelect.value !== '';
  voiceFilterActive.hidden = isUserBank || (!hasSearch && !hasCategory);
}
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

// Classifies a message for the Diagnostics tab's type/channel filters -
// deliberately separate from the simple in/out log above, which just
// hard-excludes Clock/Active Sensing rather than offering real filtering.
function classifyMessage(bytes) {
  const status = bytes[0];
  if (status === 0xf0) return { type: 'sysex', channel: null };
  if (status === 0xf8 || status === 0xfe) return { type: 'clock', channel: null };
  if (status === 0xfa || status === 0xfb || status === 0xfc) return { type: 'transport', channel: null };
  if (status === 0xf2 || status === 0xf3) return { type: 'songPosition', channel: null };
  if (status >= 0xf1) return { type: 'other', channel: null };
  const channel = status & 0x0f;
  switch (status & 0xf0) {
    case 0x80:
    case 0x90: return { type: 'noteOnOff', channel };
    case 0xa0:
    case 0xd0: return { type: 'aftertouch', channel };
    case 0xb0: return { type: 'controlChange', channel };
    case 0xc0: return { type: 'programChange', channel };
    case 0xe0: return { type: 'pitchBend', channel };
    default: return { type: 'other', channel };
  }
}

const DIAG_LOG_MAX_LINES = 100;
const diagLogOutput = el('diag-log-output');
let diagLogEntries = [];

function matchesDiagFilters(type, channel) {
  if (type !== 'other') {
    const cb = document.querySelector(`.diag-type-filter[value="${type}"]`);
    if (cb && !cb.checked) return false;
  }
  if (channel !== null) {
    const btn = document.querySelector(`.channel-filter-btn[data-channel="${channel}"]`);
    if (btn && !btn.classList.contains('active')) return false;
  }
  return true;
}

// Independent of the simple log's Enabled checkbox above and of its
// hard-coded Clock/Active Sensing exclusion - the Diagnostics tab has its
// own always-on capture. Filtered-out messages (Clock/Active Sensing by
// default) are never stored at all, rather than stored-but-hidden - a
// high-frequency type like that would otherwise silently burn through the
// 100-message cap in seconds and evict genuinely wanted history the user
// never even saw arrive. Toggling a filter back on won't retroactively
// reveal messages that arrived while it was off, since they were never
// captured, but it does immediately reveal/hide already-stored messages -
// renderDiagLog re-applies the same filter to what's on hand.
function diagLog(direction, bytes) {
  const { type, channel } = classifyMessage(bytes);
  if (!matchesDiagFilters(type, channel)) return;
  diagLogEntries.push({ direction, bytes: Array.from(bytes), timestamp: new Date() });
  if (diagLogEntries.length > DIAG_LOG_MAX_LINES) diagLogEntries = diagLogEntries.slice(-DIAG_LOG_MAX_LINES);
  renderDiagLog();
}

function renderDiagLog() {
  const lines = diagLogEntries
    .filter((entry) => {
      const { type, channel } = classifyMessage(entry.bytes);
      return matchesDiagFilters(type, channel);
    })
    .map((entry) => {
      const hex = entry.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return `${entry.timestamp.toLocaleTimeString()} ${entry.direction} ${hex}`;
    });
  diagLogOutput.textContent = lines.join('\n') + (lines.length ? '\n' : '');
  diagLogOutput.scrollTop = diagLogOutput.scrollHeight;
}

const diagChannelFilters = el('diag-channel-filters');
for (let i = 0; i < 16; i++) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'channel-filter-btn active';
  btn.dataset.channel = String(i);
  btn.textContent = String(i + 1);
  btn.title = `Channel ${i + 1}`;
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
    renderDiagLog();
  });
  diagChannelFilters.appendChild(btn);
}

document.querySelectorAll('.diag-type-filter').forEach((cb) => {
  cb.addEventListener('change', renderDiagLog);
});

el('diag-log-clear-btn').addEventListener('click', () => {
  diagLogEntries = [];
  renderDiagLog();
});

// Turns hex text like "43 10 4C 00 00 7E 00" into a full SysEx message,
// adding the F0/F7 frame if it's missing so the field can hold either the
// full message or just its body.
// Accepts hex bytes separated by spaces, commas, periods, any mix of
// those, or no separator at all (one continuous run of hex digits, read
// two digits per byte) - stripping every separator down to a bare hex
// string first handles all of those the same way instead of committing to
// one delimiter format.
function parseRawSysexInput(text) {
  const hex = text.replace(/[\s,.]+/g, '');
  if (hex.length === 0) throw new Error('Enter at least one hex byte.');
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`Invalid hex characters in "${text}".`);
  if (hex.length % 2 !== 0) throw new Error('Hex input has an odd number of digits - each byte needs 2.');
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  if (bytes[0] !== 0xf0) bytes.unshift(0xf0);
  if (bytes[bytes.length - 1] !== 0xf7) bytes.push(0xf7);
  return new Uint8Array(bytes);
}

el('raw-sysex-send-btn').addEventListener('click', () => {
  try {
    link.send(parseRawSysexInput(el('raw-sysex-input').value));
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// Grows/shrinks the raw SysEx textarea to fit its content instead of
// scrolling horizontally - resetting height to 'auto' first lets
// scrollHeight shrink back down too, not just grow, e.g. after deleting
// text. Runs on input, on window resize (wrapping shifts when the box's
// own width changes), and once up front so it sizes correctly for
// wrapped placeholder text before anything's been typed.
const rawSysexInput = el('raw-sysex-input');
function autoGrowRawSysexInput() {
  rawSysexInput.style.height = 'auto';
  rawSysexInput.style.height = `${rawSysexInput.scrollHeight}px`;
}
rawSysexInput.addEventListener('input', autoGrowRawSysexInput);
window.addEventListener('resize', autoGrowRawSysexInput);
autoGrowRawSysexInput();

// Builds the Graphics tab's pixel grid - a 16-row x 16-column image,
// worked out by identifying all 4 real on-device corners empirically
// (pushing single pixels and observing where they landed) rather than
// guessing: a byte's index within its own group of 16 (0-15) is the ROW
// (0=top, 15=bottom - confirmed for both Data0-15 and Data32-47's own
// extremes), and which of the 3 data groups it's in is the horizontal
// section - Data0-15 leftmost, Data32-47 rightmost, so Data16-31 (the
// only untested group) is assumed to sit in the middle. Bits b0-b6 of
// Data0-15/16-31 give 7 columns each; bits b5/b6 of Data32-47 (the only
// bits that address there, per the doc's "Data 32-47 only uses bit 6 and
// bit 5" note) give 2 more, for 7+7+2=16 columns total. Within each
// group's own slice, the HIGHEST bit is the column closest to that
// slice's outer edge (bit6 of Data0-15 = the image's absolute left edge;
// bit6 of Data32-47 = one step in from its right edge, with bit5 landing
// exactly on it) - confirmed by the corner tests themselves, not
// assumed: the same "bit0=left,bit6=right" ordering used on the first
// pass placed both corner pixels one column short of the real edge.
const GRAPHICS_SIZE = 16;
const GRAPHICS_COLUMNS = [
  ...Array.from({ length: 7 }, (_, i) => ({ dataOffset: 0, bit: 6 - i })),
  ...Array.from({ length: 7 }, (_, i) => ({ dataOffset: 16, bit: 6 - i })),
  ...Array.from({ length: 2 }, (_, i) => ({ dataOffset: 32, bit: 6 - i })),
];
const graphicsGrid = el('graphics-grid');

// The 48-byte SysEx data array is the canonical representation used
// throughout (history, the library, Push to Device) - reading/writing it
// through GRAPHICS_COLUMNS' (dataIndex, bit) mapping instead of raw (x, y)
// keeps history entries and saved library images valid even if that
// mapping is refined further later, rather than baking in today's visual
// layout.
function graphicsCanvasToData48() {
  const data48 = new Array(48).fill(0);
  graphicsGrid.querySelectorAll('.graphics-cell.active').forEach((cell) => {
    data48[Number(cell.dataset.dataIndex)] |= (1 << Number(cell.dataset.bit));
  });
  return data48;
}

function graphicsApplyData48(data48) {
  graphicsGrid.querySelectorAll('.graphics-cell').forEach((cell) => {
    const value = data48[Number(cell.dataset.dataIndex)] || 0;
    const active = (value & (1 << Number(cell.dataset.bit))) !== 0;
    cell.classList.toggle('active', active);
  });
  graphicsOnCanvasChanged();
}

// The Frame SysEx panel - the exact bytes Play Frame would send for
// whatever's on the canvas right now, kept live rather than only shown
// after pushing.
const graphicsHexOutput = el('graphics-hex-output');
function renderGraphicsHexPreview() {
  const bytes = buildBitmapWindow(0, graphicsCanvasToData48());
  graphicsHexOutput.textContent = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

// Single entry point for "the canvas just changed" - called from every
// code path that changes it: graphicsApplyData48 (undo/redo, frame
// select, library/file load) and graphicsPushHistory (paint stroke end,
// Clear, flip/rotate) cover the committed-change paths, and the
// mousedown/mouseenter handlers below call it directly too so it updates
// pixel-by-pixel while actively dragging, not just once the stroke ends.
// Keeps the Frame SysEx preview live, mirrors edits back into whichever
// frame is currently selected, and refreshes the onion-skin overlay
// (which depends on what's now active vs. the reference frame).
function graphicsOnCanvasChanged() {
  renderGraphicsHexPreview();
  graphicsSyncSelectedFrame();
  renderGraphicsOnionSkin();
}

// Tool selection - Pencil (click/drag individual pixels, the original
// and default behavior) or Bucket Fill (click once to flood-fill every
// pixel connected to the clicked one that shares its current state).
// Toggling a class on the grid (rather than each cell) lets one CSS rule
// per tool set the cursor for every cell at once - see .graphics-tool-*
// in style.css for the actual cursor images.
let graphicsTool = 'pencil';
const graphicsToolPencilBtn = el('graphics-tool-pencil-btn');
const graphicsToolBucketBtn = el('graphics-tool-bucket-btn');

function setGraphicsTool(tool) {
  graphicsTool = tool;
  graphicsToolPencilBtn.classList.toggle('active', tool === 'pencil');
  graphicsToolBucketBtn.classList.toggle('active', tool === 'bucket');
  graphicsGrid.classList.toggle('graphics-tool-pencil', tool === 'pencil');
  graphicsGrid.classList.toggle('graphics-tool-bucket', tool === 'bucket');
}
graphicsToolPencilBtn.addEventListener('click', () => setGraphicsTool('pencil'));
graphicsToolBucketBtn.addEventListener('click', () => setGraphicsTool('bucket'));
// The Pencil button already starts marked .active in the HTML, but that
// alone doesn't put #graphics-grid's own graphics-tool-pencil class in
// place - without this call, the custom cursor CSS (keyed off that
// class) had nothing to match until the user clicked Pencil once, even
// though it was already the selected tool.
setGraphicsTool(graphicsTool);

// 4-directional flood fill (not diagonal - matches how a paint bucket
// reads "connected" in every other pixel editor): starting from
// (startX, startY), every pixel reachable through that state without
// crossing into the opposite one gets flipped to the opposite state.
// Iterative with an explicit stack rather than recursive - at 16x16 =
// 256 cells max this doesn't need it for stack-depth safety, but it's
// just as simple either way.
function graphicsFloodFill(startX, startY) {
  const targetActive = graphicsIsActiveAt(startX, startY);
  const fillActive = !targetActive;
  const visited = new Set();
  const stack = [[startX, startY]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= GRAPHICS_SIZE || y < 0 || y >= GRAPHICS_SIZE) continue;
    const key = `${x},${y}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (graphicsIsActiveAt(x, y) !== targetActive) continue;
    const cell = graphicsGrid.querySelector(`.graphics-cell[data-col="${x}"][data-row="${y}"]`);
    cell.classList.toggle('active', fillActive);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  graphicsOnCanvasChanged();
  graphicsPushHistory();
}

// Tracks an in-progress click-and-drag paint stroke: true/false = the
// value being painted (matching whatever the first cell in the stroke
// was just set to), null = no stroke in progress. A cell dragged back
// over mid-stroke is SET to this value (not re-toggled), so a stroke
// paints or erases consistently regardless of each cell's prior state.
let graphicsPaintValue = null;
for (let x = 0; x < GRAPHICS_SIZE; x++) {
  const { dataOffset, bit } = GRAPHICS_COLUMNS[x];
  const colEl = document.createElement('div');
  colEl.className = 'graphics-col';
  for (let y = 0; y < GRAPHICS_SIZE; y++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'graphics-cell';
    cell.dataset.col = String(x);
    cell.dataset.row = String(y);
    cell.dataset.dataIndex = String(dataOffset + y);
    cell.dataset.bit = String(bit);
    cell.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (graphicsTool === 'bucket') {
        graphicsFloodFill(x, y);
        return;
      }
      graphicsPaintValue = !cell.classList.contains('active');
      cell.classList.toggle('active', graphicsPaintValue);
      graphicsOnCanvasChanged();
    });
    cell.addEventListener('mouseenter', () => {
      if (graphicsPaintValue === null) return;
      cell.classList.toggle('active', graphicsPaintValue);
      graphicsOnCanvasChanged();
    });
    colEl.appendChild(cell);
  }
  graphicsGrid.appendChild(colEl);
}
window.addEventListener('mouseup', () => {
  // Only the END of a whole stroke becomes one undo step, not every
  // individual cell touched during it.
  if (graphicsPaintValue !== null) {
    graphicsPaintValue = null;
    graphicsPushHistory();
  }
});

// Undo/redo history - snapshots the whole 48-byte state after each
// completed action (a paint stroke, Clear, or a library Load), not per
// cell, so one stroke/action is one undo step.
let graphicsHistory = [graphicsCanvasToData48()];
let graphicsHistoryIndex = 0;

function updateGraphicsUndoRedoButtons() {
  el('graphics-undo-btn').disabled = graphicsHistoryIndex <= 0;
  el('graphics-redo-btn').disabled = graphicsHistoryIndex >= graphicsHistory.length - 1;
}

function graphicsPushHistory() {
  const snapshot = graphicsCanvasToData48();
  // A no-op stroke (e.g. a drag that started and ended without changing
  // anything visible) shouldn't create an empty undo step.
  const prev = graphicsHistory[graphicsHistoryIndex];
  if (prev.length === snapshot.length && prev.every((v, i) => v === snapshot[i])) return;
  graphicsHistory = graphicsHistory.slice(0, graphicsHistoryIndex + 1);
  graphicsHistory.push(snapshot);
  graphicsHistoryIndex++;
  updateGraphicsUndoRedoButtons();
  // Covers Clear and flip/rotate, which change the canvas directly
  // rather than through graphicsApplyData48 (mousedown/mouseenter above
  // already run this live during an actual paint stroke).
  graphicsOnCanvasChanged();
}

el('graphics-undo-btn').addEventListener('click', () => {
  if (graphicsHistoryIndex <= 0) return;
  graphicsHistoryIndex--;
  graphicsApplyData48(graphicsHistory[graphicsHistoryIndex]);
  updateGraphicsUndoRedoButtons();
});

el('graphics-redo-btn').addEventListener('click', () => {
  if (graphicsHistoryIndex >= graphicsHistory.length - 1) return;
  graphicsHistoryIndex++;
  graphicsApplyData48(graphicsHistory[graphicsHistoryIndex]);
  updateGraphicsUndoRedoButtons();
});

// Flip/rotate operate on the visual (x, y) grid, not the underlying
// data48 bytes - each new cell's state is read from wherever it maps
// back to in the CURRENT (pre-transform) grid, snapshotted up front so
// reads during the loop aren't affected by writes earlier in the same
// loop. mapToOldXY(x, y) returns [oldX, oldY] to read from for new
// position (x, y).
function graphicsTransformCanvas(mapToOldXY) {
  const oldActive = [];
  for (let x = 0; x < GRAPHICS_SIZE; x++) {
    oldActive.push([]);
    for (let y = 0; y < GRAPHICS_SIZE; y++) oldActive[x].push(graphicsIsActiveAt(x, y));
  }
  for (let x = 0; x < GRAPHICS_SIZE; x++) {
    for (let y = 0; y < GRAPHICS_SIZE; y++) {
      const [oldX, oldY] = mapToOldXY(x, y);
      const cell = graphicsGrid.querySelector(`.graphics-cell[data-col="${x}"][data-row="${y}"]`);
      cell.classList.toggle('active', oldActive[oldX][oldY]);
    }
  }
  graphicsPushHistory();
}

el('graphics-flip-h-btn').addEventListener('click', () => {
  graphicsTransformCanvas((x, y) => [GRAPHICS_SIZE - 1 - x, y]);
});

el('graphics-flip-v-btn').addEventListener('click', () => {
  graphicsTransformCanvas((x, y) => [x, GRAPHICS_SIZE - 1 - y]);
});

// Rotating a non-square-pixel (1.6:1) canvas 90 degrees doesn't preserve
// how the image physically looks on the real device (width and height
// swap roles), same inherent tradeoff any pixel editor with non-square
// pixels has - this rotates the underlying 16x16 grid itself, which is
// what "rotate" conventionally means in a pixel editor.
el('graphics-rotate-cw-btn').addEventListener('click', () => {
  graphicsTransformCanvas((x, y) => [y, GRAPHICS_SIZE - 1 - x]);
});

el('graphics-rotate-ccw-btn').addEventListener('click', () => {
  graphicsTransformCanvas((x, y) => [GRAPHICS_SIZE - 1 - y, x]);
});

el('graphics-clear-btn').addEventListener('click', () => {
  document.querySelectorAll('.graphics-cell.active').forEach((cell) => cell.classList.remove('active'));
  graphicsPushHistory();
});

el('graphics-push-frame-btn').addEventListener('click', () => {
  try {
    link.send(buildBitmapWindow(0, graphicsCanvasToData48()));
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// Renders a 16x16 read-only preview of a data48 array - the pixels only,
// no gridlines, at the same 1.6:1 aspect as the main canvas. Shared by
// the Image Library list and the Frames list below.
function graphicsBuildThumbnail(data48) {
  const preview = document.createElement('div');
  preview.className = 'graphics-library-preview';
  for (let y = 0; y < GRAPHICS_SIZE; y++) {
    for (let x = 0; x < GRAPHICS_SIZE; x++) {
      const { dataOffset, bit } = GRAPHICS_COLUMNS[x];
      const active = ((data48[dataOffset + y] || 0) & (1 << bit)) !== 0;
      const dot = document.createElement('span');
      if (active) dot.className = 'active';
      preview.appendChild(dot);
    }
  }
  return preview;
}

// An animation is just a sequence of canvas snapshots (up to 32) plus a
// shared wait time between them - there's no Yamaha-defined "animation"
// SysEx format, so Play Animation just resends the same Bitmap Window
// message once per frame with a real delay in between (see the Wait
// knob's own tooltip for why that delay can't be encoded in the bytes
// themselves).
const GRAPHICS_MAX_FRAMES = 128;
let graphicsFrames = [];
// The frame currently mirroring the canvas live - editing the canvas
// while a frame is selected writes straight back into that frame (see
// graphicsSyncSelectedFrame, called from graphicsOnCanvasChanged). null
// means the canvas is just a free-draw scratch pad, same as before this
// existed.
let graphicsSelectedFrameId = null;

const graphicsWaitKnobWidget = createKnob({
  min: 50,
  max: 2000,
  value: 120,
  step: 10,
  resetValue: 120,
  onChange: () => renderGraphicsAnimationHexPreview(),
});
el('graphics-wait-knob').appendChild(graphicsWaitKnobWidget.element);

// Called from graphicsOnCanvasChanged (i.e. after every canvas edit) -
// if a frame is selected, mirrors the canvas's current state into it so
// "select a frame, then draw" edits that frame live instead of only
// updating a one-time copy.
function graphicsSyncSelectedFrame() {
  if (graphicsSelectedFrameId === null) return;
  const frame = graphicsFrames.find((f) => f.id === graphicsSelectedFrameId);
  if (!frame) return;
  frame.data48 = graphicsCanvasToData48();
  renderGraphicsFrames();
  renderGraphicsAnimationHexPreview();
}

// Loads a frame onto the canvas and marks it selected so further edits
// write back into it live. Selecting the ALREADY-selected frame instead
// deselects it (returns to free-draw), without touching the canvas.
function graphicsSelectFrame(frameId) {
  if (graphicsSelectedFrameId === frameId) {
    graphicsSelectedFrameId = null;
    renderGraphicsFrames();
    renderGraphicsOnionSkin();
    return;
  }
  const frame = graphicsFrames.find((f) => f.id === frameId);
  if (!frame) return;
  graphicsSelectedFrameId = frameId;
  graphicsApplyData48(frame.data48);
  graphicsPushHistory();
}

function renderGraphicsFrames() {
  el('graphics-frames-count').textContent = `(${graphicsFrames.length}/${GRAPHICS_MAX_FRAMES})`;
  el('graphics-add-frame-btn').disabled = graphicsFrames.length >= GRAPHICS_MAX_FRAMES;

  const listEl = el('graphics-frames-list');
  listEl.innerHTML = '';
  if (graphicsFrames.length === 0) {
    const li = document.createElement('li');
    li.className = 'graphics-library-empty';
    li.textContent = 'No frames yet - draw something and click + Add Frame.';
    listEl.appendChild(li);
    return;
  }
  graphicsFrames.forEach((frame, index) => {
    const li = document.createElement('li');
    const isSelected = frame.id === graphicsSelectedFrameId;
    li.className = isSelected ? 'graphics-frame-item selected' : 'graphics-frame-item';
    li.title = isSelected
      ? 'Editing this frame live - click to stop and return to free drawing'
      : 'Click to bring this frame onto the canvas and edit it live';
    li.addEventListener('click', () => graphicsSelectFrame(frame.id));

    const number = document.createElement('span');
    number.className = 'graphics-frame-number';
    number.textContent = `Frame ${index + 1}`;

    const moveUpBtn = document.createElement('button');
    moveUpBtn.type = 'button';
    moveUpBtn.className = 'graphics-frame-move-btn';
    moveUpBtn.textContent = '▲';
    moveUpBtn.title = 'Move earlier in the sequence';
    moveUpBtn.disabled = index === 0;
    moveUpBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      graphicsMoveFrame(frame.id, -1);
    });

    const moveDownBtn = document.createElement('button');
    moveDownBtn.type = 'button';
    moveDownBtn.className = 'graphics-frame-move-btn';
    moveDownBtn.textContent = '▼';
    moveDownBtn.title = 'Move later in the sequence';
    moveDownBtn.disabled = index === graphicsFrames.length - 1;
    moveDownBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      graphicsMoveFrame(frame.id, 1);
    });

    const moveGroup = document.createElement('div');
    moveGroup.className = 'graphics-frame-move-group';
    moveGroup.append(moveUpBtn, moveDownBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-warning';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      if (graphicsSelectedFrameId === frame.id) graphicsSelectedFrameId = null;
      graphicsFrames = graphicsFrames.filter((f) => f.id !== frame.id);
      renderGraphicsFrames();
      renderGraphicsAnimationHexPreview();
      renderGraphicsOnionSkin();
    });

    li.append(graphicsBuildThumbnail(frame.data48), number, moveGroup, removeBtn);
    listEl.appendChild(li);
  });
}

// Swaps a frame with its neighbor in the sequence (direction -1 = earlier,
// +1 = later). Selection tracks by id, not index, so reordering never
// disturbs which frame is currently live-editing; onion skin and the
// Animation SysEx preview both depend on array order (as "the previous
// frame"), so both are re-rendered after every move.
function graphicsMoveFrame(frameId, direction) {
  const index = graphicsFrames.findIndex((f) => f.id === frameId);
  if (index === -1) return;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= graphicsFrames.length) return;
  [graphicsFrames[index], graphicsFrames[targetIndex]] = [graphicsFrames[targetIndex], graphicsFrames[index]];
  renderGraphicsFrames();
  renderGraphicsAnimationHexPreview();
  renderGraphicsOnionSkin();
}

// Ghosts up to graphicsOnionSkinDepth frames on either side of whichever
// frame is selected: earlier frames in gray (.onion, the "Onion Skin"
// toggle), later frames in light orange (.onion-future, the "Future
// Onion Skin" toggle) - either or both can be on at once, both sharing
// the same depth slider. The nearest frame in each direction ghosts at
// GRAPHICS_ONION_SKIN_MAX opacity, fading linearly down to
// GRAPHICS_ONION_SKIN_MIN for the farthest one shown. With "Loop Onion
// Skin" on, running past the first/last frame wraps around to the other
// end of the sequence instead of stopping there, so a looping
// animation's seam can be lined up too; depth is capped at
// (frame count - 1) in that case so it never wraps back onto a frame
// already shown. Only applied to cells that aren't already active on the
// canvas, so a genuinely-drawn pixel always reads as solid, never as a
// faint ghost.
const GRAPHICS_ONION_SKIN_MAX_OPACITY = 0.4;
const GRAPHICS_ONION_SKIN_MIN_OPACITY = 0.08;

function graphicsOnionSkinOpacityAt(stepsAway, depth) {
  return depth <= 1
    ? GRAPHICS_ONION_SKIN_MAX_OPACITY
    : GRAPHICS_ONION_SKIN_MAX_OPACITY - (stepsAway - 1) * ((GRAPHICS_ONION_SKIN_MAX_OPACITY - GRAPHICS_ONION_SKIN_MIN_OPACITY) / (depth - 1));
}

function renderGraphicsOnionSkin() {
  const pastEnabled = el('graphics-onion-skin-toggle').checked;
  const futureEnabled = graphicsOnionSkinFutureToggle.checked;
  const loop = graphicsOnionSkinLoopToggle.checked;
  const cells = graphicsGrid.querySelectorAll('.graphics-cell');
  cells.forEach((cell) => {
    cell.classList.remove('onion', 'onion-future');
    cell.style.removeProperty('--onion-opacity');
    cell.style.removeProperty('--onion-future-opacity');
  });
  const total = graphicsFrames.length;
  const selectedIndex = graphicsFrames.findIndex((f) => f.id === graphicsSelectedFrameId);
  if (selectedIndex === -1 || (!pastEnabled && !futureEnabled)) return;

  function paintDirection(direction, enabled, cssClass, cssVar) {
    if (!enabled) return;
    const roomInDirection = direction < 0 ? selectedIndex : total - 1 - selectedIndex;
    const depth = Math.min(graphicsOnionSkinDepth, loop ? total - 1 : roomInDirection);
    if (depth <= 0) return;
    for (let stepsAway = depth; stepsAway >= 1; stepsAway--) {
      let index = selectedIndex + direction * stepsAway;
      if (loop) index = ((index % total) + total) % total;
      if (index < 0 || index >= total || index === selectedIndex) continue;
      const frame = graphicsFrames[index];
      const opacity = graphicsOnionSkinOpacityAt(stepsAway, depth);
      cells.forEach((cell) => {
        if (cell.classList.contains('active')) return;
        const value = frame.data48[Number(cell.dataset.dataIndex)] || 0;
        const wasActive = (value & (1 << Number(cell.dataset.bit))) !== 0;
        if (wasActive) {
          cell.classList.add(cssClass);
          cell.style.setProperty(cssVar, opacity);
        }
      });
    }
  }

  paintDirection(-1, pastEnabled, 'onion', '--onion-opacity');
  paintDirection(1, futureEnabled, 'onion-future', '--onion-future-opacity');
}

const graphicsOnionSkinDepthInput = el('graphics-onion-skin-depth');
const graphicsOnionSkinDepthValueEl = el('graphics-onion-skin-depth-value');
const graphicsOnionSkinFutureToggle = el('graphics-onion-skin-future-toggle');
const graphicsOnionSkinLoopToggle = el('graphics-onion-skin-loop-toggle');
let graphicsOnionSkinDepth = Number(graphicsOnionSkinDepthInput.value) || 1;

function graphicsUpdateOnionSkinDepthEnabled() {
  graphicsOnionSkinDepthInput.disabled = !(el('graphics-onion-skin-toggle').checked || graphicsOnionSkinFutureToggle.checked);
}

el('graphics-onion-skin-toggle').addEventListener('change', () => {
  graphicsUpdateOnionSkinDepthEnabled();
  renderGraphicsOnionSkin();
});

graphicsOnionSkinFutureToggle.addEventListener('change', () => {
  graphicsUpdateOnionSkinDepthEnabled();
  renderGraphicsOnionSkin();
});

graphicsOnionSkinLoopToggle.addEventListener('change', renderGraphicsOnionSkin);

graphicsOnionSkinDepthInput.addEventListener('input', () => {
  graphicsOnionSkinDepth = Number(graphicsOnionSkinDepthInput.value);
  graphicsOnionSkinDepthValueEl.textContent = `${graphicsOnionSkinDepth} frame${graphicsOnionSkinDepth === 1 ? '' : 's'}`;
  renderGraphicsOnionSkin();
});

// Shared by the preview below and Play Animation's own send loop, so the
// preview always shows exactly what would actually be sent. Which frames
// come back for Ping-Pong depends on Loop: off, a single pass should
// return all the way to frame 1 so it ends where it started, so only the
// last frame is dropped from the reversed half; on, frame 1 already
// reappears at the START of the next lap once this loops, so it's ALSO
// dropped here - otherwise it plays twice in a row at every loop seam
// (once ending one lap, again starting the next) instead of once. Same
// reasoning as the Animated Message tab's own Ping-Pong mode.
function graphicsBuildAnimationSequence() {
  if (!graphicsAnimationPingPongToggle.checked || graphicsFrames.length <= 1) return graphicsFrames;
  const reversedMiddle = graphicsAnimationLoopToggle.checked
    ? graphicsFrames.slice(1, -1).reverse()
    : graphicsFrames.slice(0, -1).reverse();
  return [...graphicsFrames, ...reversedMiddle];
}

function renderGraphicsAnimationHexPreview() {
  const output = el('graphics-animation-hex-output');
  if (graphicsFrames.length === 0) {
    output.textContent = 'No frames added yet - use + Add Frame to start building an animation.';
    return;
  }
  const waitMs = Math.round(graphicsWaitKnobWidget.getValue());
  output.textContent = graphicsBuildAnimationSequence()
    .map((frame, index) => {
      const bytes = buildBitmapWindow(0, frame.data48);
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return `; Frame ${index + 1} (wait ${waitMs}ms)\n${hex}`;
    })
    .join('\n\n');
}

el('graphics-add-frame-btn').addEventListener('click', () => {
  if (graphicsFrames.length >= GRAPHICS_MAX_FRAMES) return;
  const newFrame = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, data48: graphicsCanvasToData48() };
  graphicsFrames.push(newFrame);
  // Selecting the new frame means further drawing continues editing it
  // live, rather than needing a separate click to pick it up.
  graphicsSelectedFrameId = newFrame.id;
  renderGraphicsFrames();
  renderGraphicsAnimationHexPreview();
  renderGraphicsOnionSkin();
});

el('graphics-clear-frames-btn').addEventListener('click', async () => {
  if (graphicsFrames.length === 0) return;
  const confirmed = await showConfirm(
    'Clear all frames?',
    `Remove all ${graphicsFrames.length} frame${graphicsFrames.length === 1 ? '' : 's'} from this animation? This can't be undone.`,
    'Clear All'
  );
  if (!confirmed) return;
  graphicsFrames = [];
  graphicsSelectedFrameId = null;
  renderGraphicsFrames();
  renderGraphicsAnimationHexPreview();
  renderGraphicsOnionSkin();
});

// Loop Animation just changes what happens after the last frame plays:
// off, Play Animation runs the sequence once and stops on its own (as
// before); on, it goes back to frame 1 and keeps going indefinitely,
// same delay between frames and between the last-to-first wrap, until
// Stop Animation is clicked or graphicsAnimationStopRequested is set some
// other way (e.g. switching tabs away mid-loop isn't handled specially -
// this is a fire-and-forget background loop, matching the MIDI Clock
// generator's own always-running-until-stopped design elsewhere in this
// file).
let graphicsAnimationPlaying = false;
let graphicsAnimationStopRequested = false;
const graphicsAnimationLoopToggle = el('graphics-animation-loop-toggle');
const graphicsAnimationPingPongToggle = el('graphics-animation-pingpong-toggle');
const graphicsStopAnimationBtn = el('graphics-stop-animation-btn');

graphicsAnimationLoopToggle.addEventListener('change', () => {
  graphicsStopAnimationBtn.hidden = !graphicsAnimationLoopToggle.checked;
  renderGraphicsAnimationHexPreview();
});

graphicsAnimationPingPongToggle.addEventListener('change', renderGraphicsAnimationHexPreview);

el('graphics-push-animation-btn').addEventListener('click', async () => {
  if (graphicsAnimationPlaying) return;
  if (graphicsFrames.length === 0) {
    statusEl.textContent = 'Error: add at least one frame before playing the animation.';
    return;
  }
  const sequence = graphicsBuildAnimationSequence();
  graphicsAnimationPlaying = true;
  graphicsAnimationStopRequested = false;
  el('graphics-push-animation-btn').disabled = true;
  try {
    do {
      for (let i = 0; i < sequence.length; i++) {
        link.send(buildBitmapWindow(0, sequence[i].data48));
        const waitMs = Math.round(graphicsWaitKnobWidget.getValue());
        const isLastFrame = i === sequence.length - 1;
        if (graphicsAnimationStopRequested) break;
        if (!isLastFrame || graphicsAnimationLoopToggle.checked) await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (graphicsAnimationStopRequested) break;
      }
    } while (graphicsAnimationLoopToggle.checked && !graphicsAnimationStopRequested);
    statusEl.textContent = graphicsAnimationStopRequested
      ? 'Animation stopped.'
      : `Played ${graphicsFrames.length}-frame animation.`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    graphicsAnimationPlaying = false;
    graphicsAnimationStopRequested = false;
    el('graphics-push-animation-btn').disabled = false;
  }
});

graphicsStopAnimationBtn.addEventListener('click', () => {
  graphicsAnimationStopRequested = true;
});

// A small free-text-name dialog, the one shape of dialog this app didn't
// already have (showConfirm/showAlert take no input, showSaveAsDialog
// picks from a fixed <select> of targets rather than naming something).
const graphicsSaveDialog = el('graphics-save-dialog');
const graphicsSaveNameInput = el('graphics-save-name-input');
function showGraphicsSaveDialog(defaultName, title = 'Save Image') {
  return new Promise((resolve) => {
    el('graphics-save-dialog-title').textContent = title;
    graphicsSaveNameInput.value = defaultName;
    const onOk = () => settle(graphicsSaveNameInput.value.trim() || defaultName);
    const onCancel = () => settle(null);
    const onBackdropClick = (evt) => { if (evt.target === graphicsSaveDialog) settle(null); };
    function settle(result) {
      el('graphics-save-ok').removeEventListener('click', onOk);
      el('graphics-save-cancel').removeEventListener('click', onCancel);
      graphicsSaveDialog.removeEventListener('cancel', onCancel);
      graphicsSaveDialog.removeEventListener('click', onBackdropClick);
      graphicsSaveDialog.close();
      resolve(result);
    }
    el('graphics-save-ok').addEventListener('click', onOk);
    el('graphics-save-cancel').addEventListener('click', onCancel);
    graphicsSaveDialog.addEventListener('cancel', onCancel);
    graphicsSaveDialog.addEventListener('click', onBackdropClick);
    graphicsSaveDialog.showModal();
  });
}

// Real .bmp files on disk (via the File System Access API where
// available, falling back to a download link / hidden file input,
// matching every other Save/Load pair in this app - e.g. savePatchBtn/
// loadPatchBtn) are the actual source of truth for User images; this
// in-memory list is just a session-local convenience so images already
// saved/loaded don't need re-picking from disk to switch between them
// again. Nothing here persists across a reload - reload and re-load the
// .bmp file from disk. Presets are the opposite: bundled with the app
// (data/graphics_presets.json, fetched at boot - see loadGraphicsPresets
// below) and always available, same "Presets vs User" split as the FX
// preset browser (fxPresetSource/userFxPresets above).
let graphicsLibrary = []; // User Images
let graphicsPresets = []; // Image Presets
let graphicsUserAnimations = []; // User Animations
let graphicsAnimationPresets = []; // Animation Presets
let graphicsLibrarySource = 'image-presets';

const graphicsLibrarySourceToggle = el('graphics-library-source-toggle');
const graphicsLibrarySourceBtns = [...graphicsLibrarySourceToggle.querySelectorAll('.segment-btn')];
graphicsLibrarySourceBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    graphicsLibrarySource = btn.dataset.source;
    graphicsLibrarySourceBtns.forEach((b) => b.classList.toggle('active', b === btn));
    renderGraphicsLibrary();
  });
});

async function loadGraphicsPresets() {
  const res = await fetch('./data/graphics_presets.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load graphics_presets.json: ${res.status}`);
  return res.json();
}

async function loadGraphicsAnimationPresets() {
  const res = await fetch('./data/graphics_animation_presets.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load graphics_animation_presets.json: ${res.status}`);
  return res.json();
}

function graphicsIsActiveAt(x, y) {
  const cell = graphicsGrid.querySelector(`.graphics-cell[data-col="${x}"][data-row="${y}"]`);
  return !!(cell && cell.classList.contains('active'));
}

function graphicsXYGridToData48(isActiveGrid) {
  const data48 = new Array(48).fill(0);
  for (let x = 0; x < GRAPHICS_SIZE; x++) {
    const { dataOffset, bit } = GRAPHICS_COLUMNS[x];
    for (let y = 0; y < GRAPHICS_SIZE; y++) {
      if (isActiveGrid[y][x]) data48[dataOffset + y] |= (1 << bit);
    }
  }
  return data48;
}

// Row-major (0/1 per pixel) form of a frame's data48, the shape
// encodeAnimatedGif expects - reuses the same GRAPHICS_COLUMNS mapping
// every other canvas<->data48 conversion in this file goes through.
function graphicsData48ToIndices(data48) {
  const indices = new Array(GRAPHICS_SIZE * GRAPHICS_SIZE);
  for (let x = 0; x < GRAPHICS_SIZE; x++) {
    const { dataOffset, bit } = GRAPHICS_COLUMNS[x];
    for (let y = 0; y < GRAPHICS_SIZE; y++) {
      const active = ((data48[dataOffset + y] || 0) & (1 << bit)) !== 0;
      indices[y * GRAPHICS_SIZE + x] = active ? 1 : 0;
    }
  }
  return indices;
}

// The inverse of graphicsData48ToIndices - rebuilds a data48 array from a
// decoded GIF frame's row-major (0/1) pixel indices.
function graphicsIndicesToData48(indices) {
  const data48 = new Array(48).fill(0);
  for (let x = 0; x < GRAPHICS_SIZE; x++) {
    const { dataOffset, bit } = GRAPHICS_COLUMNS[x];
    for (let y = 0; y < GRAPHICS_SIZE; y++) {
      if (indices[y * GRAPHICS_SIZE + x]) data48[dataOffset + y] |= (1 << bit);
    }
  }
  return data48;
}

// Which array/behavior each of the 4 segmented-control sources maps to.
// isAnimation controls whether a row's thumbnail comes from frame[0] and
// whether its Load button replaces graphicsFrames vs. the canvas;
// removable controls whether a Remove button appears (bundled presets
// aren't user-removable, matching the FX preset browser's own
// built-in-vs-user split).
const GRAPHICS_LIBRARY_SOURCES = {
  'image-presets': { get list() { return graphicsPresets; }, isAnimation: false, removable: false, emptyText: 'No presets available.' },
  'user-images': { get list() { return graphicsLibrary; }, isAnimation: false, removable: true, emptyText: 'No images loaded/saved this session yet.' },
  'animation-presets': { get list() { return graphicsAnimationPresets; }, isAnimation: true, removable: false, emptyText: 'No animation presets available.' },
  'user-animations': { get list() { return graphicsUserAnimations; }, isAnimation: true, removable: true, emptyText: 'No animations saved this session yet.' },
};

function renderGraphicsLibrary() {
  graphicsLibrarySourceBtns.forEach((b) => b.classList.toggle('active', b.dataset.source === graphicsLibrarySource));
  const source = GRAPHICS_LIBRARY_SOURCES[graphicsLibrarySource];
  const list = source.list;
  const listEl = el('graphics-library-list');
  listEl.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'graphics-library-empty';
    li.textContent = source.emptyText;
    listEl.appendChild(li);
    return;
  }
  list.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'graphics-library-item';

    const thumbnailData48 = source.isAnimation ? (entry.frames[0]?.data48 || new Array(48).fill(0)) : entry.data48;
    const preview = graphicsBuildThumbnail(thumbnailData48);

    const name = document.createElement('span');
    name.className = 'graphics-library-name';
    name.textContent = source.isAnimation ? `${entry.name} (${entry.frames.length}fr, ${entry.waitMs}ms)` : entry.name;

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = 'Load';
    if (source.isAnimation) {
      loadBtn.addEventListener('click', () => {
        graphicsFrames = entry.frames.map((f) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          data48: f.data48.slice(),
        }));
        graphicsSelectedFrameId = null;
        graphicsWaitKnobWidget.setValue(entry.waitMs, true);
        renderGraphicsFrames();
        renderGraphicsAnimationHexPreview();
        renderGraphicsOnionSkin();
      });
    } else {
      loadBtn.addEventListener('click', () => {
        graphicsApplyData48(entry.data48);
        graphicsPushHistory();
      });
    }

    li.append(preview, name, loadBtn);

    if (source.removable) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-warning';
      removeBtn.textContent = 'Remove';
      if (!source.isAnimation) removeBtn.title = 'Removes it from this list only - the .bmp file on disk (if saved) is untouched.';
      removeBtn.addEventListener('click', () => {
        const list2 = source.list;
        const idx = list2.findIndex((e) => e.id === entry.id);
        if (idx !== -1) list2.splice(idx, 1);
        renderGraphicsLibrary();
      });
      li.append(removeBtn);
    }

    listEl.appendChild(li);
  });
}

// writeFile (used by Save Parameters etc.) is hardcoded to JSON text -
// this is the same File System Access API / download-link fallback
// pattern, but for arbitrary binary content.
async function writeBinaryFile(filename, bytes, description, extension, mimeType = 'image/bmp') {
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description, accept: { [mimeType]: [extension] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return handle.name;
  }
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return filename;
}

// Mirrors loadFxFileText's own already-loaded-preset check above - if
// list already has an entry with this name, confirms overwriting it
// (removing the old entry, mutating list in place) before the caller
// adds the new one. Returns false if the name is free OR the user
// declined, in EITHER of which case the caller should NOT still add the
// entry if false-with-collision (see call sites) - to spell that
// distinction out, this returns true only when it's clear to proceed
// (either no collision, or overwrite confirmed). kindLabel is just for
// the dialog's wording ("image"/"animation").
async function graphicsConfirmOverwriteIfNeeded(list, name, kindLabel) {
  const existingIndex = list.findIndex((entry) => entry.name === name);
  if (existingIndex === -1) return true;
  const overwrite = await showConfirm(
    `${kindLabel} already in library`,
    `An ${kindLabel.toLowerCase()} named "${name}" is already in the User library. Overwrite it, or cancel to skip?`,
    'Overwrite'
  );
  if (!overwrite) return false;
  list.splice(existingIndex, 1);
  return true;
}

el('graphics-save-btn').addEventListener('click', async () => {
  const name = await showGraphicsSaveDialog(`Image ${new Date().toISOString().slice(0, 10)}`);
  if (!name) return;
  if (!(await graphicsConfirmOverwriteIfNeeded(graphicsLibrary, name, 'Image'))) return;
  try {
    const bytes = encodeMonoBmp16x16(graphicsIsActiveAt);
    const savedName = await writeBinaryFile(`${name}.bmp`, bytes, 'QY70/QY100 Graphics', '.bmp');
    graphicsLibrary.push({ id: `${Date.now()}`, name, data48: graphicsCanvasToData48() });
    graphicsLibrarySource = 'user-images';
    renderGraphicsLibrary();
    statusEl.textContent = `Saved ${savedName}.`;
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

// Inline (non-modal) progress feedback for Load Image/Load Animation,
// shown while graphicsLoadBmpFiles/graphicsLoadAnimationFiles are reading
// and decoding the picked file(s). Deliberately NOT the showProgress
// modal used elsewhere for MIDI-send operations - a per-file overwrite
// confirmation (graphicsConfirmOverwriteIfNeeded) can still need to pop
// up mid-loop here, and stacking that on top of a blocking dialog would
// be awkward, so this is just a row in the normal page flow instead.
const graphicsLoadProgressRow = el('graphics-load-progress-row');
const graphicsLoadProgressBar = el('graphics-load-progress-bar');
const graphicsLoadProgressStatus = el('graphics-load-progress-status');

// A fast load (one small file, already cached on disk) can finish well
// under a second - hiding the bar the instant it hits 100% would make it
// flash by too quickly to actually register as feedback. Tracking when it
// was shown and padding hideGraphicsLoadProgress out to at least this
// long keeps it visible long enough to read, without slowing down a
// large/slow batch (which already naturally takes longer than this).
const GRAPHICS_LOAD_PROGRESS_MIN_VISIBLE_MS = 1000;
let graphicsLoadProgressShownAt = 0;

function showGraphicsLoadProgress() {
  graphicsLoadProgressBar.value = 0;
  graphicsLoadProgressStatus.textContent = '';
  graphicsLoadProgressRow.hidden = false;
  graphicsLoadProgressShownAt = performance.now();
}

function updateGraphicsLoadProgress(label, current, total) {
  graphicsLoadProgressBar.value = total ? Math.round((current / total) * 100) : 0;
  graphicsLoadProgressStatus.textContent = `${label} ${current} of ${total}...`;
}

// Deliberately not awaited by its callers - the load's own result
// (library/status updates) should land immediately once decoding
// finishes, not wait on this cosmetic grace period too. The bar just
// lingers in the background for whatever's left of the minimum, then
// hides itself.
async function hideGraphicsLoadProgress() {
  const elapsed = performance.now() - graphicsLoadProgressShownAt;
  const remaining = GRAPHICS_LOAD_PROGRESS_MIN_VISIBLE_MS - elapsed;
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  graphicsLoadProgressRow.hidden = true;
}

// A valid 16x16 BMP (any bit depth this app reads) is well under 1KB - a
// generous 256KB cap rejects an oversized/wrong file before it's ever
// fully read into memory, rather than after (e.g. someone accidentally
// picking a multi-hundred-MB file with a renamed .bmp extension, which
// would otherwise sit reading/decoding a mostly-pointless buffer).
const GRAPHICS_MAX_BMP_FILE_SIZE = 256 * 1024;

// Decodes and adds ONE file's bytes to the User library. Returns the new
// entry on success, or null (after reporting the error, or after the user
// declined an overwrite prompt) on failure - the caller decides
// whether/how to summarize across a multi-file batch.
async function graphicsAddBmpToLibrary(bytes, filename) {
  let isActiveGrid;
  try {
    isActiveGrid = decodeMonoBmp(bytes);
  } catch (err) {
    statusEl.textContent = `Error: ${filename ? `${filename}: ` : ''}${err.message}`;
    return null;
  }
  const name = filename?.replace(/\.bmp$/i, '') || 'Loaded Image';
  if (!(await graphicsConfirmOverwriteIfNeeded(graphicsLibrary, name, 'Image'))) return null;
  const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, data48: graphicsXYGridToData48(isActiveGrid) };
  graphicsLibrary.push(entry);
  return entry;
}

// Loads one or more File objects (from either the File System Access API
// or the plain <input type=file multiple> fallback below). Every file
// that decodes successfully is added to the User library; if exactly one
// file was picked, it's also applied to the canvas directly (preserving
// the original single-file UX) - with several picked at once there's no
// single obvious choice to apply, so they're just left in the library
// for the user to pick from via each entry's own Load button.
async function graphicsLoadBmpFiles(files) {
  const fileArray = Array.from(files);
  if (fileArray.length === 0) return;
  let succeeded = 0;
  let lastEntry = null;
  showGraphicsLoadProgress();
  try {
    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      updateGraphicsLoadProgress('Loading image', i, fileArray.length);
      if (file.size > GRAPHICS_MAX_BMP_FILE_SIZE) {
        statusEl.textContent = `Error: ${file.name} is too large to be a valid 16x16 BMP (${Math.round(file.size / 1024)}KB) - skipped.`;
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entry = await graphicsAddBmpToLibrary(bytes, file.name);
      if (entry) {
        succeeded++;
        lastEntry = entry;
      }
    }
    updateGraphicsLoadProgress('Loading image', fileArray.length, fileArray.length);
  } finally {
    hideGraphicsLoadProgress();
  }
  if (succeeded === 0) return;
  graphicsLibrarySource = 'user-images';
  renderGraphicsLibrary();
  if (fileArray.length === 1 && lastEntry) {
    graphicsApplyData48(lastEntry.data48);
    graphicsPushHistory();
  } else {
    statusEl.textContent = `Loaded ${succeeded} of ${fileArray.length} image${fileArray.length === 1 ? '' : 's'} into the library.`;
  }
}

const graphicsFileInput = el('graphics-file-input');
el('graphics-load-btn').addEventListener('click', async () => {
  try {
    if (window.showOpenFilePicker) {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'QY70/QY100 Graphics', accept: { 'image/bmp': ['.bmp'] } }],
      });
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      await graphicsLoadBmpFiles(files);
    } else {
      graphicsFileInput.click();
    }
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

graphicsFileInput.addEventListener('change', async () => {
  // files is a snapshot copy, not the input's own live FileList -
  // clearing .value right after (needed so re-picking the same file(s)
  // later still fires change) would otherwise empty that live list out
  // from under this handler before the async loop below ever runs.
  const files = Array.from(graphicsFileInput.files);
  graphicsFileInput.value = '';
  if (files.length) await graphicsLoadBmpFiles(files);
});

// Like images, animations round-trip through a real file on disk - an
// animated .gif, since GIF's own per-frame delay field is exactly the
// "wait time between frames" this app already tracks, and any image
// viewer/browser can preview it without this app. The .gif is written
// alongside adding the frames + wait time to the User Animations list,
// mirroring Save Image's own bmp-plus-library-entry behavior.
el('graphics-save-animation-btn').addEventListener('click', async () => {
  if (graphicsFrames.length === 0) {
    statusEl.textContent = 'Error: add at least one frame before saving an animation.';
    return;
  }
  const name = await showGraphicsSaveDialog(`Animation ${new Date().toISOString().slice(0, 10)}`, 'Save Animation');
  if (!name) return;
  if (!(await graphicsConfirmOverwriteIfNeeded(graphicsUserAnimations, name, 'Animation'))) return;
  const waitMs = Math.round(graphicsWaitKnobWidget.getValue());
  try {
    const gifBytes = encodeAnimatedGif({
      width: GRAPHICS_SIZE,
      height: GRAPHICS_SIZE,
      frames: graphicsFrames.map((f) => ({ indices: graphicsData48ToIndices(f.data48), delayCs: Math.round(waitMs / 10) })),
    });
    const savedName = await writeBinaryFile(`${name}.gif`, gifBytes, 'QY70/QY100 Animation', '.gif', 'image/gif');
    graphicsUserAnimations.push({
      id: `${Date.now()}`,
      name,
      waitMs,
      frames: graphicsFrames.map((f) => ({ data48: f.data48.slice() })),
    });
    graphicsLibrarySource = 'user-animations';
    renderGraphicsLibrary();
    statusEl.textContent = `Saved ${savedName} (${graphicsFrames.length} frames).`;
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

// Builds a new animation by importing one or more .gif files (in
// selection order) - every frame from every selected file is decoded and
// concatenated into ONE sequence (this app only has a single shared Wait
// time, not a per-frame one, so it's taken from the first loaded frame's
// own delay). More frames than GRAPHICS_MAX_FRAMES allows are truncated
// to the first GRAPHICS_MAX_FRAMES, reported in the status message
// rather than silently dropped. The combined result is added to the
// User Animations library
// only (like Save Animation writes there) rather than replacing the
// current working frames outright - use the library entry's own Load
// button to bring it into the frame editor.
async function graphicsLoadAnimationFiles(files) {
  const fileArray = Array.from(files);
  if (fileArray.length === 0) return;
  const newFrames = [];
  let firstDelayCs = null;
  let filesFailed = 0;
  let filesOk = 0;
  let firstFileName = null;
  showGraphicsLoadProgress();
  try {
    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      updateGraphicsLoadProgress('Loading animation', i, fileArray.length);
      if (file.size > GRAPHICS_MAX_BMP_FILE_SIZE) {
        filesFailed++;
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const decoded = decodeAnimatedGif(bytes);
        filesOk++;
        if (firstFileName === null) firstFileName = file.name;
        for (const frame of decoded.frames) {
          if (firstDelayCs === null) firstDelayCs = frame.delayCs;
          newFrames.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            data48: graphicsIndicesToData48(frame.indices),
          });
        }
      } catch (err) {
        filesFailed++;
      }
    }
    updateGraphicsLoadProgress('Loading animation', fileArray.length, fileArray.length);
    if (newFrames.length === 0) {
      statusEl.textContent = 'Error: no valid 16x16 GIF animations were selected.';
      return;
    }
    let truncated = false;
    let frames = newFrames;
    if (frames.length > GRAPHICS_MAX_FRAMES) {
      frames = frames.slice(0, GRAPHICS_MAX_FRAMES);
      truncated = true;
    }
    const waitMs = Math.round(firstDelayCs * 10);
    const name = filesOk === 1
      ? (firstFileName?.replace(/\.gif$/i, '') || 'Loaded Animation')
      : `${filesOk} Combined GIFs ${new Date().toISOString().slice(0, 10)}`;
    // Kept inside this try (rather than after the finally below) so the
    // progress row stays up behind the overwrite-confirm dialog instead
    // of disappearing right before it appears.
    if (!(await graphicsConfirmOverwriteIfNeeded(graphicsUserAnimations, name, 'Animation'))) return;
    graphicsUserAnimations.push({
      id: `${Date.now()}`,
      name,
      waitMs,
      frames: frames.map((f) => ({ data48: f.data48.slice() })),
    });
    graphicsLibrarySource = 'user-animations';
    renderGraphicsLibrary();
    const parts = [`Loaded a ${frames.length}-frame animation from ${filesOk} file${filesOk === 1 ? '' : 's'} into the User Animations library.`];
    if (truncated) parts.push(`Only the first ${GRAPHICS_MAX_FRAMES} of ${newFrames.length} decoded frames were used (${GRAPHICS_MAX_FRAMES}-frame limit).`);
    if (filesFailed) parts.push(`${filesFailed} file${filesFailed === 1 ? '' : 's'} failed to decode and ${filesFailed === 1 ? 'was' : 'were'} skipped.`);
    statusEl.textContent = parts.join(' ');
  } finally {
    hideGraphicsLoadProgress();
  }
}

const graphicsAnimationFileInput = el('graphics-animation-file-input');
el('graphics-load-animation-btn').addEventListener('click', async () => {
  try {
    if (window.showOpenFilePicker) {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'QY70/QY100 Animation', accept: { 'image/gif': ['.gif'] } }],
      });
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      await graphicsLoadAnimationFiles(files);
    } else {
      graphicsAnimationFileInput.click();
    }
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

graphicsAnimationFileInput.addEventListener('change', async () => {
  const files = Array.from(graphicsAnimationFileInput.files);
  graphicsAnimationFileInput.value = '';
  if (files.length) await graphicsLoadAnimationFiles(files);
});

renderGraphicsLibrary();
updateGraphicsUndoRedoButtons();
renderGraphicsHexPreview();
renderGraphicsFrames();
renderGraphicsAnimationHexPreview();
renderGraphicsOnionSkin();

// Display Text sub-tabs (Whole Message / Split Message) - same pattern
// as the Instructions dialog's own .dialog-tab/.dialog-tab-panel
// switching (see helpTabs below), just scoped to this section instead of
// a <dialog>.
const displayTextSubtabs = [...document.querySelectorAll('#display-text-subtabs .dialog-tab')];
const displayTextSubpanels = [...document.querySelectorAll('#display-text .display-text-subtab-panel')];
displayTextSubtabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    displayTextSubtabs.forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    displayTextSubpanels.forEach((p) => { p.hidden = p.dataset.subpanel !== tab.dataset.subtab; });
  });
});

// Display Text tab - a friendlier text-input wrapper around
// buildMessageWindow, the same 32-char LCD Message Window SysEx that
// sendMessageWindow (below) already uses internally for action
// confirmations - this tab just lets the user compose and push arbitrary
// text to the device directly, working the same way the Graphics tab's
// own canvas-to-SysEx panels do: a live hex preview plus a button to
// actually send it.
const displayTextInput = el('display-text-input');
const displayTextCount = el('display-text-count');
const displayTextHexOutput = el('display-text-hex-output');

function renderDisplayTextHexPreview() {
  const bytes = buildMessageWindow(0, displayTextInput.value);
  displayTextHexOutput.textContent = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

displayTextInput.addEventListener('input', () => {
  displayTextCount.textContent = `${displayTextInput.value.length}/32`;
  renderDisplayTextHexPreview();
});

displayTextInput.addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter') el('display-text-push-btn').click();
});

el('display-text-push-btn').addEventListener('click', () => {
  try {
    link.send(buildMessageWindow(0, displayTextInput.value));
    statusEl.textContent = 'Sent to display.';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

renderDisplayTextHexPreview();

// Animated Message - builds a sequence of Message Window snapshots that
// animate the typed text across the 32-char display, the same "sequence
// of snapshots plus a shared wait time" shape as the Graphics tab's own
// frame animation (see graphicsFrames/Play Animation above), just
// generated from text instead of drawn by hand. Marquee/Ping-Pong pad 32
// blank characters onto both ends so a message of any length starts and
// ends fully off-screen, unlike the static Message field above, which
// just truncates at 32 characters.
//
// The 1000-char maxlength on the textarea (enforced by the browser, same
// idea as the static field's 32) bounds how many steps a sequence can
// ever have, and every step is built via buildMessageWindow, which
// already sanitizes each character (anything outside printable ASCII
// becomes a space - see its own comment in sysex.js) before turning it
// into bytes. Every render below writes this text via .textContent,
// never innerHTML, so there's no way typed text can be interpreted as
// markup.
const MARQUEE_WINDOW_LENGTH = 32;
const MARQUEE_MAX_LENGTH = 1000;
const MARQUEE_BLANK_STEP = ' '.repeat(MARQUEE_WINDOW_LENGTH);

function marqueeBuildScrollSteps(text) {
  const padded = MARQUEE_BLANK_STEP + text + MARQUEE_BLANK_STEP;
  const steps = [];
  for (let i = 0; i <= padded.length - MARQUEE_WINDOW_LENGTH; i++) {
    steps.push(padded.slice(i, i + MARQUEE_WINDOW_LENGTH));
  }
  return steps;
}

// Orbit treats the 32-char display as two 16-char rows forming one
// closed loop - top row left-to-right, then bottom row right-to-left,
// the same direction you'd trace a rectangle's border clockwise - and
// animates the message's characters flowing around that loop, one
// slot per step, for a full 32-step lap back to where they started.
// MARQUEE_ORBIT_CW_ORDER lists which raw byte index sits at each
// position going around the loop; MARQUEE_ORBIT_LOOP_POS_OF_RAW is its
// inverse (raw byte index -> loop position), used to find how far along
// the loop each raw slot is.
const MARQUEE_ORBIT_CW_ORDER = (() => {
  const order = [];
  for (let i = 0; i < 16; i++) order.push(i);
  for (let i = 15; i >= 0; i--) order.push(16 + i);
  return order;
})();
const MARQUEE_ORBIT_LOOP_POS_OF_RAW = (() => {
  const map = new Array(MARQUEE_WINDOW_LENGTH);
  MARQUEE_ORBIT_CW_ORDER.forEach((rawIndex, loopPos) => { map[rawIndex] = loopPos; });
  return map;
})();

// The resting (step 1) frame reads normally - raw index r shows
// content[r], same as Blink's single static frame - so
// loopContentAtStart[loopPos] is just that same content reindexed by
// loop position. Each later step re-reads every raw slot from
// `clockwise ? loopPos - t : loopPos + t` steps earlier in that array,
// i.e. "what was t slots behind this one, moving forward around the
// loop" - which is what makes the whole ring appear to rotate as t
// increases, rather than each character just independently cycling.
function marqueeBuildOrbitSteps(text, clockwise) {
  const content = (text + MARQUEE_BLANK_STEP).slice(0, MARQUEE_WINDOW_LENGTH);
  const loopContentAtStart = MARQUEE_ORBIT_CW_ORDER.map((rawIndex) => content[rawIndex]);
  const steps = [];
  for (let t = 0; t < MARQUEE_WINDOW_LENGTH; t++) {
    const raw = new Array(MARQUEE_WINDOW_LENGTH);
    for (let r = 0; r < MARQUEE_WINDOW_LENGTH; r++) {
      const loopPos = MARQUEE_ORBIT_LOOP_POS_OF_RAW[r];
      const sourcePos = clockwise
        ? (loopPos - t + MARQUEE_WINDOW_LENGTH) % MARQUEE_WINDOW_LENGTH
        : (loopPos + t) % MARQUEE_WINDOW_LENGTH;
      raw[r] = loopContentAtStart[sourcePos];
    }
    steps.push(raw.join(''));
  }
  return steps;
}

// Marquee, Ping-Pong, Blink, and Orbit are mutually exclusive modes (a
// segmented-control selection, not independent toggles - see
// #marquee-mode-toggle below), so building a sequence only ever needs to
// look at which one is currently selected. Blink alternates the message
// with a blank screen; Ping-Pong is the same scroll as plain Marquee,
// just with all steps but the last appended again in reverse so it
// bounces back to the start instead of cutting straight back to the
// beginning; Orbit is described above.
let marqueeMode = 'marquee';
let marqueeOrbitClockwise = true;

function marqueeBuildSteps(text) {
  if (marqueeMode === 'blink') return [text, MARQUEE_BLANK_STEP];
  if (marqueeMode === 'orbit') return marqueeBuildOrbitSteps(text, marqueeOrbitClockwise);
  const forward = marqueeBuildScrollSteps(text);
  if (marqueeMode !== 'pingpong') return forward;
  // Off, a single pass should return all the way to the first step so it
  // ends where it started, so only the last step is dropped from the
  // reversed half. On, that first step already reappears at the START
  // of the next lap once this loops, so it's ALSO dropped here -
  // otherwise it plays twice in a row at every loop seam (once ending
  // one lap, again starting the next) instead of once. Same reasoning
  // as Graphics' own Play Animation Ping-Pong.
  const reversedMiddle = marqueeLoopToggle.checked ? forward.slice(1, -1).reverse() : forward.slice(0, -1).reverse();
  return [...forward, ...reversedMiddle];
}

const marqueeTextInput = el('marquee-text-input');
const marqueeTextCount = el('marquee-text-count');
const marqueeHexOutput = el('marquee-hex-output');

const marqueeModeToggle = el('marquee-mode-toggle');
const marqueeModeBtns = [...marqueeModeToggle.querySelectorAll('.segment-btn')];
const marqueeOrbitDirectionRow = el('marquee-orbit-direction-row');
const marqueeOrbitDirectionToggle = el('marquee-orbit-direction-toggle');
const marqueeOrbitDirectionLabel = el('marquee-orbit-direction-label');
marqueeModeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    marqueeMode = btn.dataset.mode;
    marqueeModeBtns.forEach((b) => b.classList.toggle('active', b === btn));
    marqueeOrbitDirectionRow.hidden = marqueeMode !== 'orbit';
    renderMarqueeHexPreview();
  });
});
marqueeOrbitDirectionToggle.addEventListener('change', () => {
  marqueeOrbitClockwise = !marqueeOrbitDirectionToggle.checked;
  marqueeOrbitDirectionLabel.textContent = marqueeOrbitClockwise ? 'CW' : 'CCW';
  renderMarqueeHexPreview();
});

const marqueeWaitKnobWidget = createKnob({
  min: 50,
  max: 2000,
  value: 300,
  step: 10,
  resetValue: 300,
  onChange: () => renderMarqueeHexPreview(),
});
el('marquee-speed-knob').appendChild(marqueeWaitKnobWidget.element);

// Grows the textarea to fit its content (reset to auto first so it can
// shrink back down too, e.g. after deleting text) rather than scrolling
// internally - see the resize:none/overflow:hidden pairing on
// #marquee-text-input in style.css, which hands height control to this
// entirely. scrollHeight excludes border width, but the app's global
// box-sizing: border-box (style.css) means the height property being set
// here DOES include it - without adding it back, the box would land
// consistently a couple pixels short of its own content, clipping the
// last line just enough to force the very internal scroll this is meant
// to avoid.
function marqueeAutoGrowInput() {
  const cs = getComputedStyle(marqueeTextInput);
  const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  marqueeTextInput.style.height = 'auto';
  marqueeTextInput.style.height = `${marqueeTextInput.scrollHeight + borderY}px`;
}

function renderMarqueeHexPreview() {
  const text = marqueeTextInput.value;
  if (!text) {
    marqueeHexOutput.textContent = 'Type a message above to build the sequence.';
    return;
  }
  const waitMs = Math.round(marqueeWaitKnobWidget.getValue());
  marqueeHexOutput.textContent = marqueeBuildSteps(text)
    .map((stepText, index) => {
      const bytes = buildMessageWindow(0, stepText);
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return `; Step ${index + 1} (wait ${waitMs}ms)\n${hex}`;
    })
    .join('\n\n');
}

marqueeTextInput.addEventListener('input', () => {
  // maxlength="1000" on the element already stops normal typing/pasting
  // past the cap, but doesn't cover every input path a browser might
  // allow (e.g. a dropped text file) - clamping here too keeps the step
  // count (and therefore how long Play Message runs, and how large the
  // hex preview gets) bounded no matter how the text arrived.
  if (marqueeTextInput.value.length > MARQUEE_MAX_LENGTH) marqueeTextInput.value = marqueeTextInput.value.slice(0, MARQUEE_MAX_LENGTH);
  marqueeTextCount.textContent = `${marqueeTextInput.value.length}/${MARQUEE_MAX_LENGTH}`;
  marqueeAutoGrowInput();
  renderMarqueeHexPreview();
});

// Loop/Stop/Play-button wiring below mirrors Play Animation/Stop
// Animation above exactly (same do-while-until-stopped shape, same
// disabled/hidden button choreography) - see that block's own comments
// for why it's structured this way.
let marqueePlaying = false;
let marqueeStopRequested = false;
const marqueeLoopToggle = el('marquee-loop-toggle');
const marqueeStopBtn = el('marquee-stop-btn');

// Loop changes which frames Ping-Pong mode's step sequence includes (see
// marqueeBuildSteps' own comment) - re-render so the preview stays
// accurate when Loop is flipped while Ping-Pong is selected.
marqueeLoopToggle.addEventListener('change', renderMarqueeHexPreview);

// Stop Message is always clickable, not just while something's actually
// playing. Clicking it with nothing playing just sets a flag nothing
// ever reads before Play Message resets it back to false on its own
// next run, so it's harmless, and leaving it always enabled means it's
// never in a state where the one obvious way to interrupt a
// stuck-looping message is itself unavailable.
el('marquee-play-btn').addEventListener('click', async () => {
  if (marqueePlaying) return;
  const text = marqueeTextInput.value;
  if (!text) {
    statusEl.textContent = 'Error: type a message before playing it.';
    return;
  }
  const steps = marqueeBuildSteps(text);
  marqueePlaying = true;
  marqueeStopRequested = false;
  el('marquee-play-btn').disabled = true;
  try {
    do {
      for (let i = 0; i < steps.length; i++) {
        link.send(buildMessageWindow(0, steps[i]));
        const waitMs = Math.round(marqueeWaitKnobWidget.getValue());
        const isLastStep = i === steps.length - 1;
        if (marqueeStopRequested) break;
        if (!isLastStep || marqueeLoopToggle.checked) await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (marqueeStopRequested) break;
      }
    } while (marqueeLoopToggle.checked && !marqueeStopRequested);
    statusEl.textContent = marqueeStopRequested ? 'Message stopped.' : 'Played message.';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    marqueePlaying = false;
    marqueeStopRequested = false;
    el('marquee-play-btn').disabled = false;
  }
});

marqueeStopBtn.addEventListener('click', () => {
  marqueeStopRequested = true;
});

renderMarqueeHexPreview();

// Split Message - the 32-char Message Window is really two stacked
// 16-char lines (see buildMessageWindowLine's own comment in sysex.js).
// Flip-Flop, Alternate Blink, and Marquee all share ONE clock (one Wait
// knob, one Loop toggle, one do-while loop) and rebuild the FULL 32-byte
// frame every step via buildMessageWindow, rather than the two lines
// running on independent clocks with their own separate sends - an
// earlier version of Marquee mode did that (two Promise.all'd loops,
// each only writing its own 16 bytes via buildMessageWindowLine), but
// the two lines' sends landing at different, unsynchronized moments
// looked bad in practice. Marquee mode still gets the LOOK of
// independent per-line movement by giving each line its own
// Forward/Reverse/Ping-Pong direction (see splitLineFramesFor) and
// cycling each line's own frame sequence via modulo against a shared
// frame counter - same clock, different phase/pattern per line.
const SPLIT_LINE_LENGTH = 16;
const SPLIT_BLANK_LINE = ' '.repeat(SPLIT_LINE_LENGTH);
const SPLIT_LINE_MAX_LENGTH = 128;

function splitBuildLineScrollSteps(text) {
  const padded = SPLIT_BLANK_LINE + text + SPLIT_BLANK_LINE;
  const steps = [];
  for (let i = 0; i <= padded.length - SPLIT_LINE_LENGTH; i++) {
    steps.push(padded.slice(i, i + SPLIT_LINE_LENGTH));
  }
  return steps;
}

// Flip-Flop and Alternate Blink only ever need each line's STATIC
// content (never longer than one line), unlike Marquee mode's scrolling
// text - truncating/padding to exactly 16 chars here keeps both modes'
// step-building below simple string concatenation.
function splitLineStatic(text) {
  return (text + SPLIT_BLANK_LINE).slice(0, SPLIT_LINE_LENGTH);
}

// One line's own frame sequence for Marquee mode, per its own Reverse
// and Ping-Pong toggles - independent settings, not one exclusive choice,
// so all four combinations are reachable: plain forward, plain reverse,
// a ping-pong that starts by scrolling in (forward) then bounces back,
// or a ping-pong that starts by scrolling out (reverse) then bounces
// back the other way. Reverse alone is just the forward frames in the
// opposite order (right-to-left instead of left-to-right); both
// directions naturally start AND end on an all-blank frame (the window
// sits fully within the leading/trailing pad at each end), so cycling
// them via modulo repeats a blank frame at the seam - never visually
// obvious. Ping-Pong bounces the (possibly already-reversed) sequence
// back on itself, and DOES need its own seam fix (dropping both
// endpoints from the reversed half) because unlike a blank seam, its
// seam frame is real, visible content - same reasoning as Play
// Animation's own Ping-Pong toggle elsewhere in this file.
function splitLineFramesFor(text, reverse, pingPong) {
  const base = reverse ? [...splitBuildLineScrollSteps(text)].reverse() : splitBuildLineScrollSteps(text);
  if (!pingPong || base.length <= 1) return base;
  return [...base, ...base.slice(1, -1).reverse()];
}

function gcd(a, b) {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

function lcm(a, b) {
  return (a / gcd(a, b)) * b;
}

// Combines both lines' own frame sequences onto ONE shared frame count,
// each line cycling its own sequence via modulo - so a short Line 1
// phrase loops several times over the course of a long Line 2 phrase's
// single pass, each still keeping its own direction/pattern, all while
// every step is still one single 32-byte buildMessageWindow send
// covering both lines at once. That shared count has to be the LEAST
// COMMON MULTIPLE of the two sequence lengths, not just the longer
// one's length - using the longer length alone only lets IT complete
// exactly once, while the shorter one gets cut off mid-cycle at the
// seam unless its length happens to divide evenly into the longer
// one's. That mid-cycle cutoff is exactly what produced the "weird
// reset" reported when the two lines' character counts differ: on
// Loop (or replaying from the top), the shorter line's Ping-Pong would
// jump straight back to frame 0 instead of continuing from wherever it
// left off, since it never got to finish its own bounce. The LCM is
// the smallest frame count that's a whole multiple of BOTH lengths, so
// both lines always land back on their own seam at the same instant.
// frameLimit caps how many frames actually get built (for the live hex
// preview - with two long, differently-lengthed Ping-Pong lines, their
// LCM can reach hundreds of thousands of frames, which would otherwise
// have to be rebuilt from scratch on every keystroke). The true LCM is
// always attached as .totalFrames so a capped caller can tell whether
// it got the whole sequence or just the first frameLimit frames of it;
// Play Split Message calls this with no limit so the device always gets
// the complete, correct sequence regardless of what the preview showed.
function splitBuildMarqueeFrames(line1, line2, reverse1, pingPong1, reverse2, pingPong2, frameLimit = Infinity) {
  const seq1 = line1 ? splitLineFramesFor(line1, reverse1, pingPong1) : [SPLIT_BLANK_LINE];
  const seq2 = line2 ? splitLineFramesFor(line2, reverse2, pingPong2) : [SPLIT_BLANK_LINE];
  const totalFrames = lcm(seq1.length, seq2.length);
  const frameCount = Math.min(totalFrames, frameLimit);
  const frames = [];
  for (let t = 0; t < frameCount; t++) {
    frames.push(seq1[t % seq1.length] + seq2[t % seq2.length]);
  }
  frames.totalFrames = totalFrames;
  return frames;
}

function splitBuildCombinedSteps(line1, line2, frameLimit = Infinity) {
  if (splitMode === 'marquee') {
    return splitBuildMarqueeFrames(line1, line2, splitLine1Reverse, splitLine1PingPong, splitLine2Reverse, splitLine2PingPong, frameLimit);
  }
  const l1 = splitLineStatic(line1);
  const l2 = splitLineStatic(line2);
  if (splitMode === 'blink') {
    return [l1 + SPLIT_BLANK_LINE, SPLIT_BLANK_LINE + l2];
  }
  return [l1 + l2, l2 + l1]; // flipflop
}

let splitMode = 'flipflop';
let splitLine1Reverse = false;
let splitLine1PingPong = false;
let splitLine2Reverse = false;
let splitLine2PingPong = false;
const splitLine1Input = el('split-line1-input');
const splitLine2Input = el('split-line2-input');
const splitLine1Count = el('split-line1-count');
const splitLine2Count = el('split-line2-count');
const splitHexOutput = el('split-hex-output');
const splitMarqueeDirectionsRow = el('split-marquee-directions-row');

const splitModeToggle = el('split-mode-toggle');
const splitModeBtns = [...splitModeToggle.querySelectorAll('.segment-btn')];
const splitLine1ReverseToggle = el('split-line1-reverse-toggle');
const splitLine1ReverseLabel = el('split-line1-reverse-label');
const splitLine1PingPongToggle = el('split-line1-pingpong-toggle');
const splitLine2ReverseToggle = el('split-line2-reverse-toggle');
const splitLine2ReverseLabel = el('split-line2-reverse-label');
const splitLine2PingPongToggle = el('split-line2-pingpong-toggle');

const splitSharedWaitKnobWidget = createKnob({
  min: 50, max: 2000, value: 300, step: 10, resetValue: 300,
  onChange: () => renderSplitHexPreview(),
});
el('split-shared-wait-knob').appendChild(splitSharedWaitKnobWidget.element);

// Same border-box height-fix as marqueeAutoGrowInput above, just
// parameterized so both Line 1 and Line 2 can share it.
function splitAutoGrowInput(input) {
  const cs = getComputedStyle(input);
  const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight + borderY}px`;
}

function setSplitMode(mode) {
  splitMode = mode;
  splitModeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  splitMarqueeDirectionsRow.hidden = mode !== 'marquee';
  const maxLen = mode === 'marquee' ? SPLIT_LINE_MAX_LENGTH : SPLIT_LINE_LENGTH;
  [splitLine1Input, splitLine2Input].forEach((input) => {
    input.maxLength = maxLen;
    if (input.value.length > maxLen) input.value = input.value.slice(0, maxLen);
  });
  splitLine1Count.textContent = `${splitLine1Input.value.length}/${maxLen}`;
  splitLine2Count.textContent = `${splitLine2Input.value.length}/${maxLen}`;
  renderSplitHexPreview();
}

splitModeBtns.forEach((btn) => {
  btn.addEventListener('click', () => setSplitMode(btn.dataset.mode));
});

splitLine1ReverseToggle.addEventListener('change', () => {
  splitLine1Reverse = splitLine1ReverseToggle.checked;
  splitLine1ReverseLabel.textContent = splitLine1Reverse ? 'Reverse' : 'Forward';
  renderSplitHexPreview();
});
splitLine1PingPongToggle.addEventListener('change', () => {
  splitLine1PingPong = splitLine1PingPongToggle.checked;
  renderSplitHexPreview();
});
splitLine2ReverseToggle.addEventListener('change', () => {
  splitLine2Reverse = splitLine2ReverseToggle.checked;
  splitLine2ReverseLabel.textContent = splitLine2Reverse ? 'Reverse' : 'Forward';
  renderSplitHexPreview();
});
splitLine2PingPongToggle.addEventListener('change', () => {
  splitLine2PingPong = splitLine2PingPongToggle.checked;
  renderSplitHexPreview();
});

function splitHandleLineInput(input, countEl) {
  const maxLen = splitMode === 'marquee' ? SPLIT_LINE_MAX_LENGTH : SPLIT_LINE_LENGTH;
  if (input.value.length > maxLen) input.value = input.value.slice(0, maxLen);
  countEl.textContent = `${input.value.length}/${maxLen}`;
  splitAutoGrowInput(input);
  renderSplitHexPreview();
}
splitLine1Input.addEventListener('input', () => splitHandleLineInput(splitLine1Input, splitLine1Count));
splitLine2Input.addEventListener('input', () => splitHandleLineInput(splitLine2Input, splitLine2Count));

// Marquee's per-line Ping-Pong sequences can be long enough on their own
// (up to a few hundred steps each at the 500-char cap) that their LCM -
// the true combined step count, see splitBuildMarqueeFrames - reaches
// into the hundreds of thousands when the two lines' lengths don't share
// many factors. Rebuilding and re-formatting all of that as hex text on
// every keystroke would freeze typing, so the preview only ever builds
// the first SPLIT_PREVIEW_MAX_STEPS steps and says so when it's cut the
// sequence short. Play Split Message always sends the real, complete
// sequence regardless of what the preview had to truncate.
const SPLIT_PREVIEW_MAX_STEPS = 500;

function renderSplitHexPreview() {
  const line1 = splitLine1Input.value;
  const line2 = splitLine2Input.value;
  if (!line1 && !line2) {
    splitHexOutput.textContent = 'Type Line 1 and/or Line 2 above to build the sequence.';
    return;
  }
  const waitMs = Math.round(splitSharedWaitKnobWidget.getValue());
  const steps = splitBuildCombinedSteps(line1, line2, SPLIT_PREVIEW_MAX_STEPS);
  const totalSteps = steps.totalFrames ?? steps.length;
  const hex = steps
    .map((stepText, index) => {
      const bytes = buildMessageWindow(0, stepText);
      const hexBytes = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return `; Step ${index + 1} (wait ${waitMs}ms)\n${hexBytes}`;
    })
    .join('\n\n');
  splitHexOutput.textContent = totalSteps > steps.length
    ? `${hex}\n\n; ...showing first ${steps.length} of ${totalSteps} steps - Play Split Message sends the full sequence.`
    : hex;
}

let splitPlaying = false;
let splitStopRequested = false;
const splitLoopToggle = el('split-loop-toggle');
const splitStopBtn = el('split-stop-btn');

el('split-play-btn').addEventListener('click', async () => {
  if (splitPlaying) return;
  const line1 = splitLine1Input.value;
  const line2 = splitLine2Input.value;
  if (!line1 && !line2) {
    statusEl.textContent = 'Error: type Line 1 and/or Line 2 before playing it.';
    return;
  }
  const steps = splitBuildCombinedSteps(line1, line2);
  splitPlaying = true;
  splitStopRequested = false;
  el('split-play-btn').disabled = true;
  try {
    do {
      for (let i = 0; i < steps.length; i++) {
        link.send(buildMessageWindow(0, steps[i]));
        const waitMs = Math.round(splitSharedWaitKnobWidget.getValue());
        const isLastStep = i === steps.length - 1;
        if (splitStopRequested) break;
        if (!isLastStep || splitLoopToggle.checked) await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (splitStopRequested) break;
      }
    } while (splitLoopToggle.checked && !splitStopRequested);
    statusEl.textContent = splitStopRequested ? 'Split message stopped.' : 'Played split message.';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    splitPlaying = false;
    splitStopRequested = false;
    el('split-play-btn').disabled = false;
  }
});

splitStopBtn.addEventListener('click', () => {
  splitStopRequested = true;
});

setSplitMode('flipflop');

const originalSend = link.send.bind(link);
link.send = (bytes, timestamp) => {
  log('OUT', bytes);
  diagLog('OUT', bytes);
  originalSend(bytes, timestamp);
};
link.onMessage = (bytes) => {
  log('IN ', bytes);
  diagLog('IN ', bytes);
  handleIncomingVoiceChange(bytes);
  handleIncomingNoteOn(bytes);
};

// MIDI Clock generator for "Rec-Arm Insert" and the transport Play button -
// a bare Start byte isn't enough to make the QY70/QY100 (or most
// MIDI-synced hardware) actually run; it needs a continuous stream of
// Timing Clock pulses (24 per quarter note) behind it to sync playback to,
// the same way a DAW does when it starts external gear. setInterval alone
// drifts too much for this, so a look-ahead scheduler runs every 25ms and
// hands each pulse a precise send timestamp (performance.now()-domain)
// instead of relying on the interval's own firing time. This stream just
// keeps running harmlessly in the background until the transport Stop
// button stops it (or the output disconnects, which does too - see the
// catch in scheduleClockPulses).
const PPQN = 24;
const CLOCK_LOOKAHEAD_MS = 100;
const CLOCK_SCHEDULER_INTERVAL_MS = 25;
const messagingEnabledCheckbox = el('messaging-enabled');
let clockRunning = false;
let clockTimerId = null;
let nextPulseTime = 0;

// A continuous knob instead of a plain number field, matching every other
// value control in this app - lives in the connect bar rather than a
// param row, so it's built directly here instead of through renderParamPanel.
const tempoKnobWidget = createKnob({
  min: 20,
  max: 300,
  value: 120,
  step: 1,
  resetValue: 120,
  onChange: (value) => sendMessageWindow(`Ext BPM: ${Math.round(value)}`),
});
el('tempo-knob').appendChild(tempoKnobWidget.element);

// Tap Tempo - click along with the beat instead of dialing the knob by
// hand. Averages the last few gaps between taps for a stable reading and
// forgets the run if you pause too long, rather than blending an old
// tempo into a fresh one.
const TAP_TEMPO_RESET_GAP_MS = 2000;
const TAP_TEMPO_MEMORY = 6;
let tapTimes = [];
el('tap-tempo-btn').addEventListener('click', () => {
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > TAP_TEMPO_RESET_GAP_MS) tapTimes = [];
  tapTimes.push(now);
  if (tapTimes.length > TAP_TEMPO_MEMORY + 1) tapTimes.shift();
  if (tapTimes.length < 2) return;
  const intervals = [];
  for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
  const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const bpm = Math.round(60000 / avgMs);
  tempoKnobWidget.setValue(bpm, true);
});

function msPerClockPulse() {
  const bpm = Math.max(1, Math.round(tempoKnobWidget.getValue()) || 120);
  return 60000 / bpm / PPQN;
}

function scheduleClockPulses() {
  const horizon = performance.now() + CLOCK_LOOKAHEAD_MS;
  while (nextPulseTime < horizon) {
    try {
      link.send(new Uint8Array([0xf8]), nextPulseTime);
    } catch (err) {
      try {
        stopClock();
      } catch {
        // The Clock pulse above already failed for the same reason (output
        // gone) - that's the error worth showing, not this follow-up Stop.
      }
      statusEl.textContent = `Error: ${err.message}`;
      return;
    }
    nextPulseTime += msPerClockPulse();
  }
}

// Starts the pulse-scheduling interval if it isn't already running - shared
// by both Start (fresh song) and Continue (resume from a located position),
// since once going the pulse stream itself doesn't care which one kicked it
// off. Never sends anything on its own.
function ensureClockRunning() {
  if (clockRunning) return;
  clockRunning = true;
  nextPulseTime = performance.now();
  scheduleClockPulses();
  clockTimerId = setInterval(scheduleClockPulses, CLOCK_SCHEDULER_INTERVAL_MS);
}

function startClock() {
  link.send(new Uint8Array([0xfa])); // Start - throws here if no output selected, before touching any running state
  ensureClockRunning();
}

// Called both by the transport Stop button and internally (see the catch
// in scheduleClockPulses) when the output disconnects mid-stream. Throws
// like every other send in this file rather than swallowing its own
// errors - the internal call site below is the one place that needs to
// suppress it, since it already has a more relevant error to show.
function stopClock() {
  if (!clockRunning) return;
  clearInterval(clockTimerId);
  clockTimerId = null;
  clockRunning = false;
  link.send(new Uint8Array([0xfc])); // Stop
}

// Unlike Start, Continue resumes from wherever the QY70/QY100's Song
// Position currently is instead of rewinding to the top - the complement
// to Rewind below, which relocates without starting anything.
function continueClock() {
  link.send(new Uint8Array([0xfb])); // Continue - throws here if no output selected
  ensureClockRunning();
}

// Relocates to the top of the song/pattern without starting playback.
// Song Position Pointer is only reliably honored while stopped (learned
// the hard way with the earlier SPP Punch Insert attempt - see README),
// so this always sends a real Stop first regardless of whether this app's
// own clockRunning flag thinks anything is currently going, in case
// playback was started from the device's own front panel rather than the
// Play button here.
function rewindToStart() {
  link.send(new Uint8Array([0xfc])); // Stop - throws here if no output selected, before touching any running state
  if (clockRunning) {
    clearInterval(clockTimerId);
    clockTimerId = null;
    clockRunning = false;
  }
  link.send(new Uint8Array([0xf2, 0x00, 0x00])); // Song Position Pointer = 0
}

// Standalone transport controls - same Start+Clock/Stop plumbing Rec-Arm
// Insert and the internal disconnect handling already use, just triggered
// directly rather than alongside punching in a parameter.
el('transport-play-btn').addEventListener('click', () => {
  try {
    startClock();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});
el('transport-continue-btn').addEventListener('click', () => {
  try {
    continueClock();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});
el('transport-stop-btn').addEventListener('click', () => {
  try {
    stopClock();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});
el('transport-rewind-btn').addEventListener('click', () => {
  try {
    rewindToStart();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// Section Control (see buildSectionControl in sysex.js) - jumps the
// currently playing pattern/song straight to one of the QY70/QY100's
// arrangement sections, the same as pressing its own section buttons.
document.querySelectorAll('.section-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    try {
      link.send(buildSectionControl(SECTION[btn.dataset.section]));
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  });
});

// Top-level main tabs - each .main-tab's data-tab picks the .tab-panel
// with the matching id suffix (#tab-panel-<data-tab>) to show, hiding the
// rest. The standing MIDI Log section below the tabs is hidden while
// Diagnostics is open (it has its own, more capable live log) and shown
// again for every other tab, so there's never two overlapping logs on
// screen at once.
document.querySelectorAll('.main-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.main-tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-panel-${tab.dataset.tab}`);
    });
    el('log').hidden = tab.dataset.tab === 'diagnostics';
    // The raw SysEx textarea's auto-grow sizing (see autoGrowRawSysexInput
    // above) reads scrollHeight, which is 0 while its tab panel is
    // display:none - re-run it now that the panel (and its wrapped
    // placeholder text) actually has a rendered layout to measure.
    if (tab.dataset.tab === 'diagnostics') autoGrowRawSysexInput();
  });
});

// Song Select doubles as Pattern Select - see buildSongSelect's own
// comment for why there's only one control here rather than two.
el('song-select-btn').addEventListener('click', () => {
  try {
    // Input shows the same 1-based numbering as the device's own display
    // (Song/Pattern 1, 2, 3...) - the wire value is 0-based, same
    // convention as Program Number elsewhere in this app.
    const displayed = Number(el('song-select-input').value) || 1;
    link.send(buildSongSelect(displayed - 1));
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

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

// Global tooltip - a single element (#global-tooltip in index.html,
// position:fixed) shared by every .info-icon/.attention-icon/
// .label-info-icon/.raw-sysex-frame-byte in the app, positioned fresh on
// each hover instead of each icon carrying its own CSS ::after. That
// per-icon approach could only ever render inside whatever ancestor
// happened to contain the icon, so an icon inside any scrolling
// container (e.g. #param-list) had its tooltip clipped at that
// container's edge no matter its z-index - overflow clipping always
// wins over z-index. A position:fixed element escapes that entirely.
//
// Delegated on `document` (mouseover/mouseout, which bubble, rather than
// mouseenter/mouseleave, which don't) instead of attached per-icon,
// because most of these icons are created dynamically well after this
// script runs (every param row, insert button, etc. - see
// renderParamPanel and friends) and re-created on every re-render, so a
// one-time querySelectorAll+forEach at load time would miss them.
const globalTooltip = el('global-tooltip');
let globalTooltipTarget = null;

function findTooltipTarget(node) {
  return node.closest ? node.closest('.info-icon, .attention-icon, .label-info-icon, .raw-sysex-frame-byte') : null;
}

function positionGlobalTooltip(target) {
  const margin = 6;
  const iconRect = target.getBoundingClientRect();
  const tipRect = globalTooltip.getBoundingClientRect();
  let left = iconRect.left;
  if (left + tipRect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - margin - tipRect.width);
  }
  let top = iconRect.bottom + margin;
  if (top + tipRect.height > window.innerHeight - margin) {
    top = iconRect.top - margin - tipRect.height;
  }
  globalTooltip.style.left = `${left}px`;
  globalTooltip.style.top = `${top}px`;
}

function showGlobalTooltip(target) {
  const text = target.dataset.tooltip;
  if (!text) return;
  globalTooltipTarget = target;
  globalTooltip.textContent = text;
  globalTooltip.classList.add('visible');
  positionGlobalTooltip(target);
}

function hideGlobalTooltip() {
  globalTooltipTarget = null;
  globalTooltip.classList.remove('visible');
}

// mouseover doesn't refire just because the page scrolled under a
// stationary cursor, so a tooltip left open while the user scrolls (the
// page itself, or an internal list like #param-list) would otherwise
// stay anchored to its icon's old position instead of following it -
// simplest fix is to dismiss it, same as most tooltip implementations do
// on scroll. `capture: true` catches scrolling on any scrollable
// ancestor, not just the window, since scroll events don't bubble.
window.addEventListener('scroll', hideGlobalTooltip, true);

document.addEventListener('mouseover', (evt) => {
  const target = findTooltipTarget(evt.target);
  if (target && target !== globalTooltipTarget) showGlobalTooltip(target);
});

document.addEventListener('mouseout', (evt) => {
  if (!globalTooltipTarget) return;
  const target = findTooltipTarget(evt.target);
  if (target === globalTooltipTarget && (!evt.relatedTarget || !target.contains(evt.relatedTarget))) {
    hideGlobalTooltip();
  }
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
        sendMessageWindow(entry.name);
      } else {
        // Legacy single-part .qyvoice files (saved before Save Voice
        // started capturing all 32 parts at once) still apply to whichever
        // Part is picked in "Apply to" above.
        const part = Number(voicePartSelect.value);
        const ok = await showConfirm('Are you sure?', confirmApplyMessage(entry.name, partLabel(part)), 'Apply', { html: true });
        if (!ok) return;
        showProgress(`Applying ${entry.name}`, 'Sends every Multi Part parameter for this voice to the device - avoid touching the QY70/QY100 until it finishes.');
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
          applyUserVoiceParamsToPart(part, entry.params);
          updateProgress(1, 1);
          await new Promise((resolve) => setTimeout(resolve, 0));
        } catch (err) {
          statusEl.textContent = `Error: ${err.message}`;
        } finally {
          hideProgress();
        }
        selectedVoiceKey = key;
        selectedVoiceLabel = entry.name;
        renderVoiceList();
        refreshIfViewingPart(part);
        sendMessageWindow(entry.name);
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
      sendMessageWindow(entry.name);
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
  updateVoiceFilterIndicator();
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
          sendMessageWindow(name);
          await showAlert('Kit selected', `${name} has been selected for Ds${ch + 1} (Channel ${ch + 1}). Navigate to Ds${ch + 1} on your device to hear it.`);
          return;
        }
      } else {
        part = Number(voicePartSelect.value);
        const ok = await showConfirm('Are you sure?', confirmApplyMessage(name, partLabel(part)), 'Apply', { html: true });
        if (!ok) return;
      }
      showProgress(`Applying ${name}`, 'Sends every Multi Part parameter for this voice to the device - avoid touching the QY70/QY100 until it finishes.');
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        resetPartToDefaults(part);
        applyVoiceToPart(part, v);
        updateProgress(1, 1);
        await new Promise((resolve) => setTimeout(resolve, 0));
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      } finally {
        hideProgress();
      }
      selectedVoiceKey = key;
      selectedVoiceLabel = name;
      selectedVoiceObj = v;
      renderVoiceList();
      refreshIfViewingPart(part);
      sendMessageWindow(name);
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
            sendMessageWindow(preset.name);
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
            showProgress(`Applying ${preset.name}`, 'Sends every Multi Part parameter for this preset to the device - avoid touching the QY70/QY100 until it finishes.');
            try {
              await new Promise((resolve) => setTimeout(resolve, 0));
              applyPreset(preset, part);
              updateProgress(1, 1);
              await new Promise((resolve) => setTimeout(resolve, 0));
            } catch (err) {
              statusEl.textContent = `Error: ${err.message}`;
            } finally {
              hideProgress();
            }
          }
          selectedVoiceKey = presetKey;
          selectedVoiceLabel = preset.name;
          renderVoiceList();
          sendMessageWindow(preset.name);
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

// Sends a Message Window confirmation, but only when the "Messaging"
// toggle in the connect bar is checked - purely a nice-to-have display on
// the QY70/QY100's own screen, so it's easy to opt out of entirely rather
// than fighting it every time an action briefly takes over the LCD. Fails
// silently (unlike every other link.send call site in this file) - it's
// always called after the action it's confirming has already succeeded or
// reported its own error, so surfacing a second, unrelated "No MIDI output
// selected" here would just clobber that more important status message.
function sendMessageWindow(text) {
  if (!messagingEnabledCheckbox.checked) return;
  try {
    link.send(buildMessageWindow(0, text));
  } catch {
    // Cosmetic only - see comment above.
  }
}

// Bypasses sendMessageWindow's own checked-state guard: toggling messaging
// off should still show that one last "Messaging Off" confirmation before
// it goes silent, rather than being silently skipped by the same guard it's
// announcing the state of.
messagingEnabledCheckbox.addEventListener('change', () => {
  try {
    link.send(buildMessageWindow(0, messagingEnabledCheckbox.checked ? 'Messaging On' : 'Messaging Off'));
  } catch {
    // Cosmetic only - see sendMessageWindow above.
  }
});

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
    sendMessageWindow('XG Sys On');
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

// GM System On is a generic MIDI message (no Yamaha ID/device number),
// switching the QY70/QY100 into General MIDI mode instead - everything
// else in this app (Voice/Parameters, Graphics, Display Text) targets XG
// mode, so this is really only here for playing back/testing plain GM
// content; XG System On above is what most sessions actually want.
el('gm-on-btn').addEventListener('click', async () => {
  const confirmed = await showConfirm(
    'Send GM System On?',
    'Switches the QY70/QY100 into General MIDI mode instead of XG mode - ' +
    "resets volume, pan, program, bank, and most controllers to GM defaults. " +
    "Every other feature in this app targets XG mode, so this is rarely what you want; " +
    "use Send XG System On instead unless you specifically need plain GM."
  );
  if (!confirmed) return;
  try {
    link.send(buildGmSystemOn());
    sendMessageWindow('GM Sys On');
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

const helpDialog = el('help-dialog');
const helpTabs = [...helpDialog.querySelectorAll('.dialog-tab')];
const helpPanels = [...helpDialog.querySelectorAll('.dialog-tab-panel')];
helpTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    helpTabs.forEach((t) => t.classList.toggle('active', t === tab));
    helpPanels.forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    helpDialog.querySelector('.dialog-body').scrollTop = 0;
  });
});
el('help-btn').addEventListener('click', () => {
  helpTabs[0]?.click();
  helpDialog.showModal();
});
el('help-dialog-close').addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', (evt) => { if (evt.target === helpDialog) helpDialog.close(); });

el('contact-btn').addEventListener('click', () => sendMessageWindow('Looking forward to your message!'));

resetSectionBtn.addEventListener('click', async () => {
  const sectionLabel = parameters[sectionSelect.value]?.label || 'this section';
  const confirmed = await showConfirm(
    `Reset all ${sectionLabel} parameters?`,
    `This sets every parameter in ${sectionLabel} back to its default value and sends the change now. ` +
    'Any custom values you\'ve dialed in here will be lost.'
  );
  if (!confirmed) return;
  for (const resetFn of currentSectionResetFns) resetFn();
  sendMessageWindow(`${sectionLabel} Reset`);
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

const fxFileControls = el('fx-file-controls');
const fxFileInput = el('fx-file-input');
const saveFxBtn = el('save-fx-btn');
const loadFxBtn = el('load-fx-btn');
const fxPresetBrowser = el('fx-preset-browser');
const fxPresetListEl = el('fx-preset-list');
const fxPresetSourceToggle = el('fx-preset-source-toggle');
const fxPresetSourceBtns = [...fxPresetSourceToggle.querySelectorAll('.segment-btn')];
// Shared across Reverb/Chorus/Variation (not reset per section) - picking
// "User" once and then switching sections keeps showing your own presets
// rather than snapping back to Built-in every time.
let fxPresetSource = 'builtin';
fxPresetSourceBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    fxPresetSource = btn.dataset.source;
    fxPresetSourceBtns.forEach((b) => b.classList.toggle('active', b === btn));
    renderFxPresetList(sectionSelect.value);
  });
});

// Reverb/Chorus/Variation each get their own save/load file type and
// built-in-plus-loaded preset browser, mirroring the Voice Browser but
// scoped to one section's worth of parameters instead of a whole Part.
const FX_SECTIONS = {
  reverb: { label: 'Reverb', ext: '.qyrev', format: 'qyrev', description: 'QY70/QY100 Reverb' },
  chorus: { label: 'Chorus', ext: '.qycho', format: 'qycho', description: 'QY70/QY100 Chorus' },
  variation: { label: 'Variation', ext: '.qyvar', format: 'qyvar', description: 'QY70/QY100 Variation' },
};

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

async function loadFxPresets() {
  const res = await fetch('./data/fx_presets.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load fx_presets.json: ${res.status}`);
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
  'MW Pitch Control': semitoneDesc,
  "Ch's AT Pitch Control": semitoneDesc,
  'Pitch EG Initial Level': semitoneDesc,
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
  renderFxPresetList(sectionKey);

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
    // Its select is a full effect-name picker rather than a short readout,
    // so it gets its own full-width line above the MSB/LSB knobs instead of
    // squeezing into the narrow .param-desc column every other row uses.
    if (isEffectTypeRow) div.classList.add('effect-type-row');
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

    // Shared by the Insert button below - sends every knob in this row's
    // current value right now, same wire logic as a live onChange send.
    function sendRowNow() {
      try {
        const doSend = (ctx) => {
          if (combineSend && grouped) {
            sendParamGroup(link, 0, section, ctx, rows, knobs.map((k) => k.getValue()));
          } else {
            rows.forEach((r, i) => sendParam(link, 0, section, ctx, r, knobs[i].getValue()));
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
    }

    // Explicitly (re-)transmits this row's current value right now,
    // regardless of Active/Ignored (which only governs live drag/typed
    // sends and .qyparam loads) - meant for punching a specific parameter
    // into a QY70/QY100 song while it's actively recording (Replace,
    // Overdub, or Multi), without needing to nudge the knob to trigger a
    // change.
    const insertWrap = document.createElement('div');
    insertWrap.className = 'insert-wrap';

    const insertInfoIcon = document.createElement('button');
    insertInfoIcon.type = 'button';
    insertInfoIcon.className = 'info-icon insert-info-icon';
    insertInfoIcon.textContent = 'i';
    insertInfoIcon.dataset.tooltip = "Sends this parameter's current value to the device while a song/pattern is actively recording in REPL, OVER, or MULTI mode - lets you punch-in the parameter's setting at the moments you desire.";

    const insertBtn = document.createElement('button');
    insertBtn.type = 'button';
    insertBtn.className = 'insert-btn';
    insertBtn.textContent = 'Punch Insert';
    let insertBtnSentTimeoutId = null;
    insertBtn.addEventListener('click', () => {
      sendRowNow();
      insertBtn.classList.add('sent');
      // Punch Insert is meant to be clicked repeatedly in quick succession
      // while punching values into a live recording (see the tooltip
      // above) - clearing any still-pending removal from an earlier click
      // before scheduling this one means the flash always fades exactly
      // 250ms after the LAST click, instead of an earlier click's timer
      // occasionally winning the race and cutting a later flash short,
      // which read as the button flickering/staying lit during a fast
      // punch-in sequence rather than animating cleanly like Rec-Arm
      // Insert (normally clicked once, so it never hit this race).
      if (insertBtnSentTimeoutId !== null) clearTimeout(insertBtnSentTimeoutId);
      insertBtnSentTimeoutId = setTimeout(() => {
        insertBtn.classList.remove('sent');
        insertBtnSentTimeoutId = null;
      }, 250);
    });

    insertWrap.appendChild(insertInfoIcon);
    insertWrap.appendChild(insertBtn);
    div.appendChild(insertWrap);

    // "Rec-Arm Insert" - sends a MIDI Play (Start) message plus a Clock
    // stream to start the QY70/QY100 playing, immediately followed by this
    // row's current value - starts playback and punches this parameter in
    // right at the top, in a single click, rather than needing Play pressed
    // on the device and this parameter sent separately by hand.
    const playInsertWrap = document.createElement('div');
    playInsertWrap.className = 'insert-wrap';

    const playInsertInfoIcon = document.createElement('button');
    playInsertInfoIcon.type = 'button';
    playInsertInfoIcon.className = 'info-icon insert-info-icon';
    playInsertInfoIcon.textContent = 'i';
    playInsertInfoIcon.dataset.tooltip = "Arm your QY70/QY100 to record in REPL, OVER, or MULTI mode (but don't begin the recording on the device). Click the REC-ARM INSERT button to trigger recording to initiate, and insert the corresponding parameter value. Useful for inserting parameter changes at the beginning of a song/pattern.";

    const playInsertBtn = document.createElement('button');
    playInsertBtn.type = 'button';
    playInsertBtn.className = 'insert-btn play-insert-btn';
    playInsertBtn.textContent = 'Rec-Arm Insert';
    let playInsertBtnSentTimeoutId = null;
    playInsertBtn.addEventListener('click', () => {
      try {
        startClock();
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
        return;
      }
      sendRowNow();
      playInsertBtn.classList.add('sent');
      // Same debounce as Punch Insert above, for the same reason - kept
      // symmetric even though this button is normally only clicked once.
      if (playInsertBtnSentTimeoutId !== null) clearTimeout(playInsertBtnSentTimeoutId);
      playInsertBtnSentTimeoutId = setTimeout(() => {
        playInsertBtn.classList.remove('sent');
        playInsertBtnSentTimeoutId = null;
      }, 250);
    });

    playInsertWrap.appendChild(playInsertInfoIcon);
    playInsertWrap.appendChild(playInsertBtn);
    div.appendChild(playInsertWrap);

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

// ---- Reverb/Chorus/Variation preset browser (.qyrev/.qycho/.qyvar) ----
// Same built-in-plus-loaded-list shape as the Voice Browser, but scoped to
// one FX section's own parameters rather than a whole Part - clicking an
// item only highlights it, its own Push button is what actually applies
// and sends the preset (same "select vs. apply" split as voices/kits).
function renderFxPresetList(sectionKey) {
  const cfg = FX_SECTIONS[sectionKey];
  fxFileControls.hidden = !cfg;
  fxPresetBrowser.hidden = !cfg;
  if (!cfg) return;
  saveFxBtn.textContent = `Save ${cfg.label}`;
  loadFxBtn.textContent = `Load ${cfg.label}`;
  fxFileInput.accept = cfg.ext;
  fxPresetSourceBtns.forEach((b) => b.classList.toggle('active', b.dataset.source === fxPresetSource));

  const list = fxPresetSource === 'user' ? userFxPresets[sectionKey] : (fxPresets[sectionKey] || []);
  fxPresetListEl.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'fx-preset-empty';
    li.textContent = fxPresetSource === 'user'
      ? `No ${cfg.label} presets loaded yet - use Load above.`
      : `No ${cfg.label} presets.`;
    fxPresetListEl.appendChild(li);
    return;
  }
  for (const preset of list) {
    const li = document.createElement('li');
    li.dataset.key = preset.id;
    li.innerHTML = `<span class="fx-preset-name">${escapeHtml(preset.name)}</span><button type="button" class="push-voice-btn">Push</button>`;
    li.addEventListener('click', () => {
      fxPresetListEl.querySelectorAll('li.selected').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
    });
    li.querySelector('.push-voice-btn').addEventListener('click', async (evt) => {
      evt.stopPropagation();
      const ok = await showConfirm('Are you sure?', confirmApplyMessage(preset.name, cfg.label), 'Apply', { html: true });
      if (!ok) return;
      safeAssign(paramState[sectionKey], preset.params);
      showProgress(`Applying ${preset.name}`, `Sends every ${cfg.label} parameter to the device - avoid touching the QY70/QY100 until it finishes.`);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        resendSectionContext(sectionKey, {}, preset.params);
        updateProgress(1, 1);
        await new Promise((resolve) => setTimeout(resolve, 0));
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      } finally {
        hideProgress();
      }
      renderParamPanel();
      sendMessageWindow(preset.name);
    });
    fxPresetListEl.appendChild(li);
  }
}

// Full current-value snapshot of every row in a section - same idea as
// snapshotPartVoice, but for a global (non-Part) section, so there's no
// context to resolve beyond the section itself.
function snapshotSection(sectionKey) {
  const section = parameters[sectionKey];
  const store = paramState[sectionKey];
  const params = {};
  for (const row of expandRows(section.params)) {
    params[row.name] = store[row.name] ?? resolveDefault(row, {}) ?? row.dataMin;
  }
  return params;
}

saveFxBtn.addEventListener('click', async () => {
  const sectionKey = sectionSelect.value;
  const cfg = FX_SECTIONS[sectionKey];
  if (!cfg) return;
  const name = `${cfg.label} ${new Date().toISOString().slice(0, 10)}`;
  const file = { format: cfg.format, version: 1, savedAt: new Date().toISOString(), name, params: snapshotSection(sectionKey) };
  try {
    const savedName = await writeFile(`${name}${cfg.ext}`, JSON.stringify(file, null, 1), cfg.description, cfg.ext);
    await showAlert(`${cfg.label} saved`, `Saved the current ${cfg.label} settings as ${savedName}.`);
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

async function loadFxFileText(sectionKey, text, filename) {
  const cfg = FX_SECTIONS[sectionKey];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    statusEl.textContent = `Error: not a valid ${cfg.ext} file.`;
    return;
  }
  if (data?.format !== cfg.format || !data.params) {
    statusEl.textContent = `Error: not a valid ${cfg.ext} file.`;
    return;
  }
  const extRe = new RegExp(`\\${cfg.ext}$`, 'i');
  const name = filename?.replace(extRe, '') || data.name || cfg.label;
  const list = userFxPresets[sectionKey];
  const existingIndex = list.findIndex((p) => p.name === name);
  if (existingIndex !== -1) {
    const overwrite = await showConfirm(
      `${cfg.label} preset already loaded`,
      `A ${cfg.label} preset named "${name}" is already in the User list. Overwrite it, or cancel to abort loading?`,
      'Overwrite'
    );
    if (!overwrite) return;
    list.splice(existingIndex, 1);
  }
  list.push({ id: `${Date.now()}`, name, params: data.params });
  // Switch to the User tab so the newly-loaded preset is actually visible,
  // rather than silently landing behind Built-in if that's what's showing.
  fxPresetSource = 'user';
  renderFxPresetList(sectionKey);
  await showAlert(`${cfg.label} loaded`, `Loaded ${filename || 'file'} into the ${cfg.label} preset list below.`);
}

loadFxBtn.addEventListener('click', async () => {
  const sectionKey = sectionSelect.value;
  const cfg = FX_SECTIONS[sectionKey];
  if (!cfg) return;
  try {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: cfg.description, accept: { 'application/json': [cfg.ext] } }],
      });
      const file = await handle.getFile();
      await loadFxFileText(sectionKey, await file.text(), handle.name);
    } else {
      fxFileInput.click();
    }
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = `Error: ${err.message}`;
  }
});

fxFileInput.addEventListener('change', async () => {
  const sectionKey = sectionSelect.value;
  const file = fxFileInput.files[0];
  fxFileInput.value = '';
  if (file) await loadFxFileText(sectionKey, await file.text(), file.name);
});

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
  safeAssign(paramState, patch.paramState || {});
  safeAssign(ignoredState, patch.ignoredState || {});
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
  const displayValue = channelSelect.value === 'all' ? 'All' : Number(channelSelect.value) + 1;
  sendMessageWindow(`MIDI Ch: ${displayValue}`);
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
  sendMessageWindow('Kit Pushed');
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
  sendMessageWindow(`${parameters[sectionKey]?.label || 'Params'} Pushed`);
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
  sendMessageWindow('All Parts Pushed');
});

// ---- Boot ----

(async () => {
  [voices, parameters, drumNotes, presets, effectTypes, effectParams, effectValueTables, fxPresets, graphicsPresets, graphicsAnimationPresets] = await Promise.all(
    [loadVoices(), loadParameters(), loadDrumNotes(), loadPresets(), loadEffectTypes(), loadEffectParams(), loadEffectValueTables(), loadFxPresets(), loadGraphicsPresets(), loadGraphicsAnimationPresets()]);
  refreshCategoryOptions();
  renderVoiceList();
  populatePartSelect(partSelect);
  populatePartSelect(voicePartSelect);
  updateBankSelectAvailability();
  populateDrumkitSelect();
  populateNoteSelect();
  renderParamPanel();
  renderGraphicsLibrary();
})();
