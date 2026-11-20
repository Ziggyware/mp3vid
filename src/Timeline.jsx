import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { clamp, formatPrecise, formatTime } from './audio.js';

// Lane heights in CSS pixels.
const RULER_H = 26;
const SECTION_H = 30;
const WAVE_H = 150;
const HOOK_H = 58;
const LANE_H = RULER_H + SECTION_H + WAVE_H + HOOK_H;
const OVERVIEW_H = 40;
const MAX_ZOOM = 360; // pixels per second
const SNAP_PIXELS = 9;
const LIME = '#c9f774';
const LIFT = '#c9f774';
const DROP = '#ff9ec7';
const GREY = '#4b4f58';
const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/** Times the clip can snap to: audio edges, section changes, and bar lines. */
function landmarksFor(timeline) {
  if (!timeline) return [];
  const list = [];
  if (timeline.audioStart > 0) list.push(timeline.audioStart);
  if (timeline.audioEnd < timeline.duration) list.push(timeline.audioEnd);
  for (const section of timeline.sections) list.push(section.time);
  if (timeline.tempo) timeline.beats.forEach((time, index) => { if (index % 4 === 0) list.push(time); });
  return list.sort((a, b) => a - b);
}

function nearest(sorted, time) {
  if (!sorted.length) return null;
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < time) low = middle + 1;
    else high = middle;
  }
  const candidates = [sorted[low], sorted[low - 1]].filter(value => value !== undefined);
  return candidates.reduce((best, value) => (Math.abs(value - time) < Math.abs(best - time) ? value : best));
}

function prepareCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Draws min/max peaks for one pixel column range, with a square-root display curve. */
function drawPeakColumns(ctx, peaks, { width, toTime, top, height, isSelected }) {
  const mid = top + height / 2;
  const amp = height / 2 - 10;
  const perSecond = peaks.perSecond;
  const bins = peaks.bins;
  for (let x = 0; x < width; x++) {
    const t0 = toTime(x);
    const t1 = toTime(x + 1);
    let i0 = Math.floor(t0 * perSecond);
    let i1 = Math.max(i0 + 1, Math.ceil(t1 * perSecond));
    i0 = clamp(i0, 0, bins - 1);
    i1 = clamp(i1, i0 + 1, bins);
    let min = 0;
    let max = 0;
    for (let i = i0; i < i1; i++) {
      const low = peaks.data[i * 2];
      const high = peaks.data[i * 2 + 1];
      if (low < min) min = low;
      if (high > max) max = high;
    }
    const upper = mid - Math.sqrt(max) * amp;
    const lower = mid + Math.sqrt(-min) * amp;
    ctx.fillStyle = isSelected(t0) ? LIME : GREY;
    ctx.fillRect(x, upper, 1, Math.max(1, lower - upper));
  }
}

function shadeSilence(ctx, x0, x1, y0, y1) {
  if (x1 <= x0) return;
  ctx.fillStyle = 'rgba(6,7,10,.74)';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth = 1;
  for (let x = x0 - (y1 - y0); x < x1; x += 7) {
    ctx.beginPath();
    ctx.moveTo(x, y1);
    ctx.lineTo(x + (y1 - y0), y0);
    ctx.stroke();
  }
  ctx.restore();
}

function pill(ctx, x, y, text, align, color) {
  ctx.font = '700 9px "Space Grotesk", sans-serif';
  const padding = 5;
  const textWidth = ctx.measureText(text).width;
  const width = textWidth + padding * 2;
  const left = align === 'right' ? x - width : x;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(left, y, width, 15, 3);
  else ctx.rect(left, y, width, 15);
  ctx.fill();
  ctx.fillStyle = '#131a0e';
  ctx.textAlign = 'left';
  ctx.fillText(text, left + padding, y + 11);
}

export default function Timeline({ timeline, hook, duration, start, length, onChange, disabled, empty, audioRef, playing }) {
  const containerRef = useRef(null);
  const mainRef = useRef(null);
  const overviewRef = useRef(null);
  const dragRef = useRef(null);
  const drawRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [mul, setMul] = useState(1);
  const [view, setView] = useState(0);
  const [hover, setHover] = useState(null);
  const [showBeats, setShowBeats] = useState(true);
  const [snapOn, setSnapOn] = useState(true);

  const dur = duration > 0 ? duration : 1;
  const fit = width > 0 ? width / dur : 1;
  const zoom = Math.max(fit, Math.min(MAX_ZOOM, fit * mul));
  const span = width > 0 ? width / zoom : dur;
  const maxView = Math.max(0, dur - span);
  const v = clamp(view, 0, maxView);
  const tempo = timeline?.tempo || null;
  const landmarks = useMemo(() => landmarksFor(timeline), [timeline]);

  // Event handlers read the latest layout here so they never act on stale props.
  const latest = useRef({});
  latest.current = { width, fit, zoom, span, dur, mul, v, maxView, start, length, timeline, onChange, disabled, landmarks, snapOn };

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const update = () => setWidth(Math.floor(element.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new track starts zoomed so the clip and its surroundings are readable.
  useEffect(() => {
    const L = latest.current;
    if (!timeline) return;
    const target = clamp(L.length * 2.4, 20, L.dur);
    const nextMul = clamp(L.dur / target, 1, Math.max(1, MAX_ZOOM / Math.max(1e-6, L.fit)));
    setMul(nextMul);
    setView(clamp(L.start + L.length / 2 - target / 2, 0, Math.max(0, L.dur - target)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline]);

  // Keep the clip on screen when it moves out of view (keyboard, zoom, or a new track).
  useEffect(() => {
    const L = latest.current;
    if (!L.width) return;
    const outside = start < L.v || start + length > L.v + L.span;
    if (outside) setView(clamp(start + length / 2 - L.span / 2, 0, Math.max(0, L.dur - L.span)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, length, width]);

  const zoomAround = (factor, anchorX) => {
    const L = latest.current;
    if (!L.width) return;
    const nextMul = clamp(L.mul * factor, 1, Math.max(1, MAX_ZOOM / L.fit));
    const nextZoom = Math.max(L.fit, Math.min(MAX_ZOOM, L.fit * nextMul));
    const x = anchorX ?? L.width / 2;
    const anchorTime = L.v + x / L.zoom;
    const nextSpan = L.width / nextZoom;
    setMul(nextMul);
    setView(clamp(anchorTime - x / nextZoom, 0, Math.max(0, L.dur - nextSpan)));
  };

  // Wheel zoom needs a non-passive listener so the page does not scroll while zooming.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const onWheel = event => {
      const L = latest.current;
      if (!L.width || !L.timeline) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        zoomAround(event.deltaY < 0 ? 1.2 : 1 / 1.2, event.clientX - rect.left);
      } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
        event.preventDefault();
        const delta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY;
        setView(clamp(L.v + delta / L.zoom, 0, L.maxView));
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draw = () => {
    const canvas = mainRef.current;
    if (!canvas || !width) return;
    const ctx = prepareCanvas(canvas, width, LANE_H);
    const yWave = RULER_H + SECTION_H;
    const yHook = yWave + WAVE_H;
    const bottom = yHook + HOOK_H;
    const timeToX = time => (time - v) * zoom;
    const toTime = x => v + x / zoom;
    const selectionEnd = start + length;

    ctx.fillStyle = '#0d0f13';
    ctx.fillRect(0, 0, width, LANE_H);
    if (!timeline) {
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.font = '600 11px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(empty ? 'Choose a track to see its map' : 'Analyzing your track…', width / 2, LANE_H / 2);
      drawOverview();
      return;
    }

    // Silence before the first audible frame and after the last one.
    const audioInX = timeToX(timeline.audioStart);
    const audioOutX = timeToX(timeline.audioEnd);
    shadeSilence(ctx, 0, Math.min(width, audioInX), yWave, bottom);
    shadeSilence(ctx, Math.max(0, audioOutX), width, yWave, bottom);

    // Beat grid: every beat is faint, bar lines are brighter and numbered.
    if (showBeats && tempo && tempo.period * zoom >= 4) {
      const { period, offset } = tempo;
      const firstBeat = Math.max(0, Math.floor((v - offset) / period));
      const lastBeat = Math.ceil((v + span - offset) / period);
      for (let k = firstBeat; k <= lastBeat; k++) {
        const time = offset + k * period;
        if (time < 0 || time > dur) continue;
        const x = Math.round(timeToX(time)) + 0.5;
        const isBar = k % 4 === 0;
        ctx.strokeStyle = isBar ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.065)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, bottom);
        ctx.stroke();
        if (isBar && period * 4 * zoom >= 56) {
          ctx.fillStyle = 'rgba(255,255,255,.42)';
          ctx.font = '700 8px "DM Sans", sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(`BAR ${Math.floor(k / 4) + 1}`, x + 3, RULER_H - 9);
        }
      }
    }

    // Full-resolution waveform. Lime columns are inside the chosen clip.
    drawPeakColumns(ctx, timeline.peaks, {
      width,
      toTime,
      top: yWave,
      height: WAVE_H,
      isSelected: time => time >= start && time < selectionEnd,
    });

    // Section changes run through the waveform and hook curve as dashed guides.
    for (const section of timeline.sections) {
      const x = Math.round(timeToX(section.time)) + 0.5;
      if (x < 0 || x > width) continue;
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = section.kind === 'lift' ? 'rgba(201,247,116,.5)' : 'rgba(255,158,199,.5)';
      ctx.beginPath();
      ctx.moveTo(x, yWave);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The chosen clip.
    const selectionX0 = timeToX(start);
    const selectionX1 = timeToX(selectionEnd);
    ctx.fillStyle = 'rgba(201,247,116,.07)';
    ctx.fillRect(Math.max(0, selectionX0), RULER_H, Math.min(width, selectionX1) - Math.max(0, selectionX0), bottom - RULER_H);
    ctx.fillStyle = LIME;
    if (selectionX0 >= -2 && selectionX0 <= width + 2) ctx.fillRect(selectionX0 - 1, RULER_H, 2, bottom - RULER_H);
    if (selectionX1 >= -2 && selectionX1 <= width + 2) ctx.fillRect(selectionX1 - 1, RULER_H, 2, bottom - RULER_H);

    // Section lane: audio in/out and the loudness changes.
    ctx.fillStyle = 'rgba(255,255,255,.025)';
    ctx.fillRect(0, RULER_H, width, SECTION_H);
    // Section labels must not run into the audio in/out labels, so reserve their extents.
    const reserved = [];
    ctx.font = '700 8px "DM Sans", sans-serif';
    if (audioInX > 0 && audioInX < width) {
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.textAlign = 'left';
      const inLabel = `AUDIO IN ${formatPrecise(timeline.audioStart)}`;
      ctx.fillText(inLabel, audioInX + 5, RULER_H + 13);
      reserved.push([audioInX + 5, audioInX + 9 + ctx.measureText(inLabel).width]);
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.fillRect(Math.round(audioInX), RULER_H, 1, bottom - RULER_H);
    }
    if (audioOutX > 0 && audioOutX < width) {
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.textAlign = 'right';
      const outLabel = `AUDIO OUT ${formatPrecise(timeline.audioEnd)}`;
      ctx.fillText(outLabel, audioOutX - 5, RULER_H + 13);
      reserved.push([audioOutX - 9 - ctx.measureText(outLabel).width, audioOutX - 5]);
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.fillRect(Math.round(audioOutX), RULER_H, 1, bottom - RULER_H);
    }
    let lastLabelEnd = -Infinity;
    ctx.textAlign = 'left';
    for (const section of timeline.sections) {
      const x = timeToX(section.time);
      if (x < 0 || x > width) continue;
      const color = section.kind === 'lift' ? LIFT : DROP;
      const label = `${section.kind === 'lift' ? '▲ LIFT' : '▼ DROP'} ${formatTime(section.time)}`;
      const labelWidth = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 4, yWave - 4);
      ctx.lineTo(x + 4, yWave - 4);
      ctx.lineTo(x, yWave);
      ctx.fill();
      if (x - lastLabelEnd < 6) continue;
      const labelLeft = x + 6;
      const labelRight = labelLeft + labelWidth;
      if (reserved.some(([a, b]) => labelLeft < b + 4 && labelRight > a - 4)) continue;
      ctx.fillText(label, labelLeft, RULER_H + 19);
      lastLabelEnd = labelRight;
    }

    // Hook curve: how strong a clip starting at each point would be.
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, yHook, width, HOOK_H);
    if (hook?.values?.length) {
      const { values, step } = hook;
      const baseline = bottom - 4;
      const height = baseline - (yHook + 16);
      const ys = new Float32Array(width + 1);
      for (let x = 0; x <= width; x++) {
        const index = Math.round(toTime(x) / step);
        ys[x] = baseline - (index >= 0 && index < values.length ? values[index] : 0) * height;
      }
      ctx.beginPath();
      ctx.moveTo(0, baseline);
      for (let x = 0; x <= width; x++) ctx.lineTo(x, ys[x]);
      ctx.lineTo(width, baseline);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, yHook, 0, baseline);
      gradient.addColorStop(0, 'rgba(201,247,116,.34)');
      gradient.addColorStop(1, 'rgba(201,247,116,.02)');
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.beginPath();
      for (let x = 0; x <= width; x++) (x ? ctx.lineTo(x, ys[x]) : ctx.moveTo(x, ys[x]));
      ctx.strokeStyle = 'rgba(201,247,116,.85)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.42)';
      ctx.font = '700 8px "DM Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('HOOK SCORE', 6, yHook + 11);
      const bestX = timeToX(hook.best);
      if (bestX >= 0 && bestX <= width) {
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,.65)';
        ctx.beginPath();
        ctx.moveTo(Math.round(bestX) + 0.5, yHook);
        ctx.lineTo(Math.round(bestX) + 0.5, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        pill(ctx, bestX + 4, yHook + 3, 'BEST START', 'left', 'rgba(255,255,255,.85)');
      }
      const startIndex = Math.round(start / step);
      const startValue = startIndex >= 0 && startIndex < values.length ? values[startIndex] : 0;
      if (selectionX0 >= 0 && selectionX0 <= width) {
        ctx.fillStyle = LIME;
        ctx.beginPath();
        ctx.arc(selectionX0, baseline - startValue * height, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Ruler with adaptive tick spacing.
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, width, RULER_H);
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fillRect(0, RULER_H - 1, width, 1);
    const step = RULER_STEPS.find(value => value * zoom >= 72) || RULER_STEPS[RULER_STEPS.length - 1];
    ctx.font = '600 9px "DM Sans", sans-serif';
    ctx.textAlign = 'left';
    for (let time = Math.ceil(v / step) * step; time <= v + span + 1e-9; time += step) {
      const x = Math.round(timeToX(time)) + 0.5;
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.fillText(step < 1 ? formatPrecise(time) : formatTime(time), x + 4, 11);
    }
    pill(ctx, Math.max(2, selectionX0 + 3), 4, formatPrecise(start), 'left', LIME);
    pill(ctx, Math.min(width - 2, selectionX1 - 3), 4, formatPrecise(selectionEnd), 'right', LIME);

    // Hover cursor and playhead.
    if (hover != null) {
      const x = Math.round(timeToX(hover)) + 0.5;
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const audio = audioRef?.current;
    const playheadTime = audio?.src ? audio.currentTime : start;
    const playheadX = timeToX(playheadTime);
    if (playheadX >= 0 && playheadX <= width) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(playheadX) - 1, RULER_H, 2, bottom - RULER_H);
      ctx.beginPath();
      ctx.moveTo(playheadX - 4, 0);
      ctx.lineTo(playheadX + 4, 0);
      ctx.lineTo(playheadX, 6);
      ctx.fill();
    }
    drawOverview();
  };

  const drawOverview = () => {
    const canvas = overviewRef.current;
    if (!canvas || !width || !timeline) return;
    const ctx = prepareCanvas(canvas, width, OVERVIEW_H);
    ctx.fillStyle = '#0d0f13';
    ctx.fillRect(0, 0, width, OVERVIEW_H);
    const perPixel = dur / width;
    drawPeakColumns(ctx, timeline.peaks, {
      width,
      toTime: x => x * perPixel,
      top: 0,
      height: OVERVIEW_H,
      isSelected: time => time >= start && time < start + length,
    });
    ctx.fillStyle = 'rgba(201,247,116,.14)';
    ctx.fillRect(start / dur * width, 0, length / dur * width, OVERVIEW_H);
    for (const section of timeline.sections) {
      ctx.fillStyle = section.kind === 'lift' ? LIFT : DROP;
      ctx.fillRect(Math.round(section.time / dur * width), 0, 1, 5);
    }
    const viewX0 = v / dur * width;
    const viewX1 = (v + span) / dur * width;
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.fillRect(viewX0, 0, viewX1 - viewX0, OVERVIEW_H);
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(viewX0 + 0.5, 0.5, Math.max(1, viewX1 - viewX0 - 1), OVERVIEW_H - 1);
  };

  drawRef.current = draw;
  useEffect(() => {
    drawRef.current?.();
  });

  // Keep the playhead moving smoothly while the clip plays.
  useEffect(() => {
    if (!playing) return undefined;
    let frame;
    const tick = () => {
      drawRef.current?.();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const pointIn = (event, element) => {
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const snapStart = (next) => {
    const L = latest.current;
    const tolerance = SNAP_PIXELS / L.zoom;
    let shift = null;
    const near = nearest(L.landmarks, next);
    if (near !== null && Math.abs(near - next) <= tolerance) shift = near - next;
    const nearEnd = nearest(L.landmarks, next + L.length);
    if (nearEnd !== null && Math.abs(nearEnd - (next + L.length)) <= tolerance) {
      const candidate = nearEnd - L.length - next;
      if (shift === null || Math.abs(candidate) < Math.abs(shift)) shift = candidate;
    }
    return shift === null ? next : clamp(next + shift, 0, Math.max(0, L.dur - L.length));
  };

  const onMainDown = event => {
    const L = latest.current;
    if (disabled || !timeline) return;
    const { x, y } = pointIn(event, event.currentTarget);
    const time = L.v + x / L.zoom;
    const yWave = RULER_H + SECTION_H;
    if (y < RULER_H || event.shiftKey) {
      dragRef.current = { mode: 'pan', x0: event.clientX, v0: L.v };
    } else if (y < yWave) {
      // Section lane: a click jumps the clip to that change.
      let target = null;
      for (const section of timeline.sections) {
        const distance = Math.abs((section.time - L.v) * L.zoom - x);
        if (distance <= 10 && (!target || distance < target.distance)) target = { time: section.time, distance };
      }
      if (target) onChange(clamp(target.time, 0, Math.max(0, L.dur - L.length)));
      return;
    } else if (time >= L.start && time <= L.start + L.length) {
      dragRef.current = { mode: 'select', offset: time - L.start };
    } else {
      onChange(clamp(time - L.length / 2, 0, Math.max(0, L.dur - L.length)));
      dragRef.current = { mode: 'select', offset: L.length / 2 };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onMainMove = event => {
    const L = latest.current;
    const { x, y } = pointIn(event, event.currentTarget);
    const time = L.v + x / L.zoom;
    const drag = dragRef.current;
    if (drag?.mode === 'select') {
      let next = clamp(time - drag.offset, 0, Math.max(0, L.dur - L.length));
      if (L.snapOn) next = snapStart(next);
      L.onChange(next);
    } else if (drag?.mode === 'pan') {
      setView(clamp(drag.v0 - (event.clientX - drag.x0) / L.zoom, 0, L.maxView));
    }
    setHover(y >= 0 && L.timeline ? time : null);
  };

  const endDrag = event => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onOverviewDown = event => {
    const L = latest.current;
    if (!timeline) return;
    const { x } = pointIn(event, event.currentTarget);
    const time = x / L.width * L.dur;
    const inside = time >= L.v && time <= L.v + L.span;
    dragRef.current = { mode: 'overview', offset: inside ? time - L.v : L.span / 2 };
    if (!inside) setView(clamp(time - L.span / 2, 0, L.maxView));
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onOverviewMove = event => {
    const drag = dragRef.current;
    if (drag?.mode !== 'overview') return;
    const L = latest.current;
    const { x } = pointIn(event, event.currentTarget);
    setView(clamp(x / L.width * L.dur - drag.offset, 0, L.maxView));
  };

  const onKeyDown = event => {
    const L = latest.current;
    if (disabled || !timeline) return;
    const step = event.shiftKey ? 0.1 : 1;
    const max = Math.max(0, L.dur - L.length);
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onChange(clamp(L.start + step, 0, max)); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onChange(clamp(L.start - step, 0, max)); }
    else if (event.key === 'Home') { event.preventDefault(); onChange(0); }
    else if (event.key === 'End') { event.preventDefault(); onChange(max); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAround(1.25); }
    else if (event.key === '-') { event.preventDefault(); zoomAround(0.8); }
    else if (event.key === '0') { event.preventDefault(); setMul(1); setView(0); }
  };

  const describe = time => {
    const parts = [formatPrecise(time)];
    if (tempo && time >= tempo.offset) {
      const beat = Math.floor((time - tempo.offset) / tempo.period);
      parts.push(`bar ${Math.floor(beat / 4) + 1}, beat ${beat % 4 + 1}`);
    }
    const section = timeline.sections.find(item => Math.abs(item.time - time) <= 0.6);
    if (section) parts.push(`${section.kind === 'lift' ? 'lift' : 'drop'} ${section.change >= 0 ? '+' : '−'}${Math.abs(section.change).toFixed(1)} dB`);
    if (time < timeline.audioStart) parts.push('silence before the audio starts');
    else if (time > timeline.audioEnd) parts.push('silence after the audio ends');
    if (time >= start && time <= start + length) parts.push('inside your clip');
    return parts.join(' · ');
  };

  const readout = !timeline
    ? (empty ? 'Choose a track to see where its sound starts, lifts, and drops.' : 'Analyzing your track…')
    : hover != null ? describe(hover) : 'Drag the lime clip to move it · click a ▲/▼ marker to jump there · scroll with Shift to pan · Ctrl + scroll to zoom';

  return <div className={`timeline-wrap ${disabled ? 'disabled' : ''}`} ref={containerRef}>
    <div className="timeline-toolbar">
      <div className="timeline-toggles">
        {tempo && <button className={`tl-chip ${showBeats ? 'on' : ''}`} onClick={() => setShowBeats(value => !value)} aria-pressed={showBeats}>Beat grid · {Math.round(tempo.bpm)} BPM</button>}
        <button className={`tl-chip ${snapOn ? 'on' : ''}`} onClick={() => setSnapOn(value => !value)} aria-pressed={snapOn}>Snap to landmarks</button>
      </div>
      <div className="timeline-zoom">
        <button className="tl-btn" onClick={() => zoomAround(0.8)} disabled={!timeline || mul <= 1} aria-label="Zoom out"><Minus size={12} /></button>
        <button className="tl-btn text" onClick={() => { setMul(1); setView(0); }} disabled={!timeline} aria-label="Show whole track">Fit</button>
        <button className="tl-btn" onClick={() => zoomAround(1.25)} disabled={!timeline} aria-label="Zoom in"><Plus size={12} /></button>
        <span className="tl-readout">{timeline ? `${formatTime(span)} in view` : ''}</span>
      </div>
    </div>
    <div
      className="timeline-canvas-wrap"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Clip start time"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.floor(dur - length))}
      aria-valuenow={Math.floor(start)}
      aria-valuetext={`${formatPrecise(start)} to ${formatPrecise(start + length)}`}
      onKeyDown={onKeyDown}
    >
      <canvas
        ref={mainRef}
        className="timeline-canvas"
        style={{ width, height: LANE_H }}
        onPointerDown={onMainDown}
        onPointerMove={onMainMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => { if (!dragRef.current) setHover(null); }}
        aria-hidden="true"
      />
    </div>
    <canvas
      ref={overviewRef}
      className="timeline-overview"
      style={{ width, height: OVERVIEW_H }}
      onPointerDown={onOverviewDown}
      onPointerMove={onOverviewMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      aria-hidden="true"
    />
    <div className="timeline-readout-row">
      <span className="cursor-readout">{readout}</span>
    </div>
    <div className="timeline-legend">
      <span><i className="lg-wave" /> Your clip</span>
      <span><i className="lg-silence" /> Silence</span>
      <span><i className="lg-lift" /> Lift</span>
      <span><i className="lg-drop" /> Drop</span>
      <span><i className="lg-hook" /> Hook score</span>
    </div>
  </div>;
}
