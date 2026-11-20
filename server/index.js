import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const app = express();
const httpServer = createServer(app);
let ffmpegPath = process.env.FFMPEG_PATH || '';
if (!ffmpegPath) {
  try {
    ffmpegPath = (await import('@ffmpeg-installer/ffmpeg')).default.path;
  } catch {
    // The package does not ship binaries for every platform. The rest of the
    // studio can still run; users can provide FFMPEG_PATH for MP4 export.
  }
}
const videoUpload = multer({ dest: tmpdir(), limits: { fileSize: 200 * 1024 * 1024, files: 1 } });

let ffmpegAvailable = false;
try {
  await access(ffmpegPath, fsConstants.X_OK);
  ffmpegAvailable = true;
} catch {
  console.warn('FFmpeg is not available; MP4 export is disabled.');
}

app.get('/api/status', (_req, res) => {
  res.json({ mp4ExportAvailable: ffmpegAvailable });
});

function convertToMp4(input, output, duration) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0',
      // Normalize variable-rate captures. Extend the last frame if a slow
      // device drops frames at the end, and stop when the song audio ends.
      // Zero-latency avoids buffering audio while waiting for video frames.
      '-vf', 'scale=1080:1920:flags=lanczos,format=yuv420p,fps=30,tpad=stop_mode=clone:stop_duration=31',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '22',
      '-c:a', 'aac', '-b:a', '192k', '-max_muxing_queue_size', '4096', '-shortest', '-t', String(duration), '-movflags', '+faststart',
      output,
    ]);
    let errorOutput = '';
    process.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
    const timeout = setTimeout(() => { process.kill('SIGKILL'); }, 300_000);
    process.on('error', error => { clearTimeout(timeout); reject(error); });
    process.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(errorOutput || 'FFmpeg could not convert the recording.'));
    });
  });
}

app.post('/api/export', videoUpload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video recording was provided.' });
  const input = req.file.path;
  const output = `${input}.mp4`;
  const cleanUp = () => { void Promise.allSettled([unlink(input), unlink(output)]); };
  if (!ffmpegAvailable) {
    cleanUp();
    return res.status(503).json({ error: 'MP4 conversion is not available on this server.' });
  }
  try {
    const requestedDuration = Number(req.body?.duration);
    const duration = Number.isFinite(requestedDuration) && requestedDuration > 0 && requestedDuration <= 30.5
      ? Math.max(0.1, requestedDuration) : 31;
    await convertToMp4(input, output, duration);
    const name = String(req.body?.filename || 'mp3vid-clip')
      .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'mp3vid-clip';
    res.download(output, `${name}.mp4`, () => cleanUp());
  } catch (error) {
    console.error('MP4 conversion failed:', error.message);
    cleanUp();
    if (!res.headersSent) res.status(500).json({ error: 'Could not convert this recording to MP4. Try again or download the WebM recording.' });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'This recording is too large to convert.'
      : 'There was a problem uploading this file.';
    return res.status(400).json({ error: message });
  }
  next(error);
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve('dist')));
  app.get('*', (_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true, allowedHosts: true, hmr: { server: httpServer } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT) || 3000;
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`mp3vid is listening on http://0.0.0.0:${port}`);
});
