import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { captionAtTime, clamp, formatTime } from './audio.js';

const vertexShader = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;
const fragmentShader = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_image;
  uniform float u_time;
  uniform float u_bass;
  uniform float u_style;
  void main() {
    vec2 uv = v_uv;
    float motion = 0.0015 + u_bass * 0.008;
    uv.x += sin(uv.y * 14.0 + u_time * 0.55) * motion;
    uv.y += cos(uv.x * 10.0 - u_time * 0.38) * motion * 0.6;
    vec3 color = texture2D(u_image, clamp(uv, 0.001, 0.999)).rgb;
    float glow = (0.025 + u_bass * 0.13) * exp(-distance(v_uv, vec2(0.48, 0.59)) * 3.8);
    color += vec3(0.40, 0.15, 0.65) * glow;
    if (u_style > 0.5 && u_style < 1.5) {
      color = vec3(color.r * 0.63 + color.b * 0.10, color.g * 0.95 + color.b * 0.22, color.b * 0.87 + color.r * 0.10);
    } else if (u_style > 1.5) {
      float mono = dot(color, vec3(0.299, 0.587, 0.114));
      color = vec3(mono * 0.93, mono * 0.98, mono * 1.04);
    }
    float vignette = smoothstep(1.2, 0.22, distance(v_uv, vec2(0.5, 0.55)));
    color *= 0.82 + 0.18 * vignette;
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

function createVisualizer(width, height) {
  const surface = document.createElement('canvas');
  surface.width = width;
  surface.height = height;
  const image = new Image();
  image.src = '/visualizer-art.png';
  let imageReady = false;
  const gl = surface.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) {
    image.onload = () => { imageReady = true; };
    return { surface, image, draw: () => imageReady, webgl: false };
  }
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
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([5, 6, 18, 255]));
    image.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      imageReady = true;
    };
    const time = gl.getUniformLocation(program, 'u_time');
    const bass = gl.getUniformLocation(program, 'u_bass');
    const style = gl.getUniformLocation(program, 'u_style');
    gl.viewport(0, 0, width, height);
    return {
      surface,
      image,
      webgl: true,
      draw(seconds, energy, preset) {
        gl.useProgram(program);
        gl.uniform1f(time, seconds);
        gl.uniform1f(bass, energy);
        gl.uniform1f(style, preset === 'tide' ? 1 : preset === 'mono' ? 2 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return imageReady;
      },
    };
  } catch {
    image.onload = () => { imageReady = true; };
    return { surface, image, draw: () => imageReady, webgl: false };
  }
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
    const started = performance.now();
    let lastDraw = 0;
    const frequencies = new Uint8Array(128);

    function render(now) {
      // The recorder captures at 30 fps; avoid drawing twice as often on 60 Hz screens.
      if (now - lastDraw < 1000 / 30) {
        frame = requestAnimationFrame(render);
        return;
      }
      lastDraw = now;
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
      const bassValue = Array.from(frequencies.slice(1, 9)).reduce((sum, x) => sum + x, 0) / (8 * 255);
      smoothBass += (bassValue - smoothBass) * 0.16;
      const ready = visualizer.draw((now - started) / 1000, smoothBass, p.preset);
      ctx.fillStyle = '#060819';
      ctx.fillRect(0, 0, width, height);
      if (visualizer.webgl) ctx.drawImage(visualizer.surface, 0, 0, width, height);
      else if (ready) {
        ctx.save();
        if (p.preset === 'mono') ctx.filter = 'grayscale(1)';
        if (p.preset === 'tide') ctx.filter = 'hue-rotate(45deg)';
        ctx.drawImage(visualizer.image, 0, 0, width, height);
        ctx.restore();
      }

      // Safe-area shading keeps text legible while the shader moves underneath.
      const topShade = ctx.createLinearGradient(0, 0, 0, height * 0.24);
      topShade.addColorStop(0, 'rgba(4,5,18,.66)');
      topShade.addColorStop(1, 'rgba(4,5,18,0)');
      ctx.fillStyle = topShade;
      ctx.fillRect(0, 0, width, height * 0.24);
      const bottomShade = ctx.createLinearGradient(0, height * 0.53, 0, height);
      bottomShade.addColorStop(0, 'rgba(3,4,16,0)');
      bottomShade.addColorStop(0.5, 'rgba(3,4,16,.37)');
      bottomShade.addColorStop(1, 'rgba(3,4,16,.85)');
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

      const current = p.timeRef?.current ?? p.hookStart ?? 0;
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
        ctx.fillText(p.captionSource === 'whisper' ? 'THE LYRICS' : 'THE MOMENT', pad, Math.min(height * 0.685, firstBaseline - width * 0.11));
        ctx.font = `700 ${Math.round(width * 0.096)}px "Space Grotesk", sans-serif`;
        lines.forEach((line, index) => {
          ctx.fillStyle = index === lines.length - 1 ? '#c9f774' : '#ffffff';
          ctx.fillText(line, pad, firstBaseline + index * lineHeight, width * 0.83);
        });
      }

      // A little spectrum line is driven by both the decoded waveform and live audio.
      const progress = clamp((current - p.hookStart) / (p.clipLength || 1), 0, 1);
      const barCount = 58;
      const waveWidth = width - pad * 2;
      const gap = waveWidth / barCount;
      const waveY = height * 0.895;
      for (let i = 0; i < barCount; i++) {
        const wave = p.waveform?.[Math.floor(i / barCount * (p.waveform?.length || 1))] || 0.2;
        const frequency = frequencies[Math.min(frequencies.length - 1, i + 3)] / 255;
        const barHeight = 5 + wave * 18 + frequency * 28;
        ctx.fillStyle = i / barCount <= progress ? '#c9f774' : 'rgba(255,255,255,.42)';
        ctx.fillRect(pad + i * gap, waveY - barHeight / 2, Math.max(2, gap * 0.44), barHeight);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,.65)';
      ctx.font = `600 ${Math.round(width * 0.019)}px "DM Sans", sans-serif`;
      ctx.fillText(`${formatTime(Math.max(0, current - p.hookStart))} / ${formatTime(p.clipLength)}`, pad, height * 0.939);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,.48)';
      ctx.fillText('MADE TO BE FELT', width - pad, height * 0.939);
      frame = requestAnimationFrame(render);
    }
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvasRef} width="540" height="960" className="video-canvas" aria-label="Live vertical video preview" />;
});

export default PreviewCanvas;
