// CafeAudio — Web Audio sound system for cafe game
// Zero dependencies. All sounds synthesized (no files needed).
(function () {
  'use strict';
  var ctx = null;
  var enabled = true;
  var masterGain = null;

  function ensure() {
    if (ctx) return true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.5;
      masterGain.connect(ctx.destination);
      return true;
    } catch (e) { return false; }
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  // --- Sound generators ---

  function playWalk() {
    if (!ensure() || !enabled) return;
    resume();
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(120 + Math.random() * 40, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.06);
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g); g.connect(masterGain);
    osc.start(t); osc.stop(t + 0.07);
  }

  function playInteract() {
    if (!ensure() || !enabled) return;
    resume();
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(400, t + 0.08);
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(g); g.connect(masterGain);
    osc.start(t); osc.stop(t + 0.1);
  }

  function playCoffee() {
    if (!ensure() || !enabled) return;
    resume();
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.setValueAtTime(1000, t + 0.05);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.2);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g); g.connect(masterGain);
    osc.start(t); osc.stop(t + 0.25);
  }

  function playNoteSent() {
    if (!ensure() || !enabled) return;
    resume();
    var t = ctx.currentTime;
    var bufSize = ctx.sampleRate * 0.12;
    var buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.15;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var flt = ctx.createBiquadFilter();
    flt.type = 'highpass'; flt.frequency.value = 2000;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(flt); flt.connect(g); g.connect(masterGain);
    src.start(t);
  }

  // --- Undertale-style beep speech ---
  // Each speaker gets a different pitch + waveform (Toby Fox's approach)
  var BEEP_PITCHES = {
    'Cruz ☕': 220, 'Cruz': 220,
    '北極同學': 330, '新星小姐': 380, '米拉小姐': 290,
    '參宿先生': 200, '天狼同學': 350,
    '空位': 180, '系統': 260
  };
  var BEEP_WAVEFORMS = {
    'Cruz ☕': 'triangle', 'Cruz': 'triangle',
    '北極同學': 'sine', '新星小姐': 'sawtooth',
    '米拉小姐': 'sawtooth', '參宿先生': 'sine',
    '天狼同學': 'square', '空位': 'triangle', '系統': 'sine'
  };
  var BEEP_JITTER = {
    'Cruz ☕': 5, 'Cruz': 5,
    '北極同學': 10, '新星小姐': 25, '米拉小姐': 15,
    '參宿先生': 8, '天狼同學': 12,
    '空位': 3, '系統': 6
  };
  var DEFAULT_BEEP = 300;
  var lastBeepTime = 0;
  var BEEP_INTERVAL = 55;

  function playBeep(speaker) {
    if (!ensure() || !enabled) return;
    resume();
    var now = Date.now();
    if (now - lastBeepTime < BEEP_INTERVAL) return;
    lastBeepTime = now;
    var t = ctx.currentTime;
    var freq = BEEP_PITCHES[speaker] || DEFAULT_BEEP;
    var waveform = BEEP_WAVEFORMS[speaker] || 'square';
    var jitter = BEEP_JITTER[speaker] || 10;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = waveform;
    osc.frequency.value = freq + (Math.random() - 0.5) * jitter * 2;
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    osc.connect(g); g.connect(masterGain);
    osc.start(t); osc.stop(t + 0.04);
  }

  // ═══════════════════════════════════════════════════════════════
  // 五行聲學流轉引擎 (Elemental Cycling Engine)
  // 💧水(Rain) 🌳木(Bird) 🔥火(Crackle) 🌍土(Hum) ⚙️金(Chime)
  //
  // 水與木互斥：雨大鳥靜，雨停鳥鳴
  // 土永遠托底：65Hz 子宮環境
  // 火恆常微弱：黑膠灰塵
  // 金由互動觸發：已有 playInteract/playCoffee
  //
  // 五行之上是無極。
  // ═══════════════════════════════════════════════════════════════

  // --- Golden Config (Cruz 調音台驗收參數) ---
  var GOLDEN = {
    masterVol: 0.25,
    // 💧 水：Rain (Pink Noise → Lowpass 250Hz)
    rainFreq: 250,       // lowpass cutoff — 悶雨隔玻璃
    rainQ: 0.5,
    rainGain: 0.18,      // base max — 5min cycle peak
    rainCycleMs: 300000,  // 5 分鐘完整週期
    rainFloor: 0.05,     // 雨停最低值
    // 🌳 木：Birdsong (Highpass 2000Hz, stereo pan)
    birdGainMax: 0.15,   // 最大值（雨完全停時）
    birdFreq: 2000,      // highpass cutoff
    birdPanCycle: 8000,  // 左右耳交替 8 秒週期
    // 🔥 火：Vinyl Crackle
    crackleRate: 0.015,
    crackleGain: 0.035,
    crackleFreq: 3000,
    // 🌍 土：Sub Bass Hum
    humFreq: 65,
    humGain: 0.02,
    // Transition
    fadeMs: 8000,         // 水→木過渡時間
  };

  var elemNodes = null;  // all elemental audio nodes
  var elemCycleId = null;

  // --- Pink Noise Generator (Paul Kellet algorithm) ---
  function createPinkNoise() {
    var bufSize = 4096;
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    var proc = ctx.createScriptProcessor(bufSize, 0, 1);
    proc.onaudioprocess = function (e) {
      var out = e.outputBuffer.getChannelData(0);
      for (var i = 0; i < bufSize; i++) {
        var white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    };
    return proc;
  }

  // --- Birdsong Synthesizer (granular chirps) ---
  function spawnBirdChirp(birdGain, panNode) {
    if (!ctx || !elemNodes) return;
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    // Bird chirp: frequency sweep 2500→4000Hz in ~0.08s
    var baseFreq = 2500 + Math.random() * 1500;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq, t);
    osc.frequency.linearRampToValueAtTime(baseFreq + 400 + Math.random() * 800, t + 0.06);
    osc.frequency.linearRampToValueAtTime(baseFreq - 200, t + 0.12);
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    // Random pan position (窗外不同方位)
    panNode.pan.setValueAtTime(-0.6 + Math.random() * 1.2, t);
    osc.connect(g);
    g.connect(panNode);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  function startElementalEngine() {
    if (!ensure() || elemNodes) return;
    masterGain.gain.value = GOLDEN.masterVol;

    // ── 🌍 土 (Earth): 65Hz sub bass — eternal anchor ──
    var humOsc = ctx.createOscillator();
    var humGain = ctx.createGain();
    humOsc.type = 'sine';
    humOsc.frequency.value = GOLDEN.humFreq;
    humGain.gain.value = GOLDEN.humGain;
    humOsc.connect(humGain);
    humGain.connect(masterGain);
    humOsc.start();

    // ── 💧 水 (Water): Pink noise → Lowpass → Gain ──
    var rainNoise = createPinkNoise();
    var rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'lowpass';
    rainFilter.frequency.value = GOLDEN.rainFreq;
    rainFilter.Q.value = GOLDEN.rainQ;
    var rainGain = ctx.createGain();
    rainGain.gain.value = GOLDEN.rainGain;
    rainNoise.connect(rainFilter);
    rainFilter.connect(rainGain);
    rainGain.connect(masterGain);

    // ── 🔥 火 (Fire): Vinyl crackle ──
    var crackleSize = 4096;
    var crackleProc = ctx.createScriptProcessor(crackleSize, 0, 1);
    crackleProc.onaudioprocess = function (e) {
      var out = e.outputBuffer.getChannelData(0);
      for (var i = 0; i < crackleSize; i++) {
        var r = Math.random();
        if (r < GOLDEN.crackleRate * 0.1) {
          // Pop
          out[i] = (Math.random() * 2 - 1) * 0.5;
        } else if (r < GOLDEN.crackleRate) {
          // Crackle
          out[i] = (Math.random() * 2 - 1) * 0.12;
        } else {
          // Floor noise
          out[i] = (Math.random() * 2 - 1) * 0.002;
        }
      }
    };
    var crackleFilter = ctx.createBiquadFilter();
    crackleFilter.type = 'bandpass';
    crackleFilter.frequency.value = GOLDEN.crackleFreq;
    crackleFilter.Q.value = 0.7;
    var crackleGain = ctx.createGain();
    crackleGain.gain.value = GOLDEN.crackleGain;
    crackleProc.connect(crackleFilter);
    crackleFilter.connect(crackleGain);
    crackleGain.connect(masterGain);

    // ── 🌳 木 (Wood): Birdsong — stereo panned chirps ──
    var birdFilter = ctx.createBiquadFilter();
    birdFilter.type = 'highpass';
    birdFilter.frequency.value = GOLDEN.birdFreq;
    var birdGain = ctx.createGain();
    birdGain.gain.value = 0; // starts silent (raining)
    var birdPan = ctx.createStereoPanner();
    birdPan.pan.value = 0;
    birdFilter.connect(birdGain);
    birdGain.connect(birdPan);
    birdPan.connect(masterGain);

    elemNodes = {
      humOsc: humOsc, humGain: humGain,
      rainNoise: rainNoise, rainFilter: rainFilter, rainGain: rainGain,
      crackleProc: crackleProc, crackleFilter: crackleFilter, crackleGain: crackleGain,
      birdFilter: birdFilter, birdGain: birdGain, birdPan: birdPan,
    };

    // ── 五行流轉循環 ──
    // 水的 gain 隨 sin 波動 (5 分鐘週期)
    // 木的 gain = max(0, 0.15 - 水gain * 1.5)
    var birdChirpTimer = 0;
    elemCycleId = setInterval(function () {
      if (!elemNodes) return;
      var t = Date.now();

      // 水：5 分鐘正弦波
      var phase = Math.sin(t / GOLDEN.rainCycleMs * Math.PI * 2);
      // Map sin(-1,1) to (rainFloor, rainGain)
      var range = GOLDEN.rainGain - GOLDEN.rainFloor;
      var currentRain = GOLDEN.rainFloor + (phase + 1) / 2 * range;
      elemNodes.rainGain.gain.value = currentRain;

      // 木：反比連動 — 雨大鳥靜，雨停鳥鳴
      var currentBird = Math.max(0, GOLDEN.birdGainMax - currentRain * 1.5);
      elemNodes.birdGain.gain.value = currentBird;

      // 鳥鳴顆粒：只在 bird gain > 0.03 時觸發
      birdChirpTimer += 100;
      if (currentBird > 0.03 && birdChirpTimer > 2000 + Math.random() * 4000) {
        birdChirpTimer = 0;
        // 1-3 隻鳥連叫
        var count = 1 + Math.floor(Math.random() * 3);
        for (var i = 0; i < count; i++) {
          setTimeout(function () {
            spawnBirdChirp(elemNodes.birdGain, elemNodes.birdPan);
          }, i * (80 + Math.random() * 200));
        }
      }
    }, 100);
  }

  function stopElementalEngine() {
    if (!elemNodes) return;
    if (elemCycleId) { clearInterval(elemCycleId); elemCycleId = null; }
    try { elemNodes.humOsc.stop(); } catch (e) {}
    try { elemNodes.rainNoise.disconnect(); } catch (e) {}
    try { elemNodes.crackleProc.disconnect(); } catch (e) {}
    elemNodes = null;
  }

  // --- Elemental test: force rain→bird transition ---
  function testTransition() {
    if (!elemNodes) return;
    var t = ctx.currentTime;
    var dur = GOLDEN.fadeMs / 1000;
    // Rain: fade down over 8s
    elemNodes.rainGain.gain.cancelScheduledValues(t);
    elemNodes.rainGain.gain.setValueAtTime(GOLDEN.rainGain, t);
    elemNodes.rainGain.gain.linearRampToValueAtTime(GOLDEN.rainFloor, t + dur);
    // Bird: fade up starting at 4s mark
    elemNodes.birdGain.gain.cancelScheduledValues(t);
    elemNodes.birdGain.gain.setValueAtTime(0, t);
    elemNodes.birdGain.gain.linearRampToValueAtTime(0, t + dur * 0.5);
    elemNodes.birdGain.gain.linearRampToValueAtTime(GOLDEN.birdGainMax, t + dur);
    // Spawn chirps during transition
    for (var i = 0; i < 5; i++) {
      setTimeout(function () {
        if (elemNodes) spawnBirdChirp(elemNodes.birdGain, elemNodes.birdPan);
      }, (dur * 0.5 * 1000) + i * 1200);
    }
  }

  // Legacy compatibility aliases
  var ambientNodes = null;
  function startAmbient() { startElementalEngine(); ambientNodes = elemNodes; }
  function stopAmbient() { stopElementalEngine(); ambientNodes = null; }
  function startVinylCrackle() { /* integrated into elemental engine */ }
  function stopVinylCrackle() { /* integrated into elemental engine */ }

  // --- Cafe Impulse Response (wooden room reverb) ---
  // Synthesizes a short IR for intimate wooden cafe feel:
  // RT60 ~0.3s, warm low-mid emphasis, exponential decay.
  var cafeIRBuffer = null;
  function createCafeIR() {
    if (!ctx || cafeIRBuffer) return cafeIRBuffer;
    var sr = ctx.sampleRate;
    var length = Math.floor(sr * 0.4); // 400ms buffer (RT60 ~0.3s)
    var buf = ctx.createBuffer(2, length, sr);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      for (var i = 0; i < length; i++) {
        var t = i / sr;
        // Exponential decay (RT60 ~0.3s → decay rate = 6.9/0.3)
        var envelope = Math.exp(-23.0 * t);
        // Noise burst shaped by envelope
        var noise = Math.random() * 2 - 1;
        // Warm low-mid emphasis: simple 1-pole lowpass at ~1200Hz
        // Approximation via running average with previous sample
        data[i] = noise * envelope * 0.5;
      }
      // Apply 1-pole lowpass for warmth (fc ~1200Hz)
      var rc = 1.0 / (2.0 * Math.PI * 1200);
      var dt = 1.0 / sr;
      var a = dt / (rc + dt);
      for (var i = 1; i < length; i++) {
        data[i] = data[i - 1] + a * (data[i] - data[i - 1]);
      }
      // Slight stereo decorrelation (offset channel 1 by a few samples)
      if (ch === 1) {
        var offset = 17; // prime number of samples for decorrelation
        for (var i = length - 1; i >= offset; i--) {
          data[i] = data[i - offset];
        }
        for (var i = 0; i < offset; i++) data[i] = 0;
      }
    }
    cafeIRBuffer = buf;
    return buf;
  }

  // --- Asynchronous Ambient Reality (AAR) ---
  // Fetches real-world ambient recording, mixes at low volume with synthetic drone.
  // Chain: BufferSource → GainNode(0.2) → ConvolverNode(cafe IR) → masterGain
  // playbackRate=0.8 for dreamy feel. Silent fallback on failure.
  // --- Visit-tier ambient tuning ---
  var TIER_PARAMS = {
    first:     { gain: 0.2,  rate: 0.8  },
    returning: { gain: 0.25, rate: 0.85 },
    regular:   { gain: 0.3,  rate: 0.9  },
    family:    { gain: 0.35, rate: 0.95 }
  };
  var currentTier = 'first';
  function setTier(tier) {
    var p = TIER_PARAMS[tier];
    if (!p) return;
    currentTier = tier;
    if (ambientReal) {
      ambientReal.gain.gain.value = p.gain;
      ambientReal.source.playbackRate.value = p.rate;
    }
  }

  var ambientReal = null; // { source, gain, convolver }
  function loadAsyncAmbience(url) {
    if (!ensure()) return;
    // Time-aware: try hour-specific recording first, fallback to latest
    var hour = new Date().getHours().toString().padStart(2, '0');
    var defaultUrl = url || '/api/cafe-game/assets/ambience_h' + hour + '.mp3';
    var fallbackUrl = '/api/cafe-game/assets/latest_ambience.mp3';
    console.log('☕ Soundscape: trying ' + defaultUrl);
    fetch(defaultUrl).then(function (r) { if (!r.ok) return fetch(fallbackUrl); return r; })
      .then(function (r) {
        if (!r.ok) throw new Error('not found');
        return r.arrayBuffer();
      })
      .then(function (buf) { return ctx.decodeAudioData(buf); })
      .then(function (audioBuf) {
        // Already loaded — skip
        if (ambientReal) return;
        var src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.loop = true;
        var tp = TIER_PARAMS[currentTier] || TIER_PARAMS.first;
        src.playbackRate.value = tp.rate; // tier-aware dreamy speed
        var g = ctx.createGain();
        g.gain.value = tp.gain; // tier-aware volume
        // Convolution reverb: wooden cafe spatial feel
        var conv = ctx.createConvolver();
        conv.buffer = createCafeIR();
        // Dry/wet mix via parallel paths
        var wetGain = ctx.createGain();
        wetGain.gain.value = 0.35; // reverb send level
        var dryGain = ctx.createGain();
        dryGain.gain.value = 0.75; // direct signal
        src.connect(g);
        g.connect(dryGain);
        g.connect(conv);
        conv.connect(wetGain);
        dryGain.connect(masterGain);
        wetGain.connect(masterGain);
        src.start(0);
        ambientReal = { source: src, gain: g, convolver: conv };
      })
      .catch(function () {
        // Silent fallback — synthetic drone only, no error shown
      });
  }

  // ── Piano Rare Event ──
  // Loads real recording or synthesizes fallback melody.
  // pianoPlayed persists across the session via sessionStorage.
  var pianoPlayed = false;
  if (sessionStorage.getItem('cafe_piano_played') === '1') pianoPlayed = true;

  function playPianoEvent(onStart, onEnd) {
    if (!ensure() || pianoPlayed) return;
    pianoPlayed = true;
    sessionStorage.setItem('cafe_piano_played', '1');
    resume();

    // Try loading real recording first
    fetch('/api/cafe-game/assets/piano_fragment.mp3')
      .then(function(r) { if (!r.ok) throw new Error('no file'); return r.arrayBuffer(); })
      .then(function(buf) { return ctx.decodeAudioData(buf); })
      .then(function(audioBuffer) {
        if (onStart) onStart();
        var src = ctx.createBufferSource();
        src.buffer = audioBuffer;
        var g = ctx.createGain();
        // Random 10-20s slice
        var duration = Math.min(10 + Math.random() * 10, audioBuffer.duration);
        var offset = Math.random() * Math.max(0, audioBuffer.duration - duration);
        g.gain.setValueAtTime(0.001, ctx.currentTime);
        g.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 3);
        g.gain.setValueAtTime(0.2, ctx.currentTime + duration - 3);
        g.gain.linearRampToValueAtTime(0.001, ctx.currentTime + duration);
        // Route through convolver for room reverb if available
        if (ambientReal && ambientReal.convolver) {
          var wetG = ctx.createGain(); wetG.gain.value = 0.3;
          var dryG = ctx.createGain(); dryG.gain.value = 0.8;
          src.connect(g);
          g.connect(dryG); dryG.connect(masterGain);
          g.connect(ambientReal.convolver); ambientReal.convolver.connect(wetG); wetG.connect(masterGain);
        } else {
          src.connect(g); g.connect(masterGain);
        }
        src.start(0, offset, duration);
        src.onended = function() { if (onEnd) onEnd(); };
      })
      .catch(function() {
        // Fallback: synthesize simple piano-like melody
        if (onStart) onStart();
        synthesizePianoFallback(onEnd);
      });
  }

  function synthesizePianoFallback(onEnd) {
    // Simple piano-like tones: Bohemian Rhapsody opening notes approximation
    // C4 E4 G4 E4 C4 D4 F4 D4
    var notes = [261.63, 329.63, 392.00, 329.63, 261.63, 293.66, 349.23, 293.66];
    var t = ctx.currentTime;
    var totalDur = 0;
    notes.forEach(function(freq, i) {
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var start = t + i * 1.5;
      g.gain.setValueAtTime(0.001, start);
      g.gain.linearRampToValueAtTime(0.15, start + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, start + 1.2);
      osc.connect(g); g.connect(masterGain);
      osc.start(start); osc.stop(start + 1.3);
      totalDur = start + 1.5 - t;
    });
    setTimeout(function() { if (onEnd) onEnd(); }, totalDur * 1000);
  }

  // ═══════════════════════════════════════════════════════════════
  // 無極轉場 (Wuji Transition)
  // 五行 → 真空 → 無極嗡聲 → 對話介面
  // 無極 → 五行重啟 → 回到吧台
  // ═══════════════════════════════════════════════════════════════

  var wujiNodes = null;   // { drone, droneGain }
  var wujiState = 'five'; // 'five' = 五行, 'void' = 真空過渡, 'wuji' = 無極

  function enterWuji(onVoidReady) {
    if (!ensure() || wujiState !== 'five') return;
    wujiState = 'void';
    resume();
    var t = ctx.currentTime;

    // ── Step 1: 音訊真空 — 0.2 秒內五行全切 ──
    // Kill elemental engine gains
    if (elemNodes) {
      elemNodes.rainGain.gain.cancelScheduledValues(t);
      elemNodes.rainGain.gain.setValueAtTime(elemNodes.rainGain.gain.value, t);
      elemNodes.rainGain.gain.linearRampToValueAtTime(0, t + 0.2);
      elemNodes.birdGain.gain.cancelScheduledValues(t);
      elemNodes.birdGain.gain.linearRampToValueAtTime(0, t + 0.15);
      elemNodes.crackleGain.gain.setValueAtTime(elemNodes.crackleGain.gain.value, t);
      elemNodes.crackleGain.gain.linearRampToValueAtTime(0, t + 0.2);
      elemNodes.humGain.gain.setValueAtTime(elemNodes.humGain.gain.value, t);
      elemNodes.humGain.gain.linearRampToValueAtTime(0, t + 0.3);
    }
    // Kill AAR
    if (ambientReal && ambientReal.gain) {
      ambientReal.gain.gain.setValueAtTime(ambientReal.gain.gain.value, t);
      ambientReal.gain.gain.linearRampToValueAtTime(0, t + 0.2);
    }
    // Pause elemental cycle
    if (elemCycleId) { clearInterval(elemCycleId); elemCycleId = null; }

    // ── Step 2: 太空艙嗡聲 — 極低頻 sine drone ──
    // 0.5 秒後開始，模擬太空艙門關閉
    setTimeout(function () {
      if (wujiState !== 'void') return;
      var drone = ctx.createOscillator();
      var droneGain = ctx.createGain();
      var droneFilter = ctx.createBiquadFilter();
      // 32Hz fundamental + slight detune for organic feel
      drone.type = 'sine';
      drone.frequency.value = 32;
      // Second harmonic via waveshaping for richness
      droneFilter.type = 'lowpass';
      droneFilter.frequency.value = 80;
      droneFilter.Q.value = 2;
      droneGain.gain.setValueAtTime(0.001, ctx.currentTime);
      droneGain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 2);
      drone.connect(droneFilter);
      droneFilter.connect(droneGain);
      droneGain.connect(masterGain);
      drone.start();
      wujiNodes = { drone: drone, droneGain: droneGain, droneFilter: droneFilter };
      wujiState = 'wuji';

      if (onVoidReady) onVoidReady();
    }, 500);
  }

  function exitWuji(onFiveReady) {
    if (!ensure() || wujiState !== 'wuji') return;
    wujiState = 'void';
    var t = ctx.currentTime;

    // ── Fade out drone ──
    if (wujiNodes) {
      wujiNodes.droneGain.gain.setValueAtTime(wujiNodes.droneGain.gain.value, t);
      wujiNodes.droneGain.gain.linearRampToValueAtTime(0, t + 1.5);
      setTimeout(function () {
        try { wujiNodes.drone.stop(); } catch (e) {}
        wujiNodes = null;
      }, 2000);
    }

    // ── 五行重啟 — 水和土先回來，木和火延遲 ──
    setTimeout(function () {
      if (elemNodes) {
        var rt = ctx.currentTime;
        // 土先回（重力錨點）
        elemNodes.humGain.gain.setValueAtTime(0, rt);
        elemNodes.humGain.gain.linearRampToValueAtTime(GOLDEN.humGain, rt + 1);
        // 水次之（雨聲湧入）
        elemNodes.rainGain.gain.setValueAtTime(0, rt);
        elemNodes.rainGain.gain.linearRampToValueAtTime(GOLDEN.rainGain * 0.7, rt + 2);
        // 火最後（黑膠微弱）
        elemNodes.crackleGain.gain.setValueAtTime(0, rt);
        elemNodes.crackleGain.gain.linearRampToValueAtTime(GOLDEN.crackleGain, rt + 3);
        // 重啟五行流轉循環
        var birdChirpTimer = 0;
        elemCycleId = setInterval(function () {
          if (!elemNodes) return;
          var now = Date.now();
          var phase = Math.sin(now / GOLDEN.rainCycleMs * Math.PI * 2);
          var range = GOLDEN.rainGain - GOLDEN.rainFloor;
          var currentRain = GOLDEN.rainFloor + (phase + 1) / 2 * range;
          elemNodes.rainGain.gain.value = currentRain;
          var currentBird = Math.max(0, GOLDEN.birdGainMax - currentRain * 1.5);
          elemNodes.birdGain.gain.value = currentBird;
          birdChirpTimer += 100;
          if (currentBird > 0.03 && birdChirpTimer > 2000 + Math.random() * 4000) {
            birdChirpTimer = 0;
            var count = 1 + Math.floor(Math.random() * 3);
            for (var i = 0; i < count; i++) {
              setTimeout(function () {
                if (elemNodes) spawnBirdChirp(elemNodes.birdGain, elemNodes.birdPan);
              }, i * (80 + Math.random() * 200));
            }
          }
        }, 100);
      }
      // Restore AAR
      if (ambientReal && ambientReal.gain) {
        var tp = TIER_PARAMS[currentTier] || TIER_PARAMS.first;
        ambientReal.gain.gain.setValueAtTime(0, ctx.currentTime);
        ambientReal.gain.gain.linearRampToValueAtTime(tp.gain, ctx.currentTime + 2);
      }
      wujiState = 'five';
      if (onFiveReady) onFiveReady();
    }, 1500);
  }

  window.CafeAudio = {
    init: function () { ensure(); },
    resume: function () { resume(); startAmbient(); loadAsyncAmbience(); },
    playWalk: playWalk,
    playInteract: playInteract,
    playCoffee: playCoffee,
    playNoteSent: playNoteSent,
    playBeep: playBeep,
    setTier: setTier,
    toggle: function () {
      enabled = !enabled;
      if (!enabled) {
        stopAmbient();
        if (ambientReal) ambientReal.gain.gain.value = 0;
      } else {
        startAmbient();
        var tp = TIER_PARAMS[currentTier] || TIER_PARAMS.first;
        if (ambientReal) ambientReal.gain.gain.value = tp.gain;
      }
      return enabled;
    },
    startVinyl: function () { startVinylCrackle(); },
    stopVinyl: function () { stopVinylCrackle(); },
    isEnabled: function () { return enabled; },
    playPianoEvent: playPianoEvent,
    loadAsyncAmbience: loadAsyncAmbience,
    // 五行流轉 API
    testTransition: testTransition,  // 手動觸發雨停→鳥���過渡
    getElementalState: function () {
      if (!elemNodes) return { active: false };
      return {
        active: true,
        rainGain: elemNodes.rainGain.gain.value,
        birdGain: elemNodes.birdGain.gain.value,
        crackleGain: GOLDEN.crackleGain,
        humGain: GOLDEN.humGain,
        masterVol: GOLDEN.masterVol,
      };
    },
    // God Mode: 強制降雨
    forceStorm: function () {
      if (!elemNodes || !ctx) return;
      var t = ctx.currentTime;
      elemNodes.rainGain.gain.cancelScheduledValues(t);
      elemNodes.rainGain.gain.setValueAtTime(elemNodes.rainGain.gain.value, t);
      elemNodes.rainGain.gain.linearRampToValueAtTime(GOLDEN.rainGain, t + 2);
      elemNodes.birdGain.gain.cancelScheduledValues(t);
      elemNodes.birdGain.gain.linearRampToValueAtTime(0, t + 1.5);
    },
    // 無極轉場 API
    enterWuji: enterWuji,     // 五行→真空→無極嗡聲
    exitWuji: exitWuji,       // 無極→五行重啟
    getWujiState: function () { return wujiState; },
    fadeOut: function () {
      if (!ctx || !masterGain) return;
      masterGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 3);
      if (ambientReal && ambientReal.gain) {
        ambientReal.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 3);
      }
    }
  };
})();
