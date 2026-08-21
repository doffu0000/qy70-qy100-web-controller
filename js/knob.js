// A minimal rotary knob control: drag vertically to change the value,
// or type directly into the field below it. No external dependencies -
// plain SVG + pointer events.

const SWEEP_DEG = 270; // total rotation range, -135deg..+135deg
const START_DEG = -135;
const DRAG_PIXELS_FOR_FULL_RANGE = 160;

function valueToAngle(value, min, max) {
  const frac = max === min ? 0 : (value - min) / (max - min);
  return START_DEG + frac * SWEEP_DEG;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function createKnob({ min, max, value, step = 1, onChange }) {
  let current = clamp(value, min, max);

  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap';

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

  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.className = 'knob-value';

  wrap.appendChild(svg);
  wrap.appendChild(input);

  function render() {
    const angle = valueToAngle(current, min, max);
    indicator.setAttribute('transform', `rotate(${angle} 20 20)`);
    input.value = String(Math.round(current));
  }

  function setValue(v, fire) {
    current = clamp(v, min, max);
    render();
    if (fire && onChange) onChange(current);
  }

  let dragStartY = null;
  let dragStartValue = null;

  svg.addEventListener('pointerdown', (e) => {
    dragStartY = e.clientY;
    dragStartValue = current;
    svg.setPointerCapture(e.pointerId);
    wrap.classList.add('dragging');
  });
  svg.addEventListener('pointermove', (e) => {
    if (dragStartY === null) return;
    const dy = dragStartY - e.clientY;
    const frac = dy / DRAG_PIXELS_FOR_FULL_RANGE;
    const v = dragStartValue + frac * (max - min);
    setValue(v, false);
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
