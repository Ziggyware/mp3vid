"""Generate the original instrumental shipped with the app (no external audio)."""
import math
import random
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

sample_rate = 32000
duration = 32
beat = 60 / 108
random.seed(13)
chords = [
    (130.81, 155.56, 196.00),  # C minor
    (103.83, 130.81, 155.56),  # A-flat
    (155.56, 196.00, 233.08),  # E-flat
    (116.54, 146.83, 174.61),  # B-flat
]
melody = (392.00, 466.16, 523.25, 466.16, 392.00, 349.23, 311.13, 349.23,
          392.00, 466.16, 622.25, 523.25, 466.16, 392.00, 349.23, 311.13)

with tempfile.TemporaryDirectory() as directory:
    wav_path = Path(directory) / 'demo.wav'
    with wave.open(str(wav_path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        for i in range(int(sample_rate * duration)):
            t = i / sample_rate
            beat_index = int(t / beat)
            beat_phase = (t % beat) / beat
            bar_index = int(t / (beat * 4))
            chord = chords[bar_index % len(chords)]
            # Soft detuned pad and a short plucked melody.
            pad = sum(math.sin(2 * math.pi * f * t) + .22 * math.sin(2 * math.pi * f * 2.003 * t)
                      for f in chord) / 3
            note_phase = (t % (beat / 2)) / (beat / 2)
            note = melody[int(t / (beat / 2)) % len(melody)]
            pluck = math.sin(2 * math.pi * note * t) * math.exp(-note_phase * 3.8)
            bass = math.sin(2 * math.pi * chord[0] / 2 * t) * (0.8 + 0.2 * math.sin(2 * math.pi * 2 * t))
            kick = math.sin(2 * math.pi * (54 * t - 10 * math.exp(-beat_phase * 14))) * math.exp(-beat_phase * 16)
            noise = random.uniform(-1, 1)
            snare = noise * math.exp(-beat_phase * 19) if beat_index % 4 in (1, 3) else 0
            hat_phase = (t % (beat / 2)) / (beat / 2)
            hat = noise * math.exp(-hat_phase * 30)
            # The arrangement opens up after eight seconds, creating a meaningful hook.
            lift = 0.62 if t < 8 else (1.0 if t < 25 else .84)
            fade = min(1, t / 1.0, (duration - t) / 1.5)
            value = fade * (0.18 * pad + lift * (0.14 * bass + 0.11 * pluck + 0.20 * kick + 0.055 * snare + 0.025 * hat))
            frames.extend(struct.pack('<h', max(-32767, min(32767, int(value * 32767)))))
        wav.writeframes(frames)
    subprocess.run([sys.argv[1], '-hide_banner', '-loglevel', 'error', '-y', '-i', str(wav_path),
                    '-codec:a', 'libmp3lame', '-b:a', '128k', 'public/midnight-motion.mp3'], check=True)
