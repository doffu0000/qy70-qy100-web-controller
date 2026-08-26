// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// A minimal rotary knob control: drag vertically to change the value,
// or type directly into the field below it. No external dependencies -
// plain SVG + pointer events.

const SWEEP_DEG = 270; // total rotation range, -135deg..+135deg
const START_DEG = -135;
const DRAG_PIXELS_FOR_FULL_RANGE = 160;
// Cap on how often a continuousSend knob fires mid-drag - fast enough to
// feel live for performance tweaking, slow enough not to flood the MIDI
// link or the QY70/QY100's SysEx parser.
const CONTINUOUS_SEND_MS = 60;

function valueToAngle(value, min, max) {
  const frac = max === min ? 0 : (value - min) / (max - min);
  return START_DEG + frac * SWEEP_DEG;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function createKnob({ min, max, value, step = 1, onChange, onInput, resetValue, caption, continuousSend = false }) {
  let current = clamp(value, min, max);

  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap';

  if (caption) {
    const captionEl = document.createElement('span');
    captionEl.className = 'knob-caption';
    captionEl.textContent = caption;
    wrap.appendChild(captionEl);
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'knob-dial');

  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('cx', '20');
  track.setAttribute('cy', '20');
  track.setAttribute('r', '17');
  track.setAttribute('class', 'knob-track');
  svg.appendChild(track);

  const indicator = document.createElementNS(svgNS, 'line');
  indicator.setAttribute('x1', '20');
  indicator.setAttribute('y1', '20');
  indicator.setAttribute('x2', '20');
  indicator.setAttribute('y2', '6');
  indicator.setAttribute('class', 'knob-indicator');
  svg.appendChild(indicator);

  const controls = document.createElement('div');
  controls.className = 'knob-controls';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'reset-btn';
  resetBtn.textContent = 'Reset';
  if (resetValue !== undefined && resetValue !== null) {
    resetBtn.title = `Reset to default (${resetValue})`;
    resetBtn.addEventListener('click', () => setValue(resetValue, true));
  } else {
    resetBtn.disabled = true;
  }
  controls.appendChild(resetBtn);

  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.className = 'knob-value';
  controls.appendChild(input);

  wrap.appendChild(svg);
  wrap.appendChild(controls);

  function render() {
    const angle = valueToAngle(current, min, max);
    indicator.setAttribute('transform', `rotate(${angle} 20 20)`);
    input.value = String(Math.round(current));
    if (onInput) onInput(current);
  }

  function setValue(v, fire) {
    current = clamp(v, min, max);
    render();
    if (fire && onChange) onChange(current);
  }

  let dragStartY = null;
  let dragStartValue = null;
  let lastSentAt = 0;
  let lastSentValue = null;

  svg.addEventListener('pointerdown', (e) => {
    dragStartY = e.clientY;
    dragStartValue = current;
    lastSentAt = 0;
    lastSentValue = null;
    svg.setPointerCapture(e.pointerId);
    wrap.classList.add('dragging');
  });
  svg.addEventListener('pointermove', (e) => {
    if (dragStartY === null) return;
    const dy = dragStartY - e.clientY;
    const frac = dy / DRAG_PIXELS_FOR_FULL_RANGE;
    const v = dragStartValue + frac * (max - min);
    setValue(v, false);
    // Live-transmit while dragging (throttled) for performance-style use -
    // tweaking a sound while it plays on the QY70/QY100 - rather than only
    // sending once on release. Only for knobs that opt in (continuousSend)
    // and only when the rounded value actually changed.
    if (continuousSend && onChange && Math.round(current) !== lastSentValue) {
      const now = performance.now();
      if (now - lastSentAt >= CONTINUOUS_SEND_MS) {
        lastSentAt = now;
        lastSentValue = Math.round(current);
        onChange(current);
      }
    }
  });
  function endDrag() {
    if (dragStartY === null) return;
    dragStartY = null;
    wrap.classList.remove('dragging');
    if (onChange) onChange(current);
  }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  input.addEventListener('change', () => {
    setValue(Number(input.value), true);
  });

  render();

  return { element: wrap, setValue, getValue: () => current };
}

// A binary on/off switch for params that are a hard flag on real hardware
// (e.g. VariMode) rather than a smooth range - same {element, setValue,
// getValue} shape as createKnob so it can drop into the same param row.
export function createToggle({ value, onChange, onInput, resetValue }) {
  let current = value ? 1 : 0;

  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap toggle-wrap';

  const switchLabel = document.createElement('label');
  switchLabel.className = 'toggle-switch';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  const track = document.createElement('span');
  track.className = 'toggle-track';
  switchLabel.appendChild(checkbox);
  switchLabel.appendChild(track);

  const controls = document.createElement('div');
  controls.className = 'knob-controls';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'reset-btn';
  resetBtn.textContent = 'Reset';
  if (resetValue !== undefined && resetValue !== null) {
    resetBtn.title = `Reset to default (${resetValue})`;
    resetBtn.addEventListener('click', () => setValue(resetValue, true));
  } else {
    resetBtn.disabled = true;
  }
  controls.appendChild(resetBtn);

  wrap.appendChild(switchLabel);
  wrap.appendChild(controls);

  function render() {
    checkbox.checked = current === 1;
    if (onInput) onInput(current);
  }

  function setValue(v, fire) {
    current = v ? 1 : 0;
    render();
    if (fire && onChange) onChange(current);
  }

  checkbox.addEventListener('change', () => setValue(checkbox.checked ? 1 : 0, true));

  render();

  return { element: wrap, setValue, getValue: () => current };
}

// A discrete N-way switch (3+ states) for params that pick between named
// modes on real hardware rather than a smooth range - values are the
// index into `labels`. Same {element, setValue, getValue} shape as the
// other widgets so it can drop into the same param row.
export function createMultiToggle({ value, labels, titles, onChange, onInput, resetValue }) {
  let current = Math.min(labels.length - 1, Math.max(0, Math.round(value)));

  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap toggle-wrap';

  const segmented = document.createElement('div');
  segmented.className = 'segmented-control';
  const buttons = labels.map((label, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'segment-btn';
    btn.textContent = label;
    if (titles?.[i]) btn.title = titles[i];
    btn.addEventListener('click', () => setValue(i, true));
    segmented.appendChild(btn);
    return btn;
  });

  const controls = document.createElement('div');
  controls.className = 'knob-controls';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'reset-btn';
  resetBtn.textContent = 'Reset';
  if (resetValue !== undefined && resetValue !== null) {
    resetBtn.title = `Reset to default (${resetValue})`;
    resetBtn.addEventListener('click', () => setValue(resetValue, true));
  } else {
    resetBtn.disabled = true;
  }
  controls.appendChild(resetBtn);

  wrap.appendChild(segmented);
  wrap.appendChild(controls);

  function render() {
    buttons.forEach((btn, i) => btn.classList.toggle('active', i === current));
    if (onInput) onInput(current);
  }

  function setValue(v, fire) {
    current = Math.min(labels.length - 1, Math.max(0, Math.round(v)));
    render();
    if (fire && onChange) onChange(current);
  }

  render();

  return { element: wrap, setValue, getValue: () => current };
}
