/** Audio helpers are independent of React so the selection logic can be tested. */

export const FRAME_SECONDS = 0.01;
const PEAKS_PER_SECOND = 200;
const SECTION_WINDOW_FRAMES = 200; // two seconds on each side of a boundary

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** m:ss.t, used by the timeline ruler and cursor readout where tenths matter. */
export function formatPrecise(value) {
  const tenths = Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 10);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor(tenths / 10) % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

/** Sample the decoded audio into a waveform and a quarter-second energy envelope. */
export function analyzeAudio(buffer, barCount = 144) {
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const duration = buffer.duration;
  const channels = Array.from({ length: Math.min(buffer.numberOfChannels, 2) }, (_, i) => buffer.getChannelData(i));
  const binSize = Math.max(1, Math.floor(sampleRate * 0.25));
  // 8 kHz is plenty for an amplitude envelope and keeps long tracks responsive.
  const stride = Math.max(1, Math.floor(sampleRate / 8000));
  const envelope = [];
  const peaks = [];
  for (let offset = 0; offset < length; offset += binSize) {
    const end = Math.min(length, offset + binSize);
    let squareSum = 0;
    let peak = 0;
    let count = 0;
    for (let i = offset; i < end; i += stride) {
      let power = 0;
      for (const channel of channels) {
        const sample = channel[i] || 0;
        power += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      // Compute energy per channel instead of mixing them: out-of-phase
      // stereo should not be mistaken for silence.
      squareSum += power / (channels.length || 1);
      count++;
    }
    envelope.push(count ? Math.sqrt(squareSum / count) : 0);
    peaks.push(peak);
  }
  const waveform = Array.from({ length: barCount }, (_, index) => {
    const first = Math.floor(index * envelope.length / barCount);
    const last = Math.max(first + 1, Math.ceil((index + 1) * envelope.length / barCount));
    let level = 0;
    for (let i = first; i < Math.min(last, envelope.length); i++) {
      level = Math.max(level, envelope[i] * 0.72 + peaks[i] * 0.28);
    }
    return level;
  });
  const sorted = [...waveform].sort((a, b) => a - b);
  const normalizer = sorted[Math.floor(sorted.length * 0.95)] || 1;
  return {
    duration,
    step: binSize / sampleRate,
    envelope,
    waveform: waveform.map(value => clamp(Math.sqrt(value / normalizer), 0.08, 1)),
  };
}

/**
 * Score every possible clip start for sustained energy and changes in energy.
 * Returns one value per quarter-second start position, normalized to 0–1 so the
 * timeline can draw the hook curve. This is a transparent heuristic, not a claim
 * of hit prediction.
 */
export function scoreWindows(analysis, clipLength) {
  const empty = { step: analysis?.step || 0.25, values: new Float32Array(0), best: 0 };
  if (!analysis?.envelope?.length || !Number.isFinite(analysis.duration) || !Number.isFinite(clipLength) || clipLength <= 0) return empty;
  const { envelope, step, duration } = analysis;
  if (!Number.isFinite(step) || step <= 0 || duration <= clipLength) return { ...empty, values: new Float32Array(envelope.length) };
  const windowSize = Math.max(1, Math.round(clipLength / step));
  // Prefix sums make scoring long tracks linear instead of rescanning each window.
  const energyPrefix = new Float64Array(envelope.length + 1);
  const dynamicsPrefix = new Float64Array(envelope.length + 1);
  for (let i = 0; i < envelope.length; i++) {
    energyPrefix[i + 1] = energyPrefix[i] + envelope[i];
    dynamicsPrefix[i + 1] = dynamicsPrefix[i] + (i ? Math.abs(envelope[i] - envelope[i - 1]) : 0);
  }
  const scores = new Float32Array(envelope.length);
  let bestScore = -Infinity;
  let bestIndex = 0;
  // Stay away from the very beginning/end where intros and fades often occur.
  const edge = duration > clipLength + 2 ? Math.round(0.5 / step) : 0;
  const maxStart = Math.max(0, envelope.length - windowSize);
  for (let start = edge; start <= Math.max(edge, maxStart - edge) && start < envelope.length; start++) {
    const end = Math.min(envelope.length, start + windowSize);
    const energy = energyPrefix[end] - energyPrefix[start];
    const dynamics = dynamicsPrefix[end] - dynamicsPrefix[Math.min(start + 1, end)];
    const score = energy / windowSize + 0.35 * dynamics / windowSize;
    scores[start] = score;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = start;
    }
  }
  let peak = 0;
  for (const value of scores) peak = Math.max(peak, value);
  const values = scores.map(value => (peak > 0 ? value / peak : 0));
  return {
    step,
    values,
    best: Math.round(clamp(bestIndex * step, 0, duration - clipLength) * 10) / 10,
  };
}

export function findBestHook(analysis, clipLength) {
  return scoreWindows(analysis, clipLength).best;
}

/** Full-resolution min/max peaks (about 200 per second) for zoomable drawing. */
export function buildPeaks(buffer, perSecond = PEAKS_PER_SECOND) {
  const { sampleRate, length, duration, numberOfChannels } = buffer;
  const left = buffer.getChannelData(0);
  const right = numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const binSize = Math.max(1, Math.floor(sampleRate / perSecond));
  const bins = Math.ceil(length / binSize);
  const data = new Float32Array(bins * 2);
  for (let bin = 0; bin < bins; bin++) {
    const start = bin * binSize;
    const end = Math.min(length, start + binSize);
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      const mono = (left[i] + right[i]) * 0.5;
      if (mono < min) min = mono;
      if (mono > max) max = mono;
    }
    data[bin * 2] = min;
    data[bin * 2 + 1] = max;
  }
  return { perSecond: sampleRate / binSize, data, bins, duration };
}

/** Average onset strength on a beat grid with the given period (in frames), best phase. */
function bestGridPhase(peakish, frames, period, phaseStep) {
  let best = { score: -Infinity, phase: 0 };
  for (let phase = 0; phase < period; phase += phaseStep) {
    let sum = 0;
    let count = 0;
    for (let p = phase; p < frames - 0.5; p += period) {
      sum += peakish[Math.round(p)];
      count++;
    }
    const score = count ? sum / count : 0;
    if (score > best.score) best = { score, phase };
  }
  return best;
}

/**
 * Estimate tempo and beat phase from the onset envelope. Each candidate tempo is
 * scored by how strongly onsets land on its grid, searched coarse-to-fine. Returns
 * null when the pulse is too weak to trust, so the timeline never draws a
 * misleading grid.
 */
export function estimateTempo(onset) {
  const frames = onset.length;
  if (frames < 400) return null;
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += onset[f];
  mean /= frames;
  if (mean <= 0) return null;
  // A grid hit counts if an onset lands within one frame of it.
  const peakish = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    peakish[f] = Math.max(onset[f], f > 0 ? onset[f - 1] : 0, f + 1 < frames ? onset[f + 1] : 0);
  }
  const periodFrames = bpm => 60 / bpm / FRAME_SECONDS;
  let coarse = { score: -Infinity, bpm: 120, phase: 0 };
  for (let bpm = 72; bpm <= 180; bpm += 0.5) {
    const result = bestGridPhase(peakish, frames, periodFrames(bpm), 1);
    if (result.score > coarse.score) coarse = { ...result, bpm };
  }
  let best = { score: -Infinity, bpm: coarse.bpm, phase: coarse.phase };
  for (let bpm = coarse.bpm - 0.5; bpm <= coarse.bpm + 0.5001; bpm += 0.05) {
    const result = bestGridPhase(peakish, frames, periodFrames(bpm), 0.25);
    if (result.score > best.score) best = { score: result.score, bpm, phase: result.phase };
  }
  const strength = best.score / mean;
  if (!(strength >= 1.5)) return null;
  return { bpm: best.bpm, period: 60 / best.bpm, offset: best.phase * FRAME_SECONDS, strength };
}

/**
 * Per-frame loudness analysis for the timeline: where audio starts and ends,
 * where the beat falls, and where the energy lifts or drops.
 */
export function analyzeTimeline(buffer) {
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const duration = buffer.duration;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frames = Math.max(1, Math.ceil(length / frameSize));
  const rmsDb = new Float32Array(frames);
  const lowDb = new Float32Array(frames);
  // Four cascaded one-pole low-passes near 110 Hz (about 24 dB per octave) isolate
  // the kick. A gentler filter lets melody and hi-hat transients masquerade as beats.
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * 110 / sampleRate);
  const lowStages = new Float64Array(4);
  for (let f = 0; f < frames; f++) {
    const start = f * frameSize;
    const end = Math.min(length, start + frameSize);
    let sum = 0;
    let lowSum = 0;
    for (let i = start; i < end; i++) {
      const mono = (left[i] + right[i]) * 0.5;
      let filtered = mono;
      for (let k = 0; k < 4; k++) {
        lowStages[k] += lowAlpha * (filtered - lowStages[k]);
        filtered = lowStages[k];
      }
      sum += mono * mono;
      lowSum += filtered * filtered;
    }
    const count = Math.max(1, end - start);
    rmsDb[f] = 20 * Math.log10(Math.sqrt(sum / count) + 1e-9);
    lowDb[f] = 20 * Math.log10(Math.sqrt(lowSum / count) + 1e-9);
  }
  let peakDb = -Infinity;
  for (let f = 0; f < frames; f++) peakDb = Math.max(peakDb, rmsDb[f]);
  // Clamp to a floor so digital silence does not create fake transients.
  const floorDb = Math.max(-90, peakDb - 60);
  for (let f = 0; f < frames; f++) {
    rmsDb[f] = Math.max(floorDb, rmsDb[f]);
    lowDb[f] = Math.max(floorDb, lowDb[f]);
  }

  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    onset[f] = Math.max(0, lowDb[f] - lowDb[f - 1]) + 0.5 * Math.max(0, rmsDb[f] - rmsDb[f - 1]);
  }
  const tempo = estimateTempo(onset);
  const beats = [];
  if (tempo) {
    for (let t = tempo.offset; t < duration; t += tempo.period) beats.push(t);
  }

  // Audible region: anything within 40 dB of the loudest moment (and above -60 dBFS).
  const threshold = Math.max(peakDb - 40, -60);
  let firstActive = -1;
  let lastActive = -1;
  for (let f = 0; f < frames; f++) {
    if (rmsDb[f] > threshold) {
      if (firstActive < 0) firstActive = f;
      lastActive = f;
    }
  }
  const audioStart = firstActive < 0 ? 0 : firstActive * FRAME_SECONDS;
  const audioEnd = lastActive < 0 ? duration : Math.min(duration, (lastActive + 1) * FRAME_SECONDS);

  // Section boundaries: compare average loudness two seconds before and after
  // each frame. Boundaries next to silence are the audio start/end, not sections.
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + rmsDb[f];
  const W = SECTION_WINDOW_FRAMES;
  const change = new Float32Array(frames);
  const candidates = [];
  for (let f = W; f + W <= frames; f++) {
    const before = (prefix[f] - prefix[f - W]) / W;
    const after = (prefix[f + W] - prefix[f]) / W;
    if (before < threshold || after < threshold) continue;
    change[f] = after - before;
  }
  for (let f = W; f + W <= frames; f++) {
    const value = change[f];
    if (Math.abs(value) < 2) continue;
    let isPeak = true;
    for (let g = Math.max(0, f - 150); g <= Math.min(frames - 1, f + 150) && isPeak; g++) {
      if (Math.abs(change[g]) > Math.abs(value)) isPeak = false;
    }
    if (isPeak) candidates.push({ frame: f, change: value });
  }
  candidates.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const sections = [];
  for (const candidate of candidates) {
    if (sections.length >= 16) break;
    if (sections.some(item => Math.abs(item.frame - candidate.frame) < 250)) continue;
    sections.push(candidate);
  }
  sections.sort((a, b) => a.frame - b.frame);

  return {
    duration,
    peaks: buildPeaks(buffer),
    audioStart,
    audioEnd,
    tempo,
    beats,
    sections: sections.map(item => ({
      time: item.frame * FRAME_SECONDS,
      change: item.change,
      kind: item.change >= 0 ? 'lift' : 'drop',
    })),
  };
}

export function manualCaptions(text, start, length) {
  const blocks = String(text || '').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  if (!blocks.length || length <= 0) return [];
  return blocks.map((text, index) => ({
    text,
    start: start + index * length / blocks.length,
    end: start + (index + 1) * length / blocks.length,
  }));
}

export function captionAtTime(captions, time) {
  return captions.find((caption, index) => {
    const nextStart = captions[index + 1]?.start ?? Infinity;
    return time >= caption.start && time < Math.min(caption.end + 0.35, nextStart);
  })?.text || '';
}
