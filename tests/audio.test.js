import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, captionAtTime, findBestHook, formatTime, manualCaptions, wordsToCaptions } from '../src/audio.js';

function makeBuffer(levels, sampleRate = 100) {
  const data = Float32Array.from(levels.flatMap(level => Array(100).fill(level)));
  return { sampleRate, length: data.length, duration: data.length / sampleRate, numberOfChannels: 1, getChannelData: () => data };
}

test('time formatting handles missing and long values', () => {
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(65.9), '1:05');
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

test('Whisper words become time-coded caption phrases', () => {
  const words = [
    { word: 'hello', start: 1, end: 1.2 },
    { word: 'world.', start: 1.3, end: 1.7 },
    { word: 'again', start: 2, end: 2.3 },
  ];
  const captions = wordsToCaptions(words);
  assert.deepEqual(captions.map(x => x.text), ['hello world.', 'again']);
  assert.equal(captionAtTime(captions, 1.4), 'hello world.');
  assert.equal(captionAtTime(captions, 2.1), 'again');
});

test('manual captions divide the selected clip into equal blocks', () => {
  const captions = manualCaptions('first line\nsecond line\n\nlast card', 10, 12);
  assert.deepEqual(captions, [
    { text: 'first line\nsecond line', start: 10, end: 16 },
    { text: 'last card', start: 16, end: 22 },
  ]);
  assert.equal(captionAtTime(captions, 17), 'last card');
});

test('segment-only transcription is split into readable, timed captions', () => {
  const captions = wordsToCaptions([], [{ start: 2, end: 8, text: 'one two three four five six seven eight nine ten' }]);
  assert.deepEqual(captions, [
    { start: 2, end: 5, text: 'one two three four five' },
    { start: 5, end: 8, text: 'six seven eight nine ten' },
  ]);
});

test('out-of-phase stereo still contributes to the energy envelope', () => {
  const left = Float32Array.from({ length: 400 }, () => 0.5);
  const right = Float32Array.from({ length: 400 }, () => -0.5);
  const analysis = analyzeAudio({ sampleRate: 100, length: 400, duration: 4, numberOfChannels: 2, getChannelData: i => i ? right : left });
  assert.ok(analysis.envelope.every(energy => energy > 0.49));
});

test('repeated Whisper word pairs add a modest hook bonus', () => {
  const analysis = { duration: 12, step: 1, envelope: Array(12).fill(0.1) };
  const words = [
    { word: '  Let', start: 6 }, { word: 'go!', start: 6.4 },
    { word: 'Let', start: 7 }, { word: ' go', start: 7.4 },
  ];
  const start = findBestHook(analysis, 3, words);
  assert.ok(start >= 5 && start <= 7, `repeated phrase selected start ${start}`);
});
