import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

const execFileAsync = promisify(execFile);
let server;
let base;
let tempDir;

before(async () => {
  // Ask the OS for a free port instead of assuming the developer's port 3000.
  const reservation = createServer();
  await new Promise((resolve, reject) => reservation.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  tempDir = await mkdtemp(join(tmpdir(), 'mp3vid-test-'));
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), OPENAI_API_KEY: '', FFMPEG_PATH: ffmpeg.path },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    server.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('listening')) { clearTimeout(timeout); resolve(); }
    });
    server.stderr.on('data', chunk => { output += chunk; });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${output}`)); });
  });
});

after(async () => {
  if (server && server.exitCode === null) {
    await new Promise(resolve => { server.once('exit', resolve); server.kill('SIGTERM'); });
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('status and Whisper validation work without a configured key', async () => {
  const status = await fetch(`${base}/api/status`);
  assert.deepEqual(await status.json(), { whisperConfigured: false, mp4ExportAvailable: true });
  const missingKey = await fetch(`${base}/api/transcribe`, { method: 'POST' });
  assert.equal(missingKey.status, 401);
  const missingAudio = await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'X-Whisper-Key': 'test-only' } });
  assert.equal(missingAudio.status, 400);
  const form = new FormData();
  form.append('audio', new Blob(['not an mp3']), 'track.wav');
  const wrongType = await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'X-Whisper-Key': 'test-only' }, body: form });
  assert.equal(wrongType.status, 400);
});

test('export converts a captured WebM to an H.264/AAC MP4', { timeout: 30_000 }, async () => {
  const input = join(tempDir, 'short.webm');
  // The audio deliberately outlasts the video, exercising final-frame padding.
  await execFileAsync(ffmpeg.path, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=90x160:d=0.3:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libvpx', '-c:a', 'libvorbis', input,
  ]);
  const form = new FormData();
  form.append('video', new Blob([await readFile(input)], { type: 'video/webm' }), 'capture.webm');
  form.append('filename', 'my clip');
  form.append('duration', '0.5');
  const response = await fetch(`${base}/api/export`, { method: 'POST', body: form });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /video\/mp4/);
  assert.match(response.headers.get('content-disposition'), /my-clip\.mp4/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');
  assert.ok(bytes.length > 1000);
  const output = join(tempDir, 'result.mp4');
  await writeFile(output, bytes);
  // FFmpeg prints stream information to stderr and exits nonzero without an output.
  const probe = await execFileAsync(ffmpeg.path, ['-hide_banner', '-i', output]).then(() => '', error => error.stderr);
  assert.match(probe, /Video: h264.*1080x1920/);
  assert.match(probe, /Audio: aac/);
  const duration = probe.match(/Duration: 00:00:(\d+\.\d+)/);
  assert.ok(duration && Number(duration[1]) >= 0.4 && Number(duration[1]) < 0.7, `unexpected duration: ${duration?.[1]}`);
});
