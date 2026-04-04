#!/usr/bin/env python3
"""
Soundscape Classifier — Schafer ESC Heuristic (Phase 2)

Splits a raw WAV recording into 2-second chunks, extracts spectral
features, and sorts each chunk into one of three Schafer pools:

  Keynote   — steady background drone  (within 1σ of mean)
  Signal    — transient foreground      (1σ – 2.5σ)
  Soundmark — location-unique / rare    (> 2.5σ or spectral outlier)

This is a statistical-proxy classifier; a trained VAE replaces
the heuristic in a later phase.

Usage:
    python3 classify.py <input.wav> [--out-dir DIR]
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf


# ── Constants ─────────────────────────────────────────────────
CHUNK_DURATION = 2.0        # seconds per analysis window
SR = 44100                  # sample rate
N_MELS = 128               # mel spectrogram bands
KEYNOTE_SIGMA = 1.0         # within this → Keynote
SIGNAL_SIGMA = 2.5          # between KEYNOTE and this → Signal
POOLS_DIR = Path.home() / ".soundscape" / "pools"


# ── Feature extraction ───────────────────────────────────────
def extract_features(y: np.ndarray, sr: int) -> dict:
    """Return a dict of scalar features for one chunk."""
    mel = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=N_MELS)
    mel_db = librosa.power_to_db(mel, ref=np.max)
    mel_mean = float(np.mean(mel_db))
    mel_std = float(np.std(mel_db))

    rms = float(np.mean(librosa.feature.rms(y=y)))
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    flatness = float(np.mean(librosa.feature.spectral_flatness(y=y)))
    zcr = float(np.mean(librosa.feature.zero_crossing_rate(y=y)))

    return {
        "mel_mean": mel_mean,
        "mel_std": mel_std,
        "rms": rms,
        "centroid": centroid,
        "flatness": flatness,
        "zcr": zcr,
    }


# ── Classification ────────────────────────────────────────────
def classify_chunks(chunks: list[dict]) -> list[dict]:
    """
    Assign each chunk to a Schafer pool using z-score outlier detection
    across all extracted features.

    Strategy:
      1. Compute mean/std for each feature across all chunks.
      2. For each chunk, compute max |z| across features.
      3. max|z| ≤ KEYNOTE_SIGMA  → keynote
         max|z| ≤ SIGNAL_SIGMA   → signal
         max|z| >  SIGNAL_SIGMA  → soundmark
      4. Additional spectral-signature rule: very high flatness
         (white-noise-like) combined with low RMS → soundmark
         (captures unique ambient textures).
    """
    feature_keys = ["mel_mean", "mel_std", "rms", "centroid", "flatness", "zcr"]

    # Global statistics
    stats = {}
    for key in feature_keys:
        values = np.array([c["features"][key] for c in chunks])
        stats[key] = {"mean": float(np.mean(values)), "std": float(np.std(values))}

    for chunk in chunks:
        z_scores = []
        for key in feature_keys:
            std = stats[key]["std"]
            if std < 1e-12:
                z_scores.append(0.0)
            else:
                z = abs(chunk["features"][key] - stats[key]["mean"]) / std
                z_scores.append(z)

        max_z = max(z_scores)

        # Spectral-signature override: high flatness + low RMS → soundmark
        flatness_z = z_scores[feature_keys.index("flatness")]
        rms_z = z_scores[feature_keys.index("rms")]
        spectral_outlier = (
            chunk["features"]["flatness"] > stats["flatness"]["mean"] + 2.0 * stats["flatness"]["std"]
            and chunk["features"]["rms"] < stats["rms"]["mean"]
        )

        if max_z > SIGNAL_SIGMA or spectral_outlier:
            chunk["pool"] = "soundmark"
        elif max_z > KEYNOTE_SIGMA:
            chunk["pool"] = "signal"
        else:
            chunk["pool"] = "keynote"

        chunk["max_z"] = round(max_z, 4)

    return chunks


# ── WAV export per pool ──────────────────────────────────────
def export_pool_wavs(audio: np.ndarray, sr: int, chunks: list[dict], timestamp: str):
    """Concatenate chunks per pool and write WAV files."""
    POOLS_DIR.mkdir(parents=True, exist_ok=True)

    for pool_name in ("keynote", "signal", "soundmark"):
        pool_chunks = [c for c in chunks if c["pool"] == pool_name]
        if not pool_chunks:
            continue

        segments = []
        for c in pool_chunks:
            start_sample = int(c["start"] * sr)
            end_sample = int(c["end"] * sr)
            segments.append(audio[start_sample:end_sample])

        combined = np.concatenate(segments)
        out_path = POOLS_DIR / f"{pool_name}_{timestamp}.wav"
        sf.write(str(out_path), combined, sr)
        print(f"  {pool_name}: {len(pool_chunks)} chunks → {out_path}")


# ── Manifest generation ──────────────────────────────────────
def build_manifest(source_name: str, chunks: list[dict]) -> dict:
    """Build the JSON manifest structure."""
    pools = {"keynote": [], "signal": [], "soundmark": []}

    for c in chunks:
        entry = {
            "start": c["start"],
            "end": c["end"],
            "rms": round(c["features"]["rms"], 6),
            "centroid": round(c["features"]["centroid"], 1),
        }
        pools[c["pool"]].append(entry)

    stats = {
        "total_chunks": len(chunks),
        "keynote": len(pools["keynote"]),
        "signal": len(pools["signal"]),
        "soundmark": len(pools["soundmark"]),
    }

    return {
        "source": source_name,
        "classified_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
        "pools": pools,
        "stats": stats,
    }


# ── Main ──────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Schafer soundscape classifier (heuristic)")
    parser.add_argument("input", help="Path to raw WAV file")
    parser.add_argument("--out-dir", default=None, help="Directory for manifest JSON (default: same as input)")
    args = parser.parse_args()

    wav_path = Path(args.input)
    if not wav_path.exists():
        print(f"ERROR: {wav_path} not found", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(args.out_dir) if args.out_dir else wav_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading {wav_path} ...")
    audio, sr = librosa.load(str(wav_path), sr=SR, mono=True)
    total_duration = len(audio) / sr
    print(f"  duration: {total_duration:.1f}s  sr: {sr}")

    # ── Segment into 2s chunks ────────────────────────────────
    chunk_samples = int(CHUNK_DURATION * sr)
    n_chunks = int(len(audio) // chunk_samples)
    print(f"  segmenting into {n_chunks} chunks of {CHUNK_DURATION}s")

    chunks = []
    for i in range(n_chunks):
        start_sample = i * chunk_samples
        end_sample = start_sample + chunk_samples
        y = audio[start_sample:end_sample]
        features = extract_features(y, sr)
        chunks.append({
            "index": i,
            "start": round(i * CHUNK_DURATION, 2),
            "end": round((i + 1) * CHUNK_DURATION, 2),
            "features": features,
        })

    if not chunks:
        print("ERROR: no chunks extracted (file too short?)", file=sys.stderr)
        sys.exit(1)

    # ── Classify ──────────────────────────────────────────────
    chunks = classify_chunks(chunks)

    counts = {"keynote": 0, "signal": 0, "soundmark": 0}
    for c in chunks:
        counts[c["pool"]] += 1
    print(f"  classified: keynote={counts['keynote']} signal={counts['signal']} soundmark={counts['soundmark']}")

    # ── Export pool WAVs ──────────────────────────────────────
    timestamp = datetime.now().strftime("%H%M%S")
    print("Exporting pool WAVs:")
    export_pool_wavs(audio, sr, chunks, timestamp)

    # ── Write manifest ────────────────────────────────────────
    manifest = build_manifest(wav_path.name, chunks)
    manifest_path = out_dir / f"{wav_path.stem}_classified.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"Manifest: {manifest_path}")

    # Print the manifest path to stdout last line for pipeline.sh to capture
    print(f"MANIFEST={manifest_path}")


if __name__ == "__main__":
    main()
