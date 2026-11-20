import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeAudio, analyzeTimeline, captionAtTime, findBestHook, formatPrecise, formatTime, manualCaptions, scoreWindows,
} from '../src/audio.js';

function makeBuffer(levels, sampleRate = 100) {
  const data = Float32Array.from(levels.flatMap(level => Array(100).fill(level)));
  return { sampleRate, length: data.length, duration: data.length / sampleRate, numberOfChannels: 1, getChannelData: () => data };
}

function makeSignal(sampleRate, seconds, sample) {
  const length = Math.round(sampleRate * seconds);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = sample(i / sampleRate, i);
  return { sampleRate, length, duration: seconds, numberOfChannels: 1, getChannelData: () => data };
}

test('time formatting handles missing and long values', () => {
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatPrecise(65.94), '1:05.9');
});

test('waveform analysis and hook scoring favor the energetic section', () => {
  const analysis = analyzeAudio(makeBuffer([0.02, 0.02, 0.02, 0.02, 0.7, 0.7, 0.7, 0.7, 0.02, 0.02]));
  const hook = findBestHook(analysis, 3);
  assert.ok(hook >= 3.75 && hook <= 5, `hook was ${hook}`);
  assert.equal(analysis.waveform.length, 144);
  assert.ok(analysis.waveform.every(x => x >= 0.08 && x <= 1));
});

test('short tracks select from the beginning', () => {
  assert.equal(findBestHook(analyzeAudio(makeBuffer([0.1, 0.2])), 15), 0);
});

test('hook scores are normalized and agree with the chosen start', () => {
  const analysis = { duration: 12, step: 1, envelope: [0.1, 0.1, 0.2, 0.9, 0.9, 0.9, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1] };
  const { values, best } = scoreWindows(analysis, 3);
  assert.equal(Math.max(...values), 1);
  assert.equal(best, findBestHook(analysis, 3));
  assert.equal(values.length, analysis.envelope.length);
});

test('manual captions divide the selected clip into equal blocks', () => {
  const captions = manualCaptions('first line\nsecond line\n\nlast card', 10, 12);
  assert.deepEqual(captions, [
    { text: 'first line\nsecond line', start: 10, end: 16 },
    { text: 'last card', start: 16, end: 22 },
  ]);
  assert.equal(captionAtTime(captions, 17), 'last card');
});

test('out-of-phase stereo still contributes to the energy envelope', () => {
  const left = Float32Array.from({ length: 400 }, () => 0.5);
  const right = Float32Array.from({ length: 400 }, () => -0.5);
  const analysis = analyzeAudio({ sampleRate: 100, length: 400, duration: 4, numberOfChannels: 2, getChannelData: i => i ? right : left });
  assert.ok(analysis.envelope.every(energy => energy > 0.49));
});

test('timeline finds where audible sound starts and ends', () => {
  const buffer = makeSignal(8000, 10, (t) => (t >= 2 && t < 8 ? 0.3 * Math.sin(2 * Math.PI * 220 * t) : 0));
  const timeline = analyzeTimeline(buffer);
  assert.ok(Math.abs(timeline.audioStart - 2) < 0.05, `start ${timeline.audioStart}`);
  assert.ok(Math.abs(timeline.audioEnd - 8) < 0.05, `end ${timeline.audioEnd}`);
});

test('a steady click track yields its tempo and beat phase', () => {
  // Kicks every 0.5 s (120 BPM), first kick at 0.25 s.
  const buffer = makeSignal(8000, 16, (t) => {
    const local = (t - 0.25) % 0.5;
    const inClick = t >= 0.25 && local >= 0 && local < 0.1;
    return inClick ? 0.8 * Math.sin(2 * Math.PI * 60 * local) * Math.exp(-local / 0.02) : 0;
  });
  const timeline = analyzeTimeline(buffer);
  assert.ok(timeline.tempo, 'tempo should be detected');
  assert.ok(Math.abs(timeline.tempo.bpm - 120) < 2, `bpm was ${timeline.tempo.bpm}`);
  const phaseError = Math.abs(((timeline.tempo.offset - 0.25) % 0.5 + 0.75) % 0.5 - 0.25);
  assert.ok(Math.min(phaseError, 0.5 - phaseError) < 0.03, `phase ${timeline.tempo.offset}`);
  assert.ok(timeline.beats.length >= 28, `beats ${timeline.beats.length}`);
});

test('silence does not invent a beat grid', () => {
  const timeline = analyzeTimeline(makeSignal(8000, 8, () => 0));
  assert.equal(timeline.tempo, null);
  assert.deepEqual(timeline.beats, []);
});

test('a sudden loudness lift is reported as a section boundary', () => {
  const buffer = makeSignal(8000, 12, (t) => (t < 6 ? 0.1 : 0.6) * Math.sin(2 * Math.PI * 440 * t));
  const { sections } = analyzeTimeline(buffer);
  const lift = sections.find(item => item.kind === 'lift');
  assert.ok(lift, 'expected a lift');
  assert.ok(Math.abs(lift.time - 6) < 0.3, `lift at ${lift.time}`);
});
