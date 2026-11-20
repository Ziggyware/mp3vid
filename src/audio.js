/** Audio helpers are independent of React so the selection logic can be tested. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
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
 * Score every possible window for sustained energy and changes in energy.
 * When Whisper word timings are available, repeated adjacent words give a
 * modest bonus. This is a transparent heuristic, not a claim of hit prediction.
 */
export function findBestHook(analysis, clipLength, words = []) {
  if (!analysis?.envelope?.length || !Number.isFinite(analysis.duration) || !Number.isFinite(clipLength) || clipLength <= 0) return 0;
  const { envelope, step, duration } = analysis;
  if (!Number.isFinite(step) || step <= 0 || duration <= clipLength) return 0;
  const windowSize = Math.max(1, Math.round(clipLength / step));
  const validWords = words.filter(item => Number.isFinite(item.start) && typeof item.word === 'string');
  const pairAt = i => `${validWords[i].word} ${validWords[i + 1].word}`
    .toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim().replace(/\s+/g, ' ');
  const pairs = new Map();
  for (let i = 0; i + 1 < validWords.length; i++) {
    const pair = pairAt(i);
    if (pair) pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  const repeatBins = new Uint32Array(envelope.length);
  for (let i = 0; i + 1 < validWords.length; i++) {
    const bin = Math.floor(validWords[i].start / step);
    if ((pairs.get(pairAt(i)) || 0) > 1 && bin >= 0 && bin < repeatBins.length) repeatBins[bin]++;
  }
  // Prefix sums make scoring long tracks linear instead of scanning every
  // sample and every repeated phrase again for every candidate window.
  const energyPrefix = new Float64Array(envelope.length + 1);
  const dynamicsPrefix = new Float64Array(envelope.length + 1);
  const repeatPrefix = new Uint32Array(envelope.length + 1);
  for (let i = 0; i < envelope.length; i++) {
    energyPrefix[i + 1] = energyPrefix[i] + envelope[i];
    dynamicsPrefix[i + 1] = dynamicsPrefix[i] + (i ? Math.abs(envelope[i] - envelope[i - 1]) : 0);
    repeatPrefix[i + 1] = repeatPrefix[i] + repeatBins[i];
  }
  let bestScore = -Infinity;
  let best = 0;
  // Stay away from the very beginning/end where intros and fades often occur.
  const edge = duration > clipLength + 2 ? Math.round(0.5 / step) : 0;
  const maxStart = Math.max(0, envelope.length - windowSize);
  for (let start = edge; start <= Math.max(edge, maxStart - edge); start++) {
    const end = Math.min(envelope.length, start + windowSize);
    const energy = energyPrefix[end] - energyPrefix[start];
    const dynamics = dynamicsPrefix[end] - dynamicsPrefix[Math.min(start + 1, end)];
    const repeats = repeatPrefix[end] - repeatPrefix[start];
    const score = energy / windowSize + 0.35 * dynamics / windowSize + Math.min(0.025, repeats * 0.0025);
    if (score > bestScore) {
      bestScore = score;
      best = start * step;
    }
  }
  return Math.round(clamp(best, 0, duration - clipLength) * 10) / 10;
}

export function wordsToCaptions(words, fallbackSegments = []) {
  const valid = (words || []).filter(item => typeof item.word === 'string' && Number.isFinite(item.start) && Number.isFinite(item.end));
  if (!valid.length) {
    // Some responses only include segment timings. Split long segments into
    // readable phrases and divide their interval proportionally as a fallback.
    return (fallbackSegments || [])
      .filter(item => typeof item.text === 'string' && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
      .flatMap(item => {
        const tokens = item.text.trim().split(/\s+/).filter(Boolean);
        const result = [];
        for (let i = 0; i < tokens.length; i += 5) {
          const endIndex = Math.min(tokens.length, i + 5);
          result.push({
            start: item.start + (item.end - item.start) * i / tokens.length,
            end: item.start + (item.end - item.start) * endIndex / tokens.length,
            text: tokens.slice(i, endIndex).join(' '),
          });
        }
        return result;
      });
  }
  const captions = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    captions.push({ start: group[0].start, end: group[group.length - 1].end, text: group.map(word => word.word.trim()).join(' ') });
    group = [];
  };
  valid.forEach((word, index) => {
    group.push(word);
    const next = valid[index + 1];
    if (group.length >= 5 || /[.!?]$/.test(word.word.trim()) || !next || next.start - word.end > 0.8) flush();
  });
  return captions;
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
