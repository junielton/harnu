#!/usr/bin/env python3
"""Generate src/renderer/src/assets/notify.wav, the notification chime.

The chime is synthesized here from two sine tones, so it carries no third-party
audio and is covered by the project's MIT license. Python standard library only.

  A5 (880 Hz) for 90 ms, then E6 (1318.51 Hz) for 120 ms. Each note starts at
  about 27.5% of full scale and decays exponentially (time constant 68 ms).
  44.1 kHz, mono, 16-bit PCM, 210 ms total.

Usage: python3 scripts/gen-notify-sound.py [output.wav]
"""

import math
import struct
import sys
import wave
from pathlib import Path

RATE = 44_100
PEAK = 0.275
TAU_S = 0.068
NOTES = [(880.0, 0.090), (1318.51, 0.120)]  # (frequency in Hz, duration in s)


def render() -> bytes:
    frames = bytearray()
    for freq, dur in NOTES:
        for i in range(round(dur * RATE)):
            t = i / RATE
            sample = PEAK * math.exp(-t / TAU_S) * math.sin(2 * math.pi * freq * t)
            frames += struct.pack("<h", round(sample * 32767))
    return bytes(frames)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "src/renderer/src/assets/notify.wav"
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(render())
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
