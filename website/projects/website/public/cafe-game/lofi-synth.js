// CafeLofiSynth — Real-time lofi hip-hop beat generator
// Pure Web Audio API. Zero dependencies. Mood-reactive.
// Usage: CafeLofiSynth.init(audioContext); CafeLofiSynth.start();
(function () {
  'use strict';

  // ─── State ───
  var ctx = null;
  var masterGain = null;
  var playing = false;
  var schedulerTimer = null;
  var nextBeatTime = 0;
  var currentStep = 0;
  var STEPS = 16; // 16th-note grid
  var SCHEDULE_AHEAD = 0.1; // seconds to look ahead
  var SCHEDULE_INTERVAL = 25; // ms between scheduler calls

  // Mood parameters (0-1), with smooth interpolation targets
  var mood = { intensity: 0.4, valence: 0.3, flow: 0.5, tension: 0.2, creativity: 0.3 };
  var moodTarget = { intensity: 0.4, valence: 0.3, flow: 0.5, tension: 0.2, creativity: 0.3 };
  var MOOD_LERP = 0.02; // per scheduler tick

  // Node references for cleanup
  var nodes = {
    compressor: null,
    lpf: null,        // master warmth filter
    reverbSend: null,
    reverbReturn: null,
    convolver: null,
    vinylProc: null,
    rainNoise: null,
    rainGain: null,
    wobbleLfo: null,
    wobbleGain: null,
    dryBus: null,
    wetBus: null
  };

  // Chord/melody state
  var currentChordIndex = 0;
  var currentProgression = null;
  var barCount = 0;
  var lastMelodyStep = -4; // cooldown

  // ─── Musical Data ───

  // Note frequencies (A3 = 220Hz base)
  var NOTE_FREQ = {
    'C3': 130.81, 'Db3': 138.59, 'D3': 146.83, 'Eb3': 155.56, 'E3': 164.81,
    'F3': 174.61, 'Gb3': 185.00, 'G3': 196.00, 'Ab3': 207.65, 'A3': 220.00,
    'Bb3': 233.08, 'B3': 246.94,
    'C4': 261.63, 'Db4': 277.18, 'D4': 293.66, 'Eb4': 311.13, 'E4': 329.63,
    'F4': 349.23, 'Gb4': 369.99, 'G4': 392.00, 'Ab4': 415.30, 'A4': 440.00,
    'Bb4': 466.16, 'B4': 493.88,
    'C5': 523.25, 'Db5': 554.37, 'D5': 587.33, 'Eb5': 622.25, 'E5': 659.26,
    'F5': 698.46, 'G5': 783.99, 'A5': 880.00
  };

  // Jazz chord voicings — each chord is an array of note names
  // Minor key progressions (Am/Cm feel)
  var MINOR_PROGRESSIONS = [
    // ii-V-I in Am: Bm7b5 - E7 - Am7
    [
      { name: 'Bm7b5', notes: ['B3', 'D4', 'F4', 'A4'] },
      { name: 'E7',    notes: ['E3', 'Ab4', 'D4', 'B3'] },
      { name: 'Am9',   notes: ['A3', 'C4', 'E4', 'G4'] },
      { name: 'Am9',   notes: ['A3', 'C4', 'E4', 'G4'] }
    ],
    // vi-ii-V-I in C minor feel: Fm7 - Bb7 - Ebmaj7 - Cm9
    [
      { name: 'Fm7',    notes: ['F3', 'Ab3', 'C4', 'Eb4'] },
      { name: 'Bb7',    notes: ['Bb3', 'D4', 'F4', 'Ab4'] },
      { name: 'Ebmaj7', notes: ['Eb3', 'G3', 'Bb3', 'D4'] },
      { name: 'Cm9',    notes: ['C3', 'Eb3', 'G3', 'Bb3'] }
    ],
    // Dm7 - G7 - Cmaj7 - Am7 (classic ii-V-I-vi)
    [
      { name: 'Dm9',   notes: ['D3', 'F3', 'A3', 'C4'] },
      { name: 'G7',    notes: ['G3', 'B3', 'D4', 'F4'] },
      { name: 'Cmaj7', notes: ['C3', 'E3', 'G3', 'B3'] },
      { name: 'Am7',   notes: ['A3', 'C4', 'E4', 'G4'] }
    ]
  ];

  // Major/bright variants (higher valence)
  var MAJOR_PROGRESSIONS = [
    // Fmaj7 - Em7 - Dm7 - Cmaj7 (descending)
    [
      { name: 'Fmaj7', notes: ['F3', 'A3', 'C4', 'E4'] },
      { name: 'Em7',   notes: ['E3', 'G3', 'B3', 'D4'] },
      { name: 'Dm7',   notes: ['D3', 'F3', 'A3', 'C4'] },
      { name: 'Cmaj7', notes: ['C3', 'E3', 'G3', 'B3'] }
    ],
    // Dmaj7 - Bm7 - Gmaj7 - A7
    [
      { name: 'Dmaj7', notes: ['D3', 'Gb3', 'A3', 'Db4'] },
      { name: 'Bm7',   notes: ['B3', 'D4', 'Gb4', 'A4'] },
      { name: 'Gmaj7', notes: ['G3', 'B3', 'D4', 'Gb4'] },
      { name: 'A7',    notes: ['A3', 'Db4', 'E4', 'G4'] }
    ]
  ];

  // Drum patterns — 16 steps, values = velocity (0 = silent)
  // Multiple patterns per instrument for variation
  var KICK_PATTERNS = [
    [1, 0, 0, 0,  0, 0, 1, 0,  1, 0, 0, 0,  0, 0, 0, 0],  // classic boom bap
    [1, 0, 0, 0,  0, 0, 0, 1,  0, 0, 1, 0,  0, 0, 0, 0],  // laid back
    [1, 0, 0, 1,  0, 0, 1, 0,  0, 0, 0, 0,  1, 0, 0, 0],  // syncopated
    [1, 0, 0, 0,  0, 0, 0, 0,  1, 0, 0, 1,  0, 0, 1, 0]   // jazzy
  ];

  var SNARE_PATTERNS = [
    [0, 0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 0,  1, 0, 0, 0],  // 2 and 4
    [0, 0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 0,  1, 0, 0, 1],  // ghost note end
    [0, 0, 0, 0,  1, 0, 0, 1,  0, 0, 0, 0,  1, 0, 0, 0],  // ghost note
    [0, 0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 1,  1, 0, 0, 0]   // offbeat
  ];

  var HIHAT_PATTERNS = [
    [1, 0, 1, 0,  1, 0, 1, 0,  1, 0, 1, 0,  1, 0, 1, 0],  // straight 8ths
    [1, 0, 1, 0,  1, 0, 1, 1,  1, 0, 1, 0,  1, 0, 1, 1],  // w/ 16th pickup
    [1, 1, 0, 1,  1, 0, 1, 0,  1, 1, 0, 1,  1, 0, 1, 0],  // shuffled
    [1, 0, 0, 1,  0, 1, 0, 1,  1, 0, 0, 1,  0, 1, 0, 0]   // sparse
  ];

  // Current pattern indices
  var kickPat = 0, snarePat = 0, hihatPat = 0;

  // Noise buffer (reused)
  var noiseBuffer = null;

  // ─── Helper Functions ───

  function lerp(a, b, t) { return a + (b - a) * t; }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function getBPM() {
    return lerp(70, 85, mood.intensity);
  }

  function getStepDuration() {
    // Duration of one 16th note in seconds
    return 60 / getBPM() / 4;
  }

  function createNoiseBuffer(duration) {
    if (noiseBuffer && noiseBuffer.duration >= duration) return noiseBuffer;
    var length = Math.max(Math.ceil(ctx.sampleRate * duration), ctx.sampleRate * 2);
    var buf = ctx.createBuffer(1, length, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    noiseBuffer = buf;
    return buf;
  }

  // ─── Sound Synthesis ───

  function playKick(time, velocity) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'sine';
    // Pitch drop: 150Hz -> 50Hz
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(50, time + 0.07);
    osc.frequency.exponentialRampToValueAtTime(30, time + 0.2);
    // Volume envelope
    var vol = 0.35 * velocity;
    g.gain.setValueAtTime(vol, time);
    g.gain.setValueAtTime(vol * 0.8, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    osc.connect(g);
    g.connect(nodes.dryBus);
    osc.start(time);
    osc.stop(time + 0.35);
    // Sub layer for weight
    var sub = ctx.createOscillator();
    var sg = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(60, time);
    sub.frequency.exponentialRampToValueAtTime(35, time + 0.15);
    sg.gain.setValueAtTime(vol * 0.5, time);
    sg.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
    sub.connect(sg);
    sg.connect(nodes.dryBus);
    sub.start(time);
    sub.stop(time + 0.3);
  }

  function playSnare(time, velocity) {
    // Noise burst through bandpass
    var src = ctx.createBufferSource();
    src.buffer = createNoiseBuffer(0.2);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000 + Math.random() * 500;
    bp.Q.value = 1.2;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    var g = ctx.createGain();
    var vol = 0.2 * velocity;
    g.gain.setValueAtTime(vol, time);
    g.gain.exponentialRampToValueAtTime(vol * 0.3, time + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
    src.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(nodes.dryBus);
    // Also send a bit to reverb
    var rg = ctx.createGain();
    rg.gain.value = 0.15;
    g.connect(rg);
    rg.connect(nodes.reverbSend);
    src.start(time);
    src.stop(time + 0.2);
    // Tonal body
    var osc = ctx.createOscillator();
    var og = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200, time);
    osc.frequency.exponentialRampToValueAtTime(120, time + 0.05);
    og.gain.setValueAtTime(vol * 0.6, time);
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    osc.connect(og);
    og.connect(nodes.dryBus);
    osc.start(time);
    osc.stop(time + 0.1);
  }

  function playGhostSnare(time) {
    // Very quiet snare hit — adds groove
    playSnare(time, 0.25 + Math.random() * 0.15);
  }

  function playHiHat(time, velocity, open) {
    var src = ctx.createBufferSource();
    src.buffer = createNoiseBuffer(0.1);
    var bp = ctx.createBiquadFilter();
    bp.type = 'highpass';
    bp.frequency.value = 7000 + Math.random() * 2000;
    var g = ctx.createGain();
    var vol = 0.08 * velocity;
    var decay = open ? 0.12 : 0.04;
    g.gain.setValueAtTime(vol, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + decay);
    src.connect(bp);
    bp.connect(g);
    g.connect(nodes.dryBus);
    src.start(time);
    src.stop(time + decay + 0.01);
  }

  // ─── Rhodes/EP Chord Synth ───

  function playRhodesNote(freq, time, duration, velocity) {
    // Detuned triangle wave pair = Rhodes-like timbre
    var osc1 = ctx.createOscillator();
    var osc2 = ctx.createOscillator();
    var osc3 = ctx.createOscillator(); // sine harmonic for body
    osc1.type = 'triangle';
    osc2.type = 'triangle';
    osc3.type = 'sine';
    osc1.frequency.value = freq;
    osc2.frequency.value = freq * 1.003; // slight detune for width
    osc3.frequency.value = freq * 2; // 2nd harmonic, very soft
    // Apply tape wobble via global detune LFO (connected in init)
    var g = ctx.createGain();
    var vol = 0.055 * velocity;
    // EP-like envelope: fast attack, gentle sustain, slow release
    g.gain.setValueAtTime(0.001, time);
    g.gain.linearRampToValueAtTime(vol, time + 0.01);
    g.gain.setValueAtTime(vol * 0.85, time + 0.03);
    g.gain.linearRampToValueAtTime(vol * 0.6, time + duration * 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, time + duration);
    // Per-note low-pass for warmth
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    var cutoff = lerp(800, 2000, mood.valence);
    lp.frequency.setValueAtTime(cutoff * 1.5, time);
    lp.frequency.exponentialRampToValueAtTime(cutoff * 0.5, time + duration);
    lp.Q.value = 0.7;
    osc1.connect(lp);
    osc2.connect(lp);
    var harmG = ctx.createGain();
    harmG.gain.value = 0.15; // very subtle harmonic
    osc3.connect(harmG);
    harmG.connect(lp);
    lp.connect(g);
    g.connect(nodes.dryBus);
    // Reverb send
    var rg = ctx.createGain();
    rg.gain.value = 0.25;
    g.connect(rg);
    rg.connect(nodes.reverbSend);
    osc1.start(time);
    osc2.start(time);
    osc3.start(time);
    osc1.stop(time + duration + 0.05);
    osc2.stop(time + duration + 0.05);
    osc3.stop(time + duration + 0.05);
  }

  function playChord(chordObj, time, duration) {
    var notes = chordObj.notes;
    var vel = lerp(0.5, 0.9, mood.intensity);
    // Slight strum delay for human feel
    for (var i = 0; i < notes.length; i++) {
      var freq = NOTE_FREQ[notes[i]];
      if (!freq) continue;
      var strumDelay = i * lerp(0.01, 0.04, 1 - mood.flow);
      playRhodesNote(freq, time + strumDelay, duration, vel * (0.85 + Math.random() * 0.15));
    }
  }

  // ─── Melody Generator ───

  function getChordTones(chordObj) {
    // Return frequencies of current chord notes + octave above for melody range
    var tones = [];
    chordObj.notes.forEach(function (n) {
      var f = NOTE_FREQ[n];
      if (f) {
        tones.push(f);
        tones.push(f * 2); // octave above
      }
    });
    return tones;
  }

  function shouldPlayMelody(step) {
    // Probability of playing a melody note, based on mood
    if (step - lastMelodyStep < 2) return false; // minimum gap
    var prob = lerp(0.05, 0.25, mood.intensity) * lerp(0.5, 1.2, mood.creativity);
    // Higher chance on beat positions
    if (step % 4 === 0) prob *= 1.8;
    if (step % 2 === 0) prob *= 1.3;
    return Math.random() < prob;
  }

  function playMelodyNote(chordObj, time) {
    var tones = getChordTones(chordObj);
    // Pick a note, preferring upper register for melody
    var idx = Math.floor(tones.length * 0.5 + Math.random() * tones.length * 0.5);
    idx = Math.min(idx, tones.length - 1);
    var freq = tones[idx];
    // Occasional passing tones for color (tension-based)
    if (Math.random() < mood.tension * 0.4) {
      // Shift by a major 2nd up or down
      freq *= Math.random() > 0.5 ? 1.122 : 0.891;
    }
    var dur = lerp(0.15, 0.6, mood.flow) * getStepDuration() * 4;
    playRhodesNote(freq, time, dur, lerp(0.3, 0.7, mood.intensity) * 0.7);
  }

  // ─── Bass ───

  function playBass(freq, time, duration) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq / 2; // One octave below root
    var vol = 0.12 * lerp(0.5, 1.0, mood.intensity);
    g.gain.setValueAtTime(0.001, time);
    g.gain.linearRampToValueAtTime(vol, time + 0.02);
    g.gain.setValueAtTime(vol * 0.7, time + duration * 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, time + duration);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lerp(400, 800, mood.valence);
    lp.Q.value = 1.0;
    osc.connect(lp);
    lp.connect(g);
    g.connect(nodes.dryBus);
    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  // ─── Texture: Vinyl Crackle (independent) ───

  function createVinylCrackle() {
    var bufSize = 4096;
    // Using AudioWorklet would be ideal but ScriptProcessor works universally
    var proc = ctx.createScriptProcessor(bufSize, 0, 1);
    proc.onaudioprocess = function (e) {
      var out = e.outputBuffer.getChannelData(0);
      for (var i = 0; i < bufSize; i++) {
        var r = Math.random();
        if (r > 0.998) {
          out[i] = (Math.random() * 2 - 1) * 0.4;
        } else if (r > 0.993) {
          out[i] = (Math.random() * 2 - 1) * 0.1;
        } else if (r > 0.975) {
          out[i] = (Math.random() * 2 - 1) * 0.025;
        } else {
          out[i] = (Math.random() * 2 - 1) * 0.002;
        }
      }
    };
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500;
    bp.Q.value = 0.5;
    var g = ctx.createGain();
    g.gain.value = 0.018;
    proc.connect(bp);
    bp.connect(g);
    g.connect(masterGain);
    return { proc: proc, gain: g };
  }

  // ─── Texture: Rain ───

  function createRainNoise() {
    // Continuous noise -> bandpass 200-800Hz, very subtle
    var bufSize = 4096;
    var proc = ctx.createScriptProcessor(bufSize, 0, 1);
    // Brown noise (integrated white noise) for rain character
    var lastOut = 0;
    proc.onaudioprocess = function (e) {
      var out = e.outputBuffer.getChannelData(0);
      for (var i = 0; i < bufSize; i++) {
        var white = Math.random() * 2 - 1;
        lastOut = (lastOut + (0.02 * white)) / 1.02;
        out[i] = lastOut * 3.5;
      }
    };
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500;
    bp.Q.value = 0.3;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 200;
    var g = ctx.createGain();
    g.gain.value = 0.025;
    proc.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(masterGain);
    return { proc: proc, gain: g };
  }

  // ─── Texture: Tape Wobble ───

  function createTapeWobble() {
    // Slow LFO modulating detune on all oscillators via the dry bus
    var lfo = ctx.createOscillator();
    var lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 0.2; // 0.1-0.3 Hz wobble
    lfoGain.gain.value = 4; // cents of detune
    lfo.connect(lfoGain);
    lfo.start();
    return { lfo: lfo, gain: lfoGain };
  }

  // ─── Reverb ───

  function createReverbIR(duration, decay) {
    var sr = ctx.sampleRate;
    var length = Math.floor(sr * duration);
    var buf = ctx.createBuffer(2, length, sr);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      for (var i = 0; i < length; i++) {
        var t = i / sr;
        data[i] = (Math.random() * 2 - 1) * Math.exp(-decay * t);
      }
      // Lowpass for warmth
      var rc = 1.0 / (2 * Math.PI * 2000);
      var dt = 1.0 / sr;
      var a = dt / (rc + dt);
      for (var i = 1; i < length; i++) {
        data[i] = data[i - 1] + a * (data[i] - data[i - 1]);
      }
      // Stereo decorrelation
      if (ch === 1) {
        var off = 23;
        for (var i = length - 1; i >= off; i--) data[i] = data[i - off];
        for (var i = 0; i < off; i++) data[i] = 0;
      }
    }
    return buf;
  }

  // ─── Progression Logic ───

  function pickProgression() {
    if (mood.valence > 0.6) {
      return pick(MAJOR_PROGRESSIONS);
    } else if (mood.valence < 0.3) {
      return pick(MINOR_PROGRESSIONS);
    } else {
      // Mix: pick from either
      return pick(Math.random() > 0.5 ? MAJOR_PROGRESSIONS : MINOR_PROGRESSIONS);
    }
  }

  function maybeChangeProgression() {
    // Change progression every 2-4 bars depending on creativity
    var changeEvery = Math.floor(lerp(4, 2, mood.creativity));
    if (barCount % changeEvery === 0 && barCount > 0) {
      if (Math.random() < lerp(0.2, 0.7, mood.creativity)) {
        currentProgression = pickProgression();
      }
    }
  }

  function maybeChangePatterns() {
    // Vary drum patterns based on creativity and bar boundaries
    if (barCount % 4 === 0 && Math.random() < mood.creativity * 0.6) {
      kickPat = Math.floor(Math.random() * KICK_PATTERNS.length);
    }
    if (barCount % 4 === 0 && Math.random() < mood.creativity * 0.5) {
      snarePat = Math.floor(Math.random() * SNARE_PATTERNS.length);
    }
    if (barCount % 2 === 0 && Math.random() < mood.creativity * 0.4) {
      hihatPat = Math.floor(Math.random() * HIHAT_PATTERNS.length);
    }
  }

  // ─── Swing / Humanize ───

  function swingOffset(step) {
    // Apply swing to offbeat 16th notes (steps 1, 3, 5, 7...)
    if (step % 2 === 1) {
      var swingAmount = lerp(0.02, 0.06, mood.flow);
      return swingAmount * getStepDuration();
    }
    return 0;
  }

  function humanize() {
    // Random timing offset for human feel
    return (Math.random() - 0.5) * 0.008;
  }

  // ─── Master Scheduler ───

  function scheduleStep(step, time) {
    var stepDur = getStepDuration();
    var swing = swingOffset(step);
    var t = time + swing + humanize();

    // ── Drums ──
    var kickVel = KICK_PATTERNS[kickPat][step];
    var snareVel = SNARE_PATTERNS[snarePat][step];
    var hihatVel = HIHAT_PATTERNS[hihatPat][step];

    // Tension adds syncopation: randomly drop/add hits
    if (mood.tension > 0.5 && Math.random() < (mood.tension - 0.5) * 0.3) {
      if (kickVel === 0 && step % 2 === 1) kickVel = 0.6;
      else if (kickVel > 0 && Math.random() < 0.3) kickVel = 0;
    }

    // Intensity scales drum density
    var densityGate = lerp(0.3, 0.0, mood.intensity);
    if (kickVel > 0 && Math.random() > densityGate) playKick(t, kickVel);
    if (snareVel > 0 && Math.random() > densityGate) playSnare(t, snareVel);
    if (hihatVel > 0) playHiHat(t, hihatVel * lerp(0.5, 1.0, mood.intensity), step % 4 === 0);

    // Ghost notes for groove
    if (step % 4 === 3 && Math.random() < 0.15 * mood.intensity) {
      playGhostSnare(t + stepDur * 0.5);
    }

    // ── Chords: play on beat 1 of each bar (step 0 of each group of 16) ──
    if (step === 0) {
      maybeChangeProgression();
      maybeChangePatterns();
      var chord = currentProgression[currentChordIndex % currentProgression.length];
      var chordDur = stepDur * 14; // nearly full bar sustain
      playChord(chord, t, chordDur);
      // Bass on root
      var rootFreq = NOTE_FREQ[chord.notes[0]];
      if (rootFreq) playBass(rootFreq, t, stepDur * 8);
      currentChordIndex++;
      if (currentChordIndex >= currentProgression.length) {
        currentChordIndex = 0;
        barCount++;
      }
    }

    // Additional bass hit mid-bar for rhythm
    if (step === 8 && Math.random() < mood.intensity * 0.7) {
      var chord = currentProgression[currentChordIndex % currentProgression.length];
      var fifthIdx = 2; // typically the 5th is 3rd note in voicing
      var bassNote = chord.notes[Math.min(fifthIdx, chord.notes.length - 1)];
      var bassFreq = NOTE_FREQ[bassNote];
      if (bassFreq) playBass(bassFreq, t, stepDur * 4);
    }

    // ── Melody ──
    if (shouldPlayMelody(step)) {
      var chord = currentProgression[currentChordIndex % currentProgression.length];
      playMelodyNote(chord, t);
      lastMelodyStep = step + barCount * STEPS;
    }
  }

  function scheduler() {
    while (nextBeatTime < ctx.currentTime + SCHEDULE_AHEAD) {
      scheduleStep(currentStep, nextBeatTime);
      nextBeatTime += getStepDuration();
      currentStep = (currentStep + 1) % STEPS;
    }
    // Smooth mood interpolation
    for (var key in mood) {
      if (mood.hasOwnProperty(key)) {
        mood[key] = lerp(mood[key], moodTarget[key], MOOD_LERP);
      }
    }
    // Update dynamic parameters
    updateDynamicParams();
  }

  function updateDynamicParams() {
    // Master low-pass warmth
    if (nodes.lpf) {
      var cutoff = lerp(800, 3500, mood.valence * 0.6 + mood.intensity * 0.4);
      nodes.lpf.frequency.value = cutoff;
    }
    // Tape wobble speed
    if (nodes.wobbleLfo) {
      nodes.wobbleLfo.lfo.frequency.value = lerp(0.1, 0.35, mood.tension * 0.5 + (1 - mood.flow) * 0.5);
      nodes.wobbleLfo.gain.gain.value = lerp(2, 8, mood.tension);
    }
    // Rain volume
    if (nodes.rainGain) {
      nodes.rainGain.gain.value = lerp(0.01, 0.04, mood.flow);
    }
  }

  // ─── Public API ───

  function init(audioContext) {
    ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();

    // Master output chain: dryBus -> LPF -> compressor -> masterGain -> destination
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.6;

    // Compressor to glue the mix
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    nodes.compressor = comp;

    // Master warmth filter
    var lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 2000;
    lpf.Q.value = 0.5;
    nodes.lpf = lpf;

    // Dry bus (instruments connect here)
    var dryBus = ctx.createGain();
    dryBus.gain.value = 1.0;
    nodes.dryBus = dryBus;

    // Reverb send/return
    var reverbSend = ctx.createGain();
    reverbSend.gain.value = 1.0;
    nodes.reverbSend = reverbSend;

    var convolver = ctx.createConvolver();
    convolver.buffer = createReverbIR(1.5, 4.0);
    nodes.convolver = convolver;

    var reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.2;
    nodes.reverbReturn = reverbReturn;

    // Routing
    dryBus.connect(lpf);
    lpf.connect(comp);
    comp.connect(masterGain);
    masterGain.connect(ctx.destination);

    reverbSend.connect(convolver);
    convolver.connect(reverbReturn);
    reverbReturn.connect(masterGain);

    // Noise buffer
    createNoiseBuffer(2);

    // Initial progression
    currentProgression = pickProgression();
  }

  function start() {
    if (playing) return;
    if (!ctx) init();
    if (ctx.state === 'suspended') ctx.resume();
    playing = true;

    // Start texture layers
    var vinyl = createVinylCrackle();
    nodes.vinylProc = vinyl;

    var rain = createRainNoise();
    nodes.rainNoise = rain;
    nodes.rainGain = rain.gain;

    var wobble = createTapeWobble();
    nodes.wobbleLfo = wobble;

    // Reset sequencer
    currentStep = 0;
    currentChordIndex = 0;
    barCount = 0;
    nextBeatTime = ctx.currentTime + 0.05;

    // Start scheduler
    schedulerTimer = setInterval(scheduler, SCHEDULE_INTERVAL);
  }

  function stop() {
    if (!playing) return;
    playing = false;

    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }

    // Fade out master
    if (masterGain) {
      masterGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
    }

    // Cleanup texture nodes after fade
    setTimeout(function () {
      if (nodes.vinylProc) {
        nodes.vinylProc.proc.disconnect();
        nodes.vinylProc = null;
      }
      if (nodes.rainNoise) {
        nodes.rainNoise.proc.disconnect();
        nodes.rainNoise = null;
        nodes.rainGain = null;
      }
      if (nodes.wobbleLfo) {
        nodes.wobbleLfo.lfo.stop();
        nodes.wobbleLfo = null;
      }
      // Reset gain for next start
      if (masterGain) masterGain.gain.value = 0.6;
    }, 2000);
  }

  function setMood(params) {
    if (!params) return;
    var keys = ['intensity', 'valence', 'flow', 'tension', 'creativity'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (params[k] !== undefined) {
        moodTarget[k] = Math.max(0, Math.min(1, params[k]));
      }
    }
  }

  function setVolume(v) {
    if (masterGain) {
      masterGain.gain.linearRampToValueAtTime(
        Math.max(0, Math.min(1, v)),
        ctx.currentTime + 0.1
      );
    }
  }

  function getMood() {
    return {
      intensity: mood.intensity,
      valence: mood.valence,
      flow: mood.flow,
      tension: mood.tension,
      creativity: mood.creativity
    };
  }

  function isPlaying() {
    return playing;
  }

  // ─── Export ───

  window.CafeLofiSynth = {
    init: init,
    start: start,
    stop: stop,
    setMood: setMood,
    setVolume: setVolume,
    getMood: getMood,
    isPlaying: isPlaying
  };
})();
