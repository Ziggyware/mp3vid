import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { captionAtTime, clamp, formatTime } from './audio.js';

// Six artworks that cycle with transitions. The order differs per preset so
// the same track does not always open on the same picture.
export const BACKGROUNDS = [
  '/backgrounds/bg-01-aurora.jpg',
  '/backgrounds/bg-02-chrome.jpg',
  '/backgrounds/bg-03-sunburst.jpg',
  '/backgrounds/bg-04-prism.jpg',
  '/backgrounds/bg-05-nebula.jpg',
];
const SEQUENCE = [0, 3, 1, 4, 2];
const SEQUENCE_OFFSET = { aurora: 0, tide: 2, mono: 4 };
const SEGMENT_BEATS = 8; // two bars per artwork
const TRANSITION_KINDS = 6;

const vertexShader = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShader = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif
  varying vec2 v_uv;
  uniform sampler2D u_a;
  uniform sampler2D u_b;
  uniform float u_iaA;
  uniform float u_iaB;
  uniform float u_ca;
  uniform float u_time;
  uniform float u_p;
  uniform float u_kind;
  uniform float u_seed;
  uniform float u_zoomA;
  uniform float u_zoomB;
  uniform vec2 u_panA;
  uniform vec2 u_panB;
  uniform float u_bass;
  uniform float u_flash;
  uniform float u_style;
  const float PI = 3.14159265;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Cover-fit the image to the canvas, then apply Ken Burns zoom and pan.
  vec2 imageUV(vec2 uv, float zoom, vec2 pan, float imageAspect) {
    vec2 scale = vec2(1.0);
    if (imageAspect > u_ca) scale.x = u_ca / imageAspect;
    else scale.y = imageAspect / u_ca;
    vec2 local = (uv - 0.5) / zoom + 0.5 + pan;
    return (local - 0.5) * scale + 0.5;
  }
  vec3 sampleA(vec2 uv) { return texture2D(u_a, clamp(imageUV(uv, u_zoomA, u_panA, u_iaA), 0.001, 0.999)).rgb; }
  vec3 sampleB(vec2 uv) { return texture2D(u_b, clamp(imageUV(uv, u_zoomB, u_panB, u_iaB), 0.001, 0.999)).rgb; }
  vec3 splitA(vec2 uv, float amount) {
    return vec3(
      texture2D(u_a, clamp(imageUV(uv + vec2(amount, 0.0), u_zoomA, u_panA, u_iaA), 0.001, 0.999)).r,
      texture2D(u_a, clamp(imageUV(uv, u_zoomA, u_panA, u_iaA), 0.001, 0.999)).g,
      texture2D(u_a, clamp(imageUV(uv - vec2(amount, 0.0), u_zoomA, u_panA, u_iaA), 0.001, 0.999)).b);
  }

  void main() {
    vec2 uv = v_uv;
    // Ambient drift keeps still artwork alive; the bass adds a small punch.
    uv.x += sin(uv.y * 14.0 + u_time * 0.55) * 0.0012 * (1.0 + u_bass * 2.0);
    uv.y += cos(uv.x * 10.0 - u_time * 0.38) * 0.0008 * (1.0 + u_bass * 2.0);
    uv = (uv - 0.5) / (1.0 + u_bass * 0.025) + 0.5;
    vec2 c = uv - 0.5;
    float p = u_p;
    vec3 color;

    if (p <= 0.0001) {
      color = sampleA(uv);
    } else if (p >= 0.9999) {
      color = sampleB(uv);
    } else if (u_kind < 0.5) {
      // Liquid dissolve: noise displacement and a noise-threshold reveal.
      float n1 = noise(uv * vec2(3.0, 5.0) + u_seed * 17.0);
      float n2 = noise(uv * vec2(2.2, 3.4) - u_seed * 9.0);
      vec2 disp = vec2(n1 - 0.5, n2 - 0.5) * 0.3 * sin(PI * p);
      float n = noise(uv * 4.0 + u_seed * 3.0);
      float m = smoothstep(n - 0.12, n + 0.12, p * 1.24 - 0.12);
      color = mix(sampleA(uv + disp * p), sampleB(uv - disp * (1.0 - p)), m);
      color += vec3(0.79, 0.97, 0.46) * 0.22 * sin(PI * p) * (1.0 - abs(m * 2.0 - 1.0)) * (0.4 + 0.6 * n);
    } else if (u_kind < 1.5) {
      // Glitch slices: horizontal bands jump and split before switching.
      float row = floor(uv.y * 26.0);
      float r = hash(vec2(row, u_seed * 91.0));
      float shift = (r - 0.5) * 0.26 * sin(PI * p);
      vec3 outgoing = splitA(uv + vec2(shift, 0.0), 0.008 * sin(PI * p));
      vec3 incoming = sampleB(uv + vec2(-shift * 0.6, 0.0));
      float m = step(hash(vec2(row, 7.0 + u_seed)), p);
      color = mix(outgoing, incoming, m);
    } else if (u_kind < 2.5) {
      // Zoom burst: radial blur on the way out, punch-in on the way in.
      float blur = sin(PI * p) * 0.1;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 6; i++) {
        float s = 1.0 + blur * float(i) / 5.0;
        acc += sampleA(c * s + 0.5);
      }
      vec3 outgoing = acc / 6.0;
      vec3 incoming = sampleB(c / (1.4 - 0.4 * p) + 0.5);
      color = mix(outgoing, incoming, smoothstep(0.35, 0.65, p));
    } else if (u_kind < 3.5) {
      // Mosaic: cells pixelate, then flip one by one.
      vec2 cells = vec2(9.0, 16.0);
      vec2 cell = floor(uv * cells);
      vec2 quant = (cell + 0.5) / cells;
      vec2 puv = mix(uv, quant, sin(PI * p) * 0.95);
      float m = step(hash(cell + u_seed * 37.0), p);
      color = mix(sampleA(puv), sampleB(puv), m);
    } else if (u_kind < 4.5) {
      // Diagonal wipe with a lime light edge.
      vec2 dir = normalize(vec2(1.0, 0.65));
      float s = dot(c, dir) + 0.5 + (noise(uv * 5.0 + u_seed) - 0.5) * 0.08;
      float edge = mix(-0.25, 1.3, p);
      float m = 1.0 - step(edge, s);
      color = mix(sampleA(uv), sampleB(uv), m);
      color += vec3(0.79, 0.97, 0.46) * exp(-abs(s - edge) * 45.0) * 0.7;
    } else {
      // Iris: a circle opens from the title area, with a glowing ring.
      vec2 q = vec2(c.x * u_ca, uv.y - 0.42);
      float d = length(q);
      float r = p * 0.95;
      float m = 1.0 - smoothstep(r - 0.012, r + 0.012, d);
      color = mix(sampleA(uv), sampleB(uv), m);
      color += vec3(0.79, 0.97, 0.46) * exp(-abs(d - r) * 60.0) * 0.6;
    }

    color *= 1.0 + u_flash;
    if (u_style > 0.5 && u_style < 1.5) {
      color = vec3(color.r * 0.63 + color.b * 0.10, color.g * 0.95 + color.b * 0.22, color.b * 0.87 + color.r * 0.10);
    } else if (u_style > 1.5) {
      float mono = dot(color, vec3(0.299, 0.587, 0.114));
      color = vec3(mono * 0.93, mono * 0.98, mono * 1.04);
    }
    float glow = (0.02 + u_bass * 0.12) * exp(-distance(v_uv, vec2(0.48, 0.59)) * 3.8);
    color += vec3(0.40, 0.15, 0.65) * glow;
    color += (hash(v_uv * vec2(540.0, 960.0) + u_time) - 0.5) * 0.035;
    float vignette = smoothstep(1.2, 0.22, distance(v_uv, vec2(0.5, 0.55)));
    color *= 0.8 + 0.2 * vignette;
    gl_FragColor = vec4(color, 1.0);
  }
`;

function makeShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new Error('Could not initialize the visualizer shader.');
  }
  return shader;
}

/** Which artwork is shown in a segment, and how the boundary into it transitions. */
export function scheduleAt(time, tempo, preset) {
  const segment = tempo ? tempo.period * SEGMENT_BEATS : 4;
  const origin = tempo ? tempo.offset : 0;
  const raw = (time - origin) / segment;
  const k = Math.floor(raw);
  const local = (raw - k) * segment;
  const wrap = value => ((value % BACKGROUNDS.length) + BACKGROUNDS.length) % BACKGROUNDS.length;
  const imageFor = index => SEQUENCE[wrap(index + (SEQUENCE_OFFSET[preset] ?? 0))];
  const hash = Math.abs(Math.sin(k * 12.9898 + 78.233) * 43758.5453) % 1;
  return {
    k,
    local,
    segment,
    transitionLength: Math.min(0.7, segment * 0.22),
    imageA: imageFor(k - 1),
    imageB: imageFor(k),
    kind: Math.floor(hash * TRANSITION_KINDS) % TRANSITION_KINDS,
    seed: hash,
  };
}

/** Creates the WebGL renderer, or returns null so the 2D fallback can run. */
function createVisualizer(width, height) {
  const surface = document.createElement('canvas');
  surface.width = width;
  surface.height = height;
  const images = BACKGROUNDS.map(src => {
    const image = new Image();
    image.src = src;
    return { image, texture: null, ready: false };
  });
  const gl = surface.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return { surface, images, webgl: false };
  try {
    const program = gl.createProgram();
    gl.attachShader(program, makeShader(gl, gl.VERTEX_SHADER, vertexShader));
    gl.attachShader(program, makeShader(gl, gl.FRAGMENT_SHADER, fragmentShader));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Could not link shader');
    gl.useProgram(program);
    const vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // A dark placeholder keeps the first frames valid before artwork loads.
    const placeholder = new Uint8Array([5, 6, 18, 255]);
    images.forEach(item => {
      item.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, item.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, placeholder);
      item.image.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, item.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, item.image);
        item.ready = true;
      };
    });
    const uniform = name => gl.getUniformLocation(program, name);
    const locations = {
      a: uniform('u_a'), b: uniform('u_b'), iaA: uniform('u_iaA'), iaB: uniform('u_iaB'), ca: uniform('u_ca'),
      time: uniform('u_time'), p: uniform('u_p'), kind: uniform('u_kind'), seed: uniform('u_seed'),
      zoomA: uniform('u_zoomA'), zoomB: uniform('u_zoomB'), panA: uniform('u_panA'), panB: uniform('u_panB'),
      bass: uniform('u_bass'), flash: uniform('u_flash'), style: uniform('u_style'),
    };
    gl.uniform1i(locations.a, 0);
    gl.uniform1i(locations.b, 1);
    gl.uniform1f(locations.ca, width / height);
    gl.viewport(0, 0, width, height);
    return {
      surface,
      images,
      webgl: true,
      draw(frame) {
        const { schedule: s, time, bass, flash, style } = frame;
        const a = images[s.imageA];
        const b = images[s.imageB];
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, a.texture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, b.texture);
        gl.uniform1f(locations.iaA, BACKGROUND_ASPECT[s.imageA]);
        gl.uniform1f(locations.iaB, BACKGROUND_ASPECT[s.imageB]);
        gl.uniform1f(locations.time, time);
        gl.uniform1f(locations.p, frame.progress);
        gl.uniform1f(locations.kind, s.kind);
        gl.uniform1f(locations.seed, s.seed);
        gl.uniform1f(locations.zoomA, frame.zoomA);
        gl.uniform1f(locations.zoomB, frame.zoomB);
        gl.uniform2f(locations.panA, frame.panA[0], frame.panA[1]);
        gl.uniform2f(locations.panB, frame.panB[0], frame.panB[1]);
        gl.uniform1f(locations.bass, bass);
        gl.uniform1f(locations.flash, flash);
        gl.uniform1f(locations.style, style);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return a.ready || b.ready;
      },
    };
  } catch {
    return { surface, images, webgl: false };
  }
}

// Aspect ratios (width / height) of the artworks, used for cover-fitting in the shader.
const BACKGROUND_ASPECT = [941 / 1672, 941 / 1672, 941 / 1672, 941 / 1672, 941 / 1672, 768 / 1376];

function coverRect(image, width, height, zoom, pan) {
  const iw = image.naturalWidth || 941;
  const ih = image.naturalHeight || 1672;
  const scale = Math.max(width / iw, height / ih) * zoom;
  const dw = iw * scale;
  const dh = ih * scale;
  return [(width - dw) / 2 + pan[0] * width, (height - dh) / 2 + pan[1] * height, dw, dh];
}

function wrapText(ctx, text, maxWidth) {
  const result = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        result.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) result.push(line);
  }
  return result.slice(0, 4);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

const PreviewCanvas = forwardRef(function PreviewCanvas(props, ref) {
  const canvasRef = useRef(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  useImperativeHandle(ref, () => canvasRef.current, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: false });
    const width = canvas.width;
    const height = canvas.height;
    const visualizer = createVisualizer(width, height);
    let frame;
    let smoothBass = 0;
    let lastDraw = 0;
    const started = performance.now();
    const frequencies = new Uint8Array(128);
    // Gradients depend only on the fixed canvas size, so build them once
    // instead of recreating them on every animation frame.
    const topShade = ctx.createLinearGradient(0, 0, 0, height * 0.24);
    topShade.addColorStop(0, 'rgba(4,5,18,.66)');
    topShade.addColorStop(1, 'rgba(4,5,18,0)');
    const bottomShade = ctx.createLinearGradient(0, height * 0.53, 0, height);
    bottomShade.addColorStop(0, 'rgba(3,4,16,0)');
    bottomShade.addColorStop(0.5, 'rgba(3,4,16,.37)');
    bottomShade.addColorStop(1, 'rgba(3,4,16,.85)');

    // The audio clock is smoother than timeupdate, so read it directly while playing.
    function trackTime(p) {
      const audio = p.audioRef?.current;
      if (p.isPlaying && audio && !audio.paused) return audio.currentTime;
      return p.timeRef?.current ?? p.hookStart ?? 0;
    }

    // When paused, only redraw if something visible changed. This keeps the
    // preview static (and the CPU/GPU idle) instead of animating at 30 fps
    // forever, which can make low-powered machines feel frozen on load.
    let lastSignature = '';
    function previewSignature(p) {
      const t = trackTime(p);
      const captionText = (p.captions || []).map(caption => caption.text).join('|');
      const tempoKey = p.tempo ? `${p.tempo.bpm}|${p.tempo.offset}` : '';
      const imagesKey = visualizer.images.map(item => (item.image.complete && item.image.naturalWidth ? 1 : 0)).join('');
      return [Math.round(t * 10), p.preset, tempoKey, p.trackName || '', p.hookStart, p.clipLength, p.captionEnabled ? 1 : 0, captionText, (p.waveform || []).length, imagesKey].join('::');
    }

    function drawFrame(now) {
      const p = propsRef.current;
      const analyser = p.analyserRef?.current;
      if (analyser) {
        if (frequencies.length !== analyser.frequencyBinCount) {
          // The configured analyser has 128 bins; a defensive fallback is below.
          const data = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(data);
          frequencies.set(data.subarray(0, frequencies.length));
        } else analyser.getByteFrequencyData(frequencies);
      } else frequencies.fill(0);
      let bassSum = 0;
      for (let i = 1; i < 9; i++) bassSum += frequencies[i];
      const bassValue = bassSum / (8 * 255);
      smoothBass += (bassValue - smoothBass) * 0.16;

      const current = trackTime(p);
      const schedule = scheduleAt(current, p.tempo, p.preset);
      const progress = schedule.local < schedule.transitionLength ? smoothstep(0, schedule.transitionLength, schedule.local) : 1;
      const burst = schedule.local < 0.5 ? Math.exp(-schedule.local * 6) * 0.12 : 0;
      const beat = p.tempo ? ((current - p.tempo.offset) % p.tempo.period + p.tempo.period) % p.tempo.period : 1;
      const beatFlash = p.tempo ? Math.exp(-beat * 14) * 0.035 : 0;
      const direction = schedule.k % 2 ? 1 : -1;
      const ken = schedule.local / schedule.segment;
      const previousDirection = -direction;
      const frameState = {
        schedule,
        // Wall-clock drift while playing; audio time when paused so the
        // static frame is stable instead of jumping on every redraw.
        time: p.isPlaying ? (now - started) / 1000 : current,
        bass: smoothBass,
        flash: burst + beatFlash,
        style: p.preset === 'tide' ? 1 : p.preset === 'mono' ? 2 : 0,
        progress,
        zoomA: 1 + 0.06 * (1 + ken),
        zoomB: 1 + 0.06 * ken,
        panA: [previousDirection * 0.012 * (1 + ken), 0.004 * (1 + ken)],
        panB: [direction * 0.012 * ken, -0.004 * ken],
      };

      ctx.fillStyle = '#060819';
      ctx.fillRect(0, 0, width, height);
      if (visualizer.webgl) {
        if (visualizer.draw(frameState)) ctx.drawImage(visualizer.surface, 0, 0, width, height);
      } else {
        // Without WebGL, cross-fade between artworks with the same Ken Burns motion.
        const a = visualizer.images[schedule.imageA].image;
        const b = visualizer.images[schedule.imageB].image;
        ctx.save();
        if (p.preset === 'mono') ctx.filter = 'grayscale(1)';
        if (p.preset === 'tide') ctx.filter = 'hue-rotate(45deg)';
        if (progress < 1 && a.complete && a.naturalWidth) {
          ctx.globalAlpha = 1 - progress;
          ctx.drawImage(a, ...coverRect(a, width, height, frameState.zoomA, frameState.panA));
        }
        if (b.complete && b.naturalWidth) {
          ctx.globalAlpha = progress;
          ctx.drawImage(b, ...coverRect(b, width, height, frameState.zoomB, frameState.panB));
        }
        ctx.restore();
      }

      // Safe-area shading keeps text legible while the artwork moves underneath.
      ctx.fillStyle = topShade;
      ctx.fillRect(0, 0, width, height * 0.24);
      ctx.fillStyle = bottomShade;
      ctx.fillRect(0, height * 0.53, width, height * 0.47);

      // Track metadata at the top of the video.
      const pad = width * 0.085;
      ctx.fillStyle = '#c9f774';
      const iconX = pad;
      const iconY = height * 0.065;
      for (let i = 0; i < 4; i++) {
        const barHeight = [12, 23, 17, 27][i];
        ctx.fillRect(iconX + i * 7, iconY + (27 - barHeight), 3.5, barHeight);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.font = `700 ${Math.round(width * 0.024)}px "Space Grotesk", sans-serif`;
      const name = (p.trackName || 'YOUR TRACK').replace(/\.mp3$/i, '').toUpperCase();
      ctx.fillText(name.length > 22 ? `${name.slice(0, 20)}…` : name, pad + 43, iconY + 11);
      ctx.fillStyle = 'rgba(255,255,255,.50)';
      ctx.font = `500 ${Math.round(width * 0.018)}px "DM Sans", sans-serif`;
      ctx.fillText('ORIGINAL AUDIO', pad + 43, iconY + 31);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,.62)';
      ctx.font = `600 ${Math.round(width * 0.020)}px "DM Sans", sans-serif`;
      ctx.fillText('SOUND ON  ↗', width - pad, iconY + 16);

      const text = p.captionEnabled ? captionAtTime(p.captions || [], current) : '';
      if (text) {
        ctx.textAlign = 'left';
        ctx.font = `700 ${Math.round(width * 0.096)}px "Space Grotesk", sans-serif`;
        const lines = wrapText(ctx, text.toUpperCase(), width * 0.83);
        const lineHeight = width * 0.108;
        // Longer captions grow upward instead of colliding with the spectrum.
        const firstBaseline = Math.min(height * 0.743, height * 0.85 - (lines.length - 1) * lineHeight);
        ctx.fillStyle = '#c9f774';
        ctx.font = `700 ${Math.round(width * 0.019)}px "DM Sans", sans-serif`;
        ctx.fillText('THE MOMENT', pad, Math.min(height * 0.685, firstBaseline - width * 0.11));
        ctx.font = `700 ${Math.round(width * 0.096)}px "Space Grotesk", sans-serif`;
        lines.forEach((line, index) => {
          ctx.fillStyle = index === lines.length - 1 ? '#c9f774' : '#ffffff';
          ctx.fillText(line, pad, firstBaseline + index * lineHeight, width * 0.83);
        });
      }

      // A little spectrum line is driven by both the decoded waveform and live audio.
      const clipLength = p.clipLength || 1;
      const progressInClip = clamp((current - p.hookStart) / clipLength, 0, 1);
      const barCount = 58;
      const waveWidth = width - pad * 2;
      const gap = waveWidth / barCount;
      const waveY = height * 0.895;
      for (let i = 0; i < barCount; i++) {
        const wave = p.waveform?.[Math.floor(i / barCount * (p.waveform?.length || 1))] || 0.2;
        const frequency = frequencies[Math.min(frequencies.length - 1, i + 3)] / 255;
        const barHeight = 5 + wave * 18 + frequency * 28;
        ctx.fillStyle = i / barCount <= progressInClip ? '#c9f774' : 'rgba(255,255,255,.42)';
        ctx.fillRect(pad + i * gap, waveY - barHeight / 2, Math.max(2, gap * 0.44), barHeight);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,.65)';
      ctx.font = `600 ${Math.round(width * 0.019)}px "DM Sans", sans-serif`;
      ctx.fillText(`${formatTime(Math.max(0, current - p.hookStart))} / ${formatTime(p.clipLength)}`, pad, height * 0.939);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,.48)';
      ctx.fillText('MADE TO BE FELT', width - pad, height * 0.939);
    }

    function render(now) {
      const p = propsRef.current;
      if (!p.isPlaying) {
        const signature = previewSignature(p);
        if (signature !== lastSignature) {
          lastSignature = signature;
          drawFrame(now);
        }
        frame = requestAnimationFrame(render);
        return;
      }
      lastSignature = '';
      // The recorder captures at 30 fps; avoid drawing twice as often on 60 Hz screens.
      if (now - lastDraw < 1000 / 30) {
        frame = requestAnimationFrame(render);
        return;
      }
      lastDraw = now;
      drawFrame(now);
      frame = requestAnimationFrame(render);
    }
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvasRef} width="540" height="960" className="video-canvas" aria-label="Live vertical video preview" />;
});

export default PreviewCanvas;
