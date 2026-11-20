import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, AudioLines, Check, ChevronRight,
  CircleHelp, Clapperboard, FileAudio, Maximize2,
  Music2, Pause, Play, Plus, RotateCcw, Sparkles, Upload, Volume2, X,
} from 'lucide-react';
import PreviewCanvas from './PreviewCanvas.jsx';
import Timeline from './Timeline.jsx';
import { analyzeAudio, analyzeTimeline, clamp, findBestHook, formatTime, manualCaptions, scoreWindows } from './audio.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const DEMO_CAPTION = 'FEEL THE\nFREQUENCY';
const INITIAL_WAVE = Array.from({ length: 144 }, (_, i) => {
  const swell = 0.35 + 0.4 * Math.abs(Math.sin(i * 0.095));
  return clamp(swell * (0.5 + 0.5 * Math.abs(Math.sin(i * 1.71))), 0.12, 1);
});
const INITIAL_TRACK = { name: 'Midnight Motion.mp3', src: '/midnight-motion.mp3', duration: 32, isDemo: true, file: null, size: 513000 };
const PRESETS = [
  { id: 'aurora', name: 'Aurora', description: 'Dreamy & electric', number: '01' },
  { id: 'tide', name: 'Tide', description: 'Cool & fluid', number: '02' },
  { id: 'mono', name: 'Mono', description: 'Minimal & moody', number: '03' },
];

function Logo() {
  return <div className="brand" aria-label="mp3vid home">
    <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
    <span className="brand-name">mp3vid<span>.</span></span>
  </div>;
}

function Sidebar({ onHow, onNavigate, hasTrack }) {
  return <aside className="sidebar">
    <div className="sidebar-brand"><Logo /><span className="brand-label">CREATOR STUDIO</span></div>
    <div className="side-section-label">WORKSPACE</div>
    <nav className="side-nav" aria-label="Workspace">
      <button className="side-link active" onClick={() => onNavigate('top')}><Clapperboard size={17} /><span>Video studio</span><span className="side-link-dot" /></button>
      <button className="side-link" onClick={onHow}><CircleHelp size={17} /><span>How it works</span><ArrowUpRight size={14} className="side-link-arrow" /></button>
    </nav>
    <div className="side-section-label workflow-label">YOUR WORKFLOW</div>
    <div className="workflow-nav">
      <button onClick={() => onNavigate('track-section')}><span className="workflow-num">01</span><span>Add your track</span>{hasTrack ? <Check size={13} /> : <ChevronRight size={13} />}</button>
      <button onClick={() => onNavigate('hook-section')}><span className="workflow-num">02</span><span>Find your hook</span><ChevronRight size={13} /></button>
      <button onClick={() => onNavigate('style-section')}><span className="workflow-num">03</span><span>Make it yours</span><ChevronRight size={13} /></button>
      <button onClick={() => onNavigate('preview-section')}><span className="workflow-num">04</span><span>Export & share</span><ChevronRight size={13} /></button>
    </div>
    <div className="sidebar-spacer" />
    <div className="sidebar-note">
      <div className="note-sparkle">✳</div>
      <div className="note-title">Good music<br />deserves to be seen.</div>
      <p>Make a little noise on every feed.</p>
      <div className="note-bottom">MADE FOR SHARING <ArrowUpRight size={12} /></div>
    </div>
    <div className="sidebar-footer"><span className="footer-icon"><AudioLines size={16} /></span><span><strong>mp3vid studio</strong><small>Made for music people</small></span><span className="footer-status" /></div>
  </aside>;
}

function SectionHeading({ step, eyebrow, title, description, children }) {
  return <div className="section-heading">
    <span className="section-number">{step}</span>
    <div className="section-title-wrap"><div className="section-eyebrow">{eyebrow}</div><h2>{title}</h2>{description && <p>{description}</p>}</div>
    {children && <div className="section-heading-right">{children}</div>}
  </div>;
}

function Modal({ children, onClose, label }) {
  useEffect(() => {
    const keyDown = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', keyDown);
    return () => document.removeEventListener('keydown', keyDown);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" role="dialog" aria-modal="true" aria-label={label} onMouseDown={event => event.stopPropagation()}>{children}</div></div>;
}

function App() {
  const [track, setTrack] = useState(INITIAL_TRACK);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(true);
  const [hookStart, setHookStart] = useState(8);
  const [clipLength, setClipLength] = useState(15);
  const [preset, setPreset] = useState('aurora');
  const [captionEnabled, setCaptionEnabled] = useState(true);
  const [manualText, setManualText] = useState(DEMO_CAPTION);
  const [apiStatus, setApiStatus] = useState({ mp4ExportAvailable: true });
  const [timeline, setTimeline] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(8);
  const [draggingFile, setDraggingFile] = useState(false);
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');
  const [exportState, setExportState] = useState({ phase: 'idle', message: '' });
  const [download, setDownload] = useState(null);
  const audioRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const analyserRef = useRef(null);
  const graphRef = useRef(null);
  const timeRef = useRef(8);
  const objectUrlRef = useRef(null);
  const loadIdRef = useRef(0);
  const recorderRef = useRef(null);
  const finishRecordingRef = useRef(null);
  const downloadRef = useRef(null);
  downloadRef.current = download;

  const actualLength = Math.min(clipLength, track?.duration || clipLength);
  const waveform = analysis?.waveform || INITIAL_WAVE;
  const captions = useMemo(() => manualCaptions(manualText, hookStart, actualLength), [manualText, hookStart, actualLength]);
  const hookCurve = useMemo(() => scoreWindows(analysis, actualLength), [analysis, actualLength]);
  const busy = ['preparing', 'recording', 'encoding'].includes(exportState.phase);

  const scrollTo = id => {
    if (id === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
    else document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const updateTime = value => {
    timeRef.current = value;
    setCurrentTime(value);
  };

  const loadTrack = useCallback(async (file, isDemo = false) => {
    if (!file) return;
    if (!/\.mp3$/i.test(file.name)) { setError('Please choose an MP3 file.'); return; }
    if (file.size > MAX_FILE_SIZE) { setError('That file is over 25 MB. Please choose a smaller MP3.'); return; }
    const requestId = ++loadIdRef.current;
    audioRef.current?.pause();
    setIsPlaying(false);
    setError('');
    setAnalyzing(true);
    setAnalysis(null);
    setTimeline(null);
    setClipLength(15);
    setHookStart(0);
    updateTime(0);
    setManualText(isDemo ? DEMO_CAPTION : '');
    setCaptionEnabled(true);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const src = isDemo ? '/midnight-motion.mp3' : URL.createObjectURL(file);
    objectUrlRef.current = isDemo ? null : src;
    setTrack({ name: file.name, src, duration: 0, isDemo, file, size: file.size });
    try {
      const bytes = await file.arrayBuffer();
      const Decoder = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const decoder = Decoder ? new Decoder(1, 1, 44100) : new (window.AudioContext || window.webkitAudioContext)();
      const buffer = await decoder.decodeAudioData(bytes.slice(0));
      if (decoder.close) await decoder.close().catch(() => {});
      if (requestId !== loadIdRef.current) return;
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error('This MP3 does not contain playable audio.');
      if (buffer.duration < 1) throw new Error('Please choose an MP3 that is at least one second long.');
      const nextAnalysis = analyzeAudio(buffer);
      const nextTimeline = analyzeTimeline(buffer);
      const length = Math.min(15, buffer.duration);
      const nextStart = findBestHook(nextAnalysis, length);
      setAnalysis(nextAnalysis);
      setTimeline(nextTimeline);
      setTrack(current => current?.src === src ? { ...current, duration: buffer.duration } : current);
      setHookStart(nextStart);
      updateTime(nextStart);
      setAnalyzing(false);
    } catch (err) {
      if (requestId !== loadIdRef.current) return;
      if (!isDemo && objectUrlRef.current === src) {
        URL.revokeObjectURL(src);
        objectUrlRef.current = null;
      }
      setAnalyzing(false);
      setTrack(null);
      setError(err.message || 'We could not read that MP3. Please try another file.');
    }
  }, []);

  useEffect(() => {
    const initialLoadId = loadIdRef.current;
    fetch('/api/status').then(response => response.json()).then(setApiStatus).catch(() => setApiStatus({ mp4ExportAvailable: false }));
    fetch('/midnight-motion.mp3').then(response => {
      if (!response.ok) throw new Error('Demo unavailable');
      return response.blob();
    }).then(blob => {
      // Don't replace a track the user picked while the demo was downloading.
      if (loadIdRef.current === initialLoadId) return loadTrack(new File([blob], 'Midnight Motion.mp3', { type: 'audio/mpeg' }), true);
    }).catch(() => {
      if (loadIdRef.current === initialLoadId) {
        setAnalyzing(false);
        setTrack(null);
        setError('The demo could not be loaded. You can upload an MP3 instead.');
      }
    });
    return () => {
      loadIdRef.current++;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      if (downloadRef.current?.url) URL.revokeObjectURL(downloadRef.current.url);
      if (graphRef.current?.context) void graphRef.current.context.close().catch(() => {});
    };
  }, [loadTrack]);

  useEffect(() => {
    if (audioRef.current && track?.duration) {
      try { audioRef.current.currentTime = hookStart; } catch { /* metadata may still be loading */ }
    }
    updateTime(hookStart);
  }, [hookStart, track?.src, track?.duration]);

  // A rendered file is a snapshot; any subsequent edit makes that snapshot stale.
  useEffect(() => {
    setDownload(previous => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return null;
    });
    setExportState(previous => previous.phase === 'done' || previous.phase === 'error' ? { phase: 'idle', message: '' } : previous);
  }, [track?.src, hookStart, clipLength, preset, captionEnabled, manualText]);

  const ensureAudioGraph = async () => {
    if (!audioRef.current) throw new Error('Choose a track first.');
    if (!graphRef.current) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('Your browser does not support the Web Audio API.');
      const context = new Context();
      const source = context.createMediaElementSource(audioRef.current);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      const destination = context.createMediaStreamDestination();
      source.connect(analyser);
      analyser.connect(context.destination);
      analyser.connect(destination);
      graphRef.current = { context, source, analyser, destination };
      analyserRef.current = analyser;
    }
    if (graphRef.current.context.state === 'suspended') await graphRef.current.context.resume();
    return graphRef.current;
  };

  const togglePlayback = async () => {
    if (!track || analyzing || busy) return;
    const audio = audioRef.current;
    try {
      if (!audio.paused) { audio.pause(); setIsPlaying(false); return; }
      await ensureAudioGraph();
      if (audio.currentTime < hookStart || audio.currentTime >= hookStart + actualLength - 0.05) audio.currentTime = hookStart;
      await audio.play();
      setIsPlaying(true);
    } catch { setError('Could not play this track. Please try again in a supported browser.'); }
  };

  const finishRecording = () => {
    const active = recorderRef.current;
    if (!active || active.finished) return;
    active.finished = true;
    clearTimeout(active.timeout);
    // Let the canvas encoder flush its last frames after the audio stops. The
    // server trims this short tail back to the exact selected clip length.
    const stop = () => { if (active.recorder.state !== 'inactive') active.recorder.stop(); };
    if (active.aborted) stop();
    else active.tailTimeout = setTimeout(stop, 600);
  };
  finishRecordingRef.current = finishRecording;

  const onAudioTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    updateTime(audio.currentTime);
    if (audio.currentTime >= hookStart + actualLength - 0.035) {
      audio.pause();
      setIsPlaying(false);
      finishRecordingRef.current?.();
    }
  };

  const setSelection = next => {
    if (!track || busy) return;
    audioRef.current?.pause();
    setIsPlaying(false);
    setHookStart(Math.round(clamp(next, 0, Math.max(0, track.duration - actualLength)) * 10) / 10);
  };

  const setLength = next => {
    if (!track || busy || (next === 30 && track.duration < 30)) return;
    audioRef.current?.pause();
    setIsPlaying(false);
    setClipLength(next);
    const length = Math.min(next, track.duration);
    setHookStart(analysis ? findBestHook(analysis, length) : clamp(hookStart, 0, Math.max(0, track.duration - length)));
  };

  const resetProject = () => {
    if (busy) return;
    ++loadIdRef.current;
    audioRef.current?.pause();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    setTrack(null);
    setAnalysis(null);
    setTimeline(null);
    setAnalyzing(false);
    setHookStart(0);
    setClipLength(15);
    updateTime(0);
    setIsPlaying(false);
    setPreset('aurora');
    setManualText('');
    setCaptionEnabled(true);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const loadDemo = async event => {
    event?.stopPropagation();
    try {
      const blob = await (await fetch('/midnight-motion.mp3')).blob();
      await loadTrack(new File([blob], 'Midnight Motion.mp3', { type: 'audio/mpeg' }), true);
    } catch { setError('The demo track could not be loaded. Please upload an MP3 instead.'); }
  };

  const seekWithinClip = event => {
    if (!track || busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const time = hookStart + clamp((event.clientX - rect.left) / rect.width, 0, 1) * actualLength;
    try { audioRef.current.currentTime = time; updateTime(time); } catch { /* still loading */ }
  };

  const exportVideo = async () => {
    if (!track || analyzing || busy) return;
    const canvas = canvasRef.current;
    if (!canvas?.captureStream || !window.MediaRecorder) {
      setError('Video recording is not supported in this browser. Try a current version of Chrome or Edge.');
      return;
    }
    setError('');
    if (download?.url) URL.revokeObjectURL(download.url);
    setDownload(null);
    setExportState({ phase: 'preparing', message: 'Getting your clip ready…' });
    let canvasStream;
    let active;
    try {
      const graph = await ensureAudioGraph();
      const audio = audioRef.current;
      audio.pause();
      setIsPlaying(false);
      // Wait for the seek before starting the recorder, so the selected audio and picture line up.
      if (Math.abs(audio.currentTime - hookStart) > 0.02) {
        await new Promise(resolve => {
          let timer;
          const done = () => { clearTimeout(timer); audio.removeEventListener('seeked', done); resolve(); };
          audio.addEventListener('seeked', done, { once: true });
          timer = setTimeout(done, 1500);
          audio.currentTime = hookStart;
        });
      }
      updateTime(hookStart);
      canvasStream = canvas.captureStream(30);
      const stream = new MediaStream([...canvasStream.getVideoTracks(), ...graph.destination.stream.getAudioTracks()]);
      // VP8 is lighter to encode in real time and broadly supported by Chromium.
      const supported = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported?.(type));
      const recorder = new MediaRecorder(stream, supported ? { mimeType: supported, videoBitsPerSecond: 6_000_000 } : { videoBitsPerSecond: 6_000_000 });
      active = { recorder, finished: false, aborted: false, timeout: null, tailTimeout: null };
      recorderRef.current = active;
      const chunks = [];
      const filename = `${track.name.replace(/\.mp3$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'my-track'}-mp3vid`;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        active.aborted = true;
        clearTimeout(active.timeout);
        clearTimeout(active.tailTimeout);
        audio.pause();
        setIsPlaying(false);
        setExportState({ phase: 'error', message: 'Recording failed. Please try again.' });
      };
      recorder.onstop = async () => {
        canvasStream.getVideoTracks().forEach(item => item.stop());
        if (recorderRef.current === active) recorderRef.current = null;
        if (active.aborted) return;
        const recorded = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
        if (!recorded.size) { setExportState({ phase: 'error', message: 'The recording was empty. Please try again.' }); return; }
        const originalIsMp4 = recorded.type.startsWith('video/mp4');
        setExportState({ phase: 'encoding', message: 'Finishing your MP4…' });
        try {
          const form = new FormData();
          form.append('video', recorded, originalIsMp4 ? 'recording.mp4' : 'recording.webm');
          form.append('filename', filename);
          form.append('duration', String(actualLength));
          const response = await fetch('/api/export', { method: 'POST', body: form });
          if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.error || 'MP4 conversion failed.');
          }
          const blob = await response.blob();
          setDownload({ url: URL.createObjectURL(blob), filename: `${filename}.mp4`, format: 'MP4' });
          setExportState({ phase: 'done', message: 'Your video is ready to share.' });
        } catch (err) {
          const extension = originalIsMp4 ? 'mp4' : 'webm';
          setDownload({ url: URL.createObjectURL(recorded), filename: `${filename}.${extension}`, format: originalIsMp4 ? 'original MP4' : 'WebM' });
          setExportState({ phase: 'error', message: `${err.message} You can download the original recording below.` });
        }
      };
      setExportState({ phase: 'recording', message: 'Recording in real time. Keep this tab open.' });
      recorder.start(250);
      // Prime the canvas stream even when the browser delays its first scheduled frame.
      canvasStream.getVideoTracks()[0]?.requestFrame?.();
      // Safety net if the browser misses the final timeupdate event.
      active.timeout = setTimeout(() => { audio.pause(); setIsPlaying(false); finishRecordingRef.current?.(); }, (actualLength + 3) * 1000);
      await audio.play();
      if (!active.finished) setIsPlaying(true);
    } catch (err) {
      if (active) {
        active.aborted = true;
        clearTimeout(active.timeout);
        clearTimeout(active.tailTimeout);
        if (active.recorder.state !== 'inactive') {
          active.finished = false;
          finishRecordingRef.current?.();
        }
        else {
          canvasStream?.getVideoTracks().forEach(item => item.stop());
          if (recorderRef.current === active) recorderRef.current = null;
        }
      } else canvasStream?.getVideoTracks().forEach(item => item.stop());
      setExportState({ phase: 'error', message: err.message || 'Could not start recording. Please try again.' });
    }
  };

  const relativeTime = clamp(currentTime - hookStart, 0, actualLength);
  const progress = actualLength ? relativeTime / actualLength : 0;

  return <div className="app-shell" id="top">
    <Sidebar onHow={() => setModal('how')} onNavigate={scrollTo} hasTrack={Boolean(track)} />
    <div className="main-area">
      <header className="topbar">
        <div className="mobile-brand"><Logo /></div>
        <div className="breadcrumb"><span>WORKSPACE</span><ChevronRight size={13} /><strong>CREATE VIDEO</strong></div>
        <div className="topbar-right"><span className="workspace-status"><i /> {track?.isDemo ? 'Demo project' : 'Your workspace'}</span><span className="topbar-separator" /><button className="new-project" onClick={resetProject} disabled={busy}><Plus size={16} /> New project</button></div>
      </header>
      <main className="main-content">
        <div className="intro-row">
          <div><div className="intro-kicker"><span>✳</span> THE CREATOR STUDIO <i /> FROM AUDIO TO VIDEO</div><h1>Your sound, <span>in motion.</span></h1><p>Turn the best part of your track into a video worth replaying.</p></div>
          <button className="intro-help" onClick={() => setModal('how')}><span className="intro-help-icon"><Sparkles size={15} /></span><span>NEW HERE?<strong>See how it works</strong></span><ArrowUpRight size={15} /></button>
        </div>

        {error && <div className="notice error-notice" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}

        <div className="workspace-grid">
          <div className="editor-column">
            <section className="editor-card track-card" id="track-section">
              <SectionHeading step="01" eyebrow="THE STARTING POINT" title="Add your track" description="Your next great video starts with a sound.">
                <span className="format-pill"><FileAudio size={13} /> MP3 ONLY</span>
              </SectionHeading>
              <input ref={fileInputRef} className="visually-hidden" type="file" accept=".mp3,audio/mpeg" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void loadTrack(file); }} />
              <div className={`upload-zone ${draggingFile ? 'is-dragging' : ''} ${busy ? 'disabled' : ''}`} onClick={() => { if (!busy) fileInputRef.current?.click(); }} onDragOver={event => { event.preventDefault(); if (!busy) setDraggingFile(true); }} onDragLeave={() => setDraggingFile(false)} onDrop={event => { event.preventDefault(); setDraggingFile(false); if (!busy) void loadTrack(event.dataTransfer.files?.[0]); }}>
                <div className="upload-icon"><Upload size={19} /></div>
                <div className="upload-copy"><strong>Drop your MP3 here <span>or</span> <button disabled={busy} onClick={event => { event.stopPropagation(); fileInputRef.current?.click(); }}>browse files</button></strong><small>Up to 25 MB <i /> 1s minimum <i /> Analyzed in your browser</small></div>
                <span className="upload-arrow"><ArrowUpRight size={16} /></span>
              </div>
              {track ? <div className="track-row">
                <div className="track-art"><Music2 size={18} /></div>
                <div className="track-info"><strong>{track.name}</strong><span><i /> {analyzing ? 'Analyzing your track…' : track.isDemo ? 'Demo track · Ready to create' : 'Track loaded · Ready to create'}</span></div>
                <div className="track-mini-wave" aria-hidden="true">{waveform.filter((_, i) => i % 5 === 0).map((bar, i) => <i key={i} style={{ height: `${Math.max(5, bar * 26)}px` }} />)}</div>
                <span className="track-duration">{analyzing ? '—:—' : formatTime(track.duration)}</span>
                <button className="track-remove" onClick={resetProject} disabled={busy} aria-label="Remove track"><X size={15} /></button>
              </div> : <div className="empty-track"><span>No track selected yet.</span><button onClick={loadDemo}>Try the demo track <ArrowRight size={13} /></button></div>}
            </section>

            <section className="editor-card hook-card" id="hook-section">
              <SectionHeading step="02" eyebrow="FIND THE MOMENT" title="Pick your hook" description="We found a good bit. Make it your own.">
                <span className="found-pill"><Sparkles size={12} /> {!track ? 'AWAITING TRACK' : analyzing ? 'LISTENING' : 'HOOK FOUND'}</span>
              </SectionHeading>
              <Timeline timeline={timeline} hook={hookCurve} duration={track?.duration || 32} start={hookStart} length={actualLength} onChange={setSelection} disabled={!track || analyzing || busy} empty={!track} audioRef={audioRef} playing={isPlaying} />
              <div className="hook-bottom">
                <div className="selection-copy"><span className="selection-icon"><AudioLines size={15} /></span><span><small>YOUR SELECTED MOMENT</small><strong>{track ? formatTime(hookStart) : '—:—'} <span>—</span> {track ? formatTime(hookStart + actualLength) : '—:—'}</strong></span></div>
                <div className="duration-control"><span>CLIP LENGTH</span><div className="segmented"><button className={clipLength === 15 ? 'selected' : ''} onClick={() => setLength(15)} disabled={!track || busy}>15s</button><button className={clipLength === 30 ? 'selected' : ''} onClick={() => setLength(30)} disabled={!track || busy || track.duration < 30} title={track && track.duration < 30 ? 'Track is shorter than 30 seconds' : ''}>30s</button></div></div>
              </div>
              <div className="hook-explainer"><Sparkles size={13} /><span>{track ? 'Scored for sustained energy and dynamics. The curve above shows how strong a clip would be from every start point.' : 'Upload a track to discover your hook.'}</span><button onClick={() => { if (analysis) setSelection(findBestHook(analysis, actualLength)); }} disabled={!analysis || busy}>Find again <RotateCcw size={11} /></button></div>
            </section>

            <section className="editor-card style-card" id="style-section">
              <SectionHeading step="03" eyebrow="MAKE IT YOURS" title="Set the mood" description="A little style goes a long way.">
                <span className="sound-reactive"><span /> SOUND REACTIVE</span>
              </SectionHeading>
              <div className="control-heading"><span>VISUALIZER STYLE</span><span>CHOOSE YOUR LOOK</span></div>
              <div className="preset-grid">
                {PRESETS.map(item => <button key={item.id} className={`preset-card ${item.id} ${preset === item.id ? 'selected' : ''}`} onClick={() => setPreset(item.id)} disabled={busy} aria-pressed={preset === item.id}>
                  <div className="preset-art"><span className="preset-number">{item.number} / 03</span>{preset === item.id && <span className="preset-check"><Check size={12} /></span>}<span className="preset-art-label">✳</span></div>
                  <div className="preset-copy"><strong>{item.name}</strong><small>{item.description}</small></div>
                </button>)}
              </div>
              <div className="caption-divider" />
              <div className="caption-heading"><div><span className="control-title">CAPTIONS</span></div><label className="switch-label"><span>{captionEnabled ? 'On' : 'Off'}</span><input type="checkbox" checked={captionEnabled} onChange={event => setCaptionEnabled(event.target.checked)} disabled={busy} /><i /></label></div>
              <p className="caption-description">Type your own words. Separate captions with a blank line to spread them evenly across the clip.</p>
              <textarea value={manualText} onChange={event => setManualText(event.target.value)} placeholder="Add a caption for your video…" disabled={busy || !captionEnabled} aria-label="Caption text" rows={3} />
              {track?.isDemo && <p className="inline-note">Demo captions are creative text, not a transcription of the instrumental.</p>}
            </section>
            <div className="editor-footnote"><span>✳</span> MADE FOR THE MOMENTS THAT MOVE YOU <span>✳</span></div>
          </div>

          <aside className="preview-column" id="preview-section">
            <div className="preview-card">
              <div className="preview-header"><div><div className="section-eyebrow">A LITTLE SNEAK PEEK</div><h2>Live preview <span className="live-dot" /></h2></div><span className="aspect-pill"><Maximize2 size={13} /> 9:16</span></div>
              <div className="preview-stage"><span className="stage-corner top-left" /><span className="stage-corner top-right" /><span className="stage-corner bottom-left" /><span className="stage-corner bottom-right" />
                <div className="preview-phone"><PreviewCanvas ref={canvasRef} trackName={track?.name} preset={preset} analyserRef={analyserRef} audioRef={audioRef} timeRef={timeRef} isPlaying={isPlaying} hookStart={hookStart} clipLength={actualLength} waveform={waveform} tempo={timeline?.tempo || null} captions={captions} captionEnabled={captionEnabled} /></div>
                <div className="stage-side-label">YOUR SOUND. YOUR STORY.</div>
              </div>
              <div className="playback-row">
                <button className="play-button" onClick={togglePlayback} disabled={!track || analyzing || busy} aria-label={isPlaying ? 'Pause preview' : 'Play preview'}>{isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
                <div className="playback-main"><div className="playback-top"><strong>{isPlaying ? 'Playing your clip' : 'Preview your clip'}</strong><span>{formatTime(relativeTime)} / {formatTime(actualLength)}</span></div><div className="playback-progress" onClick={seekWithinClip} role="slider" tabIndex={0} aria-label="Preview playback position" aria-valuemin={0} aria-valuemax={Math.floor(actualLength)} aria-valuenow={Math.floor(relativeTime)} onKeyDown={event => { if (!track || busy) return; if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = clamp(currentTime + (event.key === 'ArrowRight' ? 1 : -1), hookStart, hookStart + actualLength); audioRef.current.currentTime = next; updateTime(next); } }}><span style={{ width: `${progress * 100}%` }} /><i style={{ left: `${progress * 100}%` }} /></div></div>
                <Volume2 size={16} className="volume-icon" />
              </div>
              <div className="export-area">
                {download ? <a className="export-button download-button" href={download.url} download={download.filename}><ArrowDownToLine size={17} /> Download {download.format}<ArrowUpRight size={16} className="export-arrow" /></a> : <button className="export-button" onClick={exportVideo} disabled={!track || analyzing || busy || !apiStatus.mp4ExportAvailable}><ArrowDownToLine size={17} />{exportState.phase === 'preparing' ? 'Preparing your clip…' : exportState.phase === 'recording' ? `Recording ${formatTime(relativeTime)} / ${formatTime(actualLength)}` : exportState.phase === 'encoding' ? 'Finishing your MP4…' : 'Export video'}<ArrowUpRight size={16} className="export-arrow" /></button>}
                {exportState.message ? <div className={`export-message ${exportState.phase === 'error' ? 'is-error' : ''}`}>{exportState.phase === 'done' && <Check size={13} />}{exportState.message}</div> : <div className="export-meta"><span>MP4</span><i /> <span>1080 × 1920</span><i /> <span>READY TO SHARE</span></div>}
                {download && <button className="render-again" onClick={exportVideo} disabled={busy}>Render again <RotateCcw size={11} /></button>}
                {!apiStatus.mp4ExportAvailable && <div className="export-message is-error">MP4 export is unavailable on this server.</div>}
              </div>
            </div>
            <div className="share-row"><span>MADE FOR</span><div><strong>♪ <b>TikTok</b></strong><i /><strong>◎ <b>Reels</b></strong><i /><strong>▶ <b>Shorts</b></strong></div><span>↗</span></div>
            <p className="preview-note"><span>✳</span> A little clip. A lot of possibility.</p>
          </aside>
        </div>
      </main>
      <audio ref={audioRef} src={track?.src || undefined} preload="auto" onTimeUpdate={onAudioTimeUpdate} onLoadedMetadata={() => { if (audioRef.current && hookStart > 0) { try { audioRef.current.currentTime = hookStart; } catch { /* ignored */ } } }} onEnded={() => { setIsPlaying(false); finishRecordingRef.current?.(); }} />
    </div>

    {modal === 'how' && <Modal label="How mp3vid works" onClose={() => setModal(null)}><button className="modal-close" onClick={() => setModal(null)} aria-label="Close"><X size={18} /></button><div className="modal-icon"><Sparkles size={20} /></div><div className="section-eyebrow">THE SHORT VERSION</div><h2>From sound to scroll-stopper.</h2><p className="modal-intro">Everything you need to give your music a moment in the spotlight.</p><div className="how-list"><div><span>01</span><p><strong>Bring your track</strong><small>Upload an MP3 and we’ll analyze its sound right here in your browser.</small></p></div><div><span>02</span><p><strong>Find the good bit</strong><small>Zoom into the map to see beats, sections, and silence. We suggest a high-energy hook; drag to choose your own.</small></p></div><div><span>03</span><p><strong>Make it yours</strong><small>Pick a sound-reactive look and add your own captions.</small></p></div><div><span>04</span><p><strong>Put it out there</strong><small>Render a vertical MP4, ready for TikTok, Reels, or YouTube Shorts.</small></p></div></div><button className="modal-primary" onClick={() => setModal(null)}>Let’s make something <ArrowRight size={16} /></button></Modal>}
  </div>;
}

export default App;
