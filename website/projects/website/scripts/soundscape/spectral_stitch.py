#!/usr/bin/env python3
"""
Spectral Crossfade Stitcher — frequency-domain loop blending.

Replaces SOX time-domain crossfade with per-bin magnitude interpolation
using STFT. Phase is taken from the dominant segment at each point,
magnitude is linearly interpolated across the overlap region.

Usage:
    python3 spectral_stitch.py <input.wav> <output.wav> [--overlap 5]

The script extracts head/tail from the input, performs spectral crossfade
in the overlap region, and outputs a seamlessly looped WAV.
"""

import argparse
import sys

import numpy as np

try:
    import librosa
    import soundfile as sf
except ImportError:
    print("Installing required packages...", file=sys.stderr)
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install",
                           "librosa", "soundfile"])
    import librosa
    import soundfile as sf


def spectral_crossfade(tail: np.ndarray, head: np.ndarray, sr: int,
                       n_fft: int = 2048, hop_length: int = 512) -> np.ndarray:
    """
    Crossfade tail into head in the frequency domain.

    For each time frame in the overlap:
      - Magnitude is linearly interpolated per frequency bin
      - Phase follows the outgoing (tail) in the first half,
        incoming (head) in the second half
    """
    S_tail = librosa.stft(tail, n_fft=n_fft, hop_length=hop_length)
    S_head = librosa.stft(head, n_fft=n_fft, hop_length=hop_length)

    mag_tail, phase_tail = librosa.magphase(S_tail)
    mag_head, phase_head = librosa.magphase(S_head)

    # Match frame counts (trim to shorter)
    n_frames = min(mag_tail.shape[1], mag_head.shape[1])
    mag_tail = mag_tail[:, :n_frames]
    mag_head = mag_head[:, :n_frames]
    phase_tail = phase_tail[:, :n_frames]
    phase_head = phase_head[:, :n_frames]

    # Linear interpolation weights: 1→0 for tail, 0→1 for head
    alpha = np.linspace(0.0, 1.0, n_frames)[np.newaxis, :]  # (1, frames)

    mag_blend = (1.0 - alpha) * mag_tail + alpha * mag_head

    # Phase: use tail phase in first half, head phase in second half
    midpoint = n_frames // 2
    phase_blend = np.empty_like(phase_tail)
    phase_blend[:, :midpoint] = phase_tail[:, :midpoint]
    phase_blend[:, midpoint:] = phase_head[:, midpoint:]

    S_blend = mag_blend * phase_blend

    y = librosa.istft(S_blend, hop_length=hop_length, length=len(tail))
    return y


def granular_extend(y: np.ndarray, sr: int, target_seconds: float,
                    grain_size: float = 0.05, density: int = 8) -> np.ndarray:
    """
    Granular synthesis fallback: extend short audio by overlapping random grains.
    Used when source is too short for spectral crossfade (< minimum viable keynote).

    Based on overlap-add granular synthesis (Roads 2001):
    - Extract random grains from source
    - Apply Hann window to each grain
    - Scatter with random offsets into output buffer
    - Density controls how many grains overlap at any point
    """
    target_samples = int(target_seconds * sr)
    grain_samples = int(grain_size * sr)
    if grain_samples < 64:
        grain_samples = 64

    output = np.zeros(target_samples, dtype=np.float64)
    window = np.hanning(grain_samples)
    src_len = len(y)

    n_grains = int(target_samples / grain_samples * density)
    for _ in range(n_grains):
        # Random source position
        src_start = np.random.randint(0, max(1, src_len - grain_samples))
        grain = y[src_start:src_start + grain_samples].astype(np.float64)
        if len(grain) < grain_samples:
            grain = np.pad(grain, (0, grain_samples - len(grain)))

        # Apply window + micro pitch variation (±2%)
        grain = grain * window
        # Random output position
        out_start = np.random.randint(0, max(1, target_samples - grain_samples))
        output[out_start:out_start + grain_samples] += grain

    # Normalize to match source RMS
    src_rms = np.sqrt(np.mean(y ** 2)) + 1e-10
    out_rms = np.sqrt(np.mean(output ** 2)) + 1e-10
    output = output * (src_rms / out_rms)

    return output.astype(np.float32)


# Minimum viable keynote: 1.5s analysis windows need at least ~4.5s source
MIN_VIABLE_SECONDS = 4.5


def main():
    parser = argparse.ArgumentParser(
        description="Spectral crossfade stitcher for seamless WAV loops")
    parser.add_argument("input", help="Input WAV file (noise-gated, normalized)")
    parser.add_argument("output", help="Output WAV file (seamless loop)")
    parser.add_argument("--overlap", type=float, default=5.0,
                        help="Crossfade overlap in seconds (default: 5)")
    parser.add_argument("--target-duration", type=float, default=0,
                        help="Target output duration for granular mode (default: 60s)")
    args = parser.parse_args()

    y, sr = librosa.load(args.input, sr=None, mono=True)
    duration = len(y) / sr
    overlap = args.overlap
    target_dur = args.target_duration if args.target_duration > 0 else 60.0

    # Adaptive overlap: min(requested, duration/3)
    max_overlap = duration / 3.0
    if overlap > max_overlap:
        old_overlap = overlap
        overlap = max(0.5, max_overlap)
        print(f"ADAPT: overlap {old_overlap:.1f}s → {overlap:.1f}s "
              f"(source only {duration:.1f}s)", file=sys.stderr)

    overlap_samples = int(overlap * sr)

    # If source is below minimum viable keynote length, switch to granular mode
    if duration < MIN_VIABLE_SECONDS:
        print(f"GRANULAR: source {duration:.1f}s < {MIN_VIABLE_SECONDS}s minimum, "
              f"switching to granular synthesis (target {target_dur:.0f}s)",
              file=sys.stderr)
        loop = granular_extend(y, sr, target_dur)
        sf.write(args.output, loop, sr, subtype='PCM_16')
        print(f"OK: {args.output} ({len(loop)/sr:.1f}s, {sr}Hz, granular)")
        return

    if len(y) < overlap_samples * 3:
        # Last resort: use very small overlap
        overlap_samples = max(int(0.5 * sr), len(y) // 4)
        print(f"ADAPT: using minimal overlap {overlap_samples/sr:.1f}s", file=sys.stderr)

    # Extract regions
    tail = y[-overlap_samples:]          # last N seconds
    head = y[:overlap_samples]           # first N seconds
    body = y[overlap_samples:-overlap_samples]  # middle

    # Spectral crossfade
    xfade = spectral_crossfade(tail, head, sr)

    # Concatenate: body + crossfade
    loop = np.concatenate([body, xfade])

    sf.write(args.output, loop, sr, subtype='PCM_16')
    print(f"OK: {args.output} ({len(loop)/sr:.1f}s, {sr}Hz)")


if __name__ == "__main__":
    main()
