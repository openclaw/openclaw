/**
 * CafeSoundscape — Corpus-Based Concatenative Synthesis (CBCS) Engine
 * Dynamically selects and crossfades audio units based on visitor behavior state.
 * Falls back silently if no manifest or units are available (audio.js ambient still works).
 */
(function () {
  'use strict';

  var MANIFEST_URL = '/api/cafe-game/assets/soundscape_manifest.json';
  var UNIT_BASE = '/api/cafe-game/assets/units/';
  var KEYNOTE_INTERVAL_MIN = 60;   // seconds
  var KEYNOTE_INTERVAL_MAX = 90;
  var SIGNAL_INTERVAL_MIN = 30;
  var SIGNAL_INTERVAL_MAX = 120;
  var SOUNDMARK_MIN_SESSION = 600; // 10 minutes in seconds
  var CROSSFADE_DURATION = 3;      // seconds

  // ── State ─────────────────────────────────────────────────────
  var manifest = null;
  var ctx = null;             // AudioContext
  var masterGain = null;
  var keynoteGainA = null;
  var keynoteGainB = null;
  var signalGain = null;
  var soundmarkGain = null;
  var activeKeynote = 'A';   // which buffer is currently playing
  var keynoteSourceA = null;
  var keynoteSourceB = null;
  var keynoteTimer = null;
  var signalTimer = null;
  var soundmarkFired = false;
  var sessionStartTime = Date.now();
  var currentHour = new Date().getHours();
  var currentTags = [];
  var bufferCache = {};       // file -> AudioBuffer
  var initialized = false;
  var running = false;

  // ── Target Feature Profiles ───────────────────────────────────
  // Each profile defines ideal centroid, rms, and signal probability
  var PROFILES = {
    NIGHT_OWL:            { centroid: 800,  rms: 0.002, signalProb: 0.1,  allowSoundmark: false },
    DOOMSCROLLER:         { centroid: 600,  rms: 0.001, signalProb: 0.05, allowSoundmark: false },
    COMMUTER:             { centroid: 2500, rms: 0.03,  signalProb: 0.4,  allowSoundmark: false },
    INTENTIONAL_WANDERER: { centroid: 1800, rms: 0.01,  signalProb: 0.25, allowSoundmark: true  },
    SILENT_WATCHER:       { centroid: 900,  rms: 0.002, signalProb: 0.05, allowSoundmark: false },
    DEFAULT:              { centroid: 1500, rms: 0.008, signalProb: 0.2,  allowSoundmark: true  }
  };

  function getTargetProfile(tags) {
    if (!tags || tags.length === 0) return PROFILES.DEFAULT;
    // Priority: first matched tag wins
    var priority = ['NIGHT_OWL', 'DOOMSCROLLER', 'COMMUTER', 'INTENTIONAL_WANDERER', 'SILENT_WATCHER'];
    for (var i = 0; i < priority.length; i++) {
      for (var t = 0; t < tags.length; t++) {
        if (tags[t] === priority[i] && PROFILES[tags[t]]) {
          return PROFILES[tags[t]];
        }
      }
    }
    return PROFILES.DEFAULT;
  }

  // ── Unit Selection (Euclidean distance in feature space) ──────
  function selectUnit(pool, targetCentroid, targetRms, hourWeight) {
    if (!manifest || !manifest.units) return null;
    var candidates = [];
    for (var i = 0; i < manifest.units.length; i++) {
      if (manifest.units[i].pool === pool) {
        candidates.push(manifest.units[i]);
      }
    }
    if (candidates.length === 0) return null;

    var hw = hourWeight || 1.0;
    var best = null;
    var bestDist = Infinity;

    for (var j = 0; j < candidates.length; j++) {
      var u = candidates[j];
      // Normalize: centroid range ~0-5000, rms ~0-0.1, hour ~0-23
      var dc = (u.centroid - targetCentroid) / 5000;
      var dr = (u.rms - targetRms) / 0.1;
      var dh = Math.min(Math.abs(u.hour - currentHour), 24 - Math.abs(u.hour - currentHour)) / 12;
      var dist = Math.sqrt(dc * dc + dr * dr + (dh * hw) * (dh * hw));
      if (dist < bestDist) {
        bestDist = dist;
        best = u;
      }
    }
    return best;
  }

  // ── Audio Buffer Loading ──────────────────────────────────────
  function loadBuffer(file, cb) {
    if (bufferCache[file]) { cb(bufferCache[file]); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', UNIT_BASE + file, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function () {
      if (xhr.status !== 200) { cb(null); return; }
      ctx.decodeAudioData(xhr.response, function (buffer) {
        bufferCache[file] = buffer;
        cb(buffer);
      }, function () { cb(null); });
    };
    xhr.onerror = function () { cb(null); };
    xhr.send();
  }

  // ── Crossfade Playback ────────────────────────────────────────
  function playKeynote(unit) {
    if (!unit || !ctx) return;
    loadBuffer(unit.file, function (buffer) {
      if (!buffer) return;
      var now = ctx.currentTime;
      var newSource = ctx.createBufferSource();
      newSource.buffer = buffer;
      newSource.loop = true;

      if (activeKeynote === 'A') {
        // Fade out A, fade in B
        newSource.connect(keynoteGainB);
        keynoteGainB.gain.setValueAtTime(0, now);
        keynoteGainB.gain.linearRampToValueAtTime(0.6, now + CROSSFADE_DURATION);
        if (keynoteSourceA) {
          keynoteGainA.gain.setValueAtTime(keynoteGainA.gain.value, now);
          keynoteGainA.gain.linearRampToValueAtTime(0, now + CROSSFADE_DURATION);
          try { setTimeout(function () { try { keynoteSourceA.stop(); } catch (e) {} }, CROSSFADE_DURATION * 1000 + 200); } catch (e) {}
        }
        newSource.start(0);
        keynoteSourceB = newSource;
        activeKeynote = 'B';
      } else {
        // Fade out B, fade in A
        newSource.connect(keynoteGainA);
        keynoteGainA.gain.setValueAtTime(0, now);
        keynoteGainA.gain.linearRampToValueAtTime(0.6, now + CROSSFADE_DURATION);
        if (keynoteSourceB) {
          keynoteGainB.gain.setValueAtTime(keynoteGainB.gain.value, now);
          keynoteGainB.gain.linearRampToValueAtTime(0, now + CROSSFADE_DURATION);
          try { setTimeout(function () { try { keynoteSourceB.stop(); } catch (e) {} }, CROSSFADE_DURATION * 1000 + 200); } catch (e) {}
        }
        newSource.start(0);
        keynoteSourceA = newSource;
        activeKeynote = 'A';
      }
    });
  }

  function playSignal(unit) {
    if (!unit || !ctx) return;
    loadBuffer(unit.file, function (buffer) {
      if (!buffer) return;
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(signalGain);
      var now = ctx.currentTime;
      signalGain.gain.setValueAtTime(0, now);
      signalGain.gain.linearRampToValueAtTime(0.3, now + 0.5);
      signalGain.gain.linearRampToValueAtTime(0, now + buffer.duration);
      source.start(0);
    });
  }

  function playSoundmark(unit) {
    if (!unit || !ctx || soundmarkFired) return;
    soundmarkFired = true;
    loadBuffer(unit.file, function (buffer) {
      if (!buffer) return;
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(soundmarkGain);
      var now = ctx.currentTime;
      soundmarkGain.gain.setValueAtTime(0, now);
      soundmarkGain.gain.linearRampToValueAtTime(0.2, now + 1.0);
      soundmarkGain.gain.linearRampToValueAtTime(0, now + buffer.duration);
      source.start(0);
    });
  }

  // ── Scheduling ────────────────────────────────────────────────
  function randBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function scheduleNextKeynote() {
    var delay = randBetween(KEYNOTE_INTERVAL_MIN, KEYNOTE_INTERVAL_MAX) * 1000;
    keynoteTimer = setTimeout(function () {
      if (!running) return;
      var profile = getTargetProfile(currentTags);
      var unit = selectUnit('keynote', profile.centroid, profile.rms, 2.0);
      playKeynote(unit);
      scheduleNextKeynote();
    }, delay);
  }

  function scheduleNextSignal() {
    var profile = getTargetProfile(currentTags);
    var delay = randBetween(SIGNAL_INTERVAL_MIN, SIGNAL_INTERVAL_MAX) * 1000;
    signalTimer = setTimeout(function () {
      if (!running) return;
      var prof = getTargetProfile(currentTags);
      if (Math.random() < prof.signalProb) {
        var unit = selectUnit('signal', prof.centroid, prof.rms, 1.0);
        playSignal(unit);
      }
      scheduleNextSignal();
    }, delay);
  }

  function checkSoundmark() {
    if (soundmarkFired) return;
    var elapsed = (Date.now() - sessionStartTime) / 1000;
    if (elapsed < SOUNDMARK_MIN_SESSION) return;
    var profile = getTargetProfile(currentTags);
    if (!profile.allowSoundmark) return;
    var unit = selectUnit('soundmark', profile.centroid, profile.rms, 1.0);
    playSoundmark(unit);
  }

  // ── Audio Context Setup ───────────────────────────────────────
  function ensureContext() {
    if (ctx) return true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.5;
      masterGain.connect(ctx.destination);

      keynoteGainA = ctx.createGain();
      keynoteGainA.gain.value = 0;
      keynoteGainA.connect(masterGain);

      keynoteGainB = ctx.createGain();
      keynoteGainB.gain.value = 0;
      keynoteGainB.connect(masterGain);

      signalGain = ctx.createGain();
      signalGain.gain.value = 0;
      signalGain.connect(masterGain);

      soundmarkGain = ctx.createGain();
      soundmarkGain.gain.value = 0;
      soundmarkGain.connect(masterGain);

      return true;
    } catch (e) {
      return false;
    }
  }

  // ── Manifest Loading ──────────────────────────────────────────
  function loadManifest(cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', MANIFEST_URL, true);
    xhr.responseType = 'json';
    xhr.onload = function () {
      if (xhr.status === 200 && xhr.response && xhr.response.units) {
        cb(xhr.response);
      } else {
        cb(null);
      }
    };
    xhr.onerror = function () { cb(null); };
    xhr.send();
  }

  // ── Start Engine ──────────────────────────────────────────────
  function start() {
    if (running) return;
    if (!ensureContext()) return;
    running = true;

    // Resume context if suspended (requires user gesture)
    if (ctx.state === 'suspended') {
      var resumeCtx = function () {
        ctx.resume();
        document.removeEventListener('click', resumeCtx);
        document.removeEventListener('touchstart', resumeCtx);
      };
      document.addEventListener('click', resumeCtx, { once: true });
      document.addEventListener('touchstart', resumeCtx, { once: true });
    }

    // Start keynote immediately
    var profile = getTargetProfile(currentTags);
    var firstKeynote = selectUnit('keynote', profile.centroid, profile.rms, 2.0);
    if (firstKeynote) {
      playKeynote(firstKeynote);
    }

    // Schedule layers
    scheduleNextKeynote();
    scheduleNextSignal();

    // Periodically check soundmark eligibility
    var soundmarkCheck = setInterval(function () {
      if (!running) { clearInterval(soundmarkCheck); return; }
      checkSoundmark();
    }, 60000);
  }

  // ── Public API ────────────────────────────────────────────────
  window.CafeSoundscape = {
    init: function () {
      if (initialized) return;
      initialized = true;

      // Read current behavior
      if (window.CafeBehavior && window.CafeBehavior.classify) {
        currentTags = window.CafeBehavior.classify();
      }
      currentHour = new Date().getHours();

      loadManifest(function (m) {
        if (!m) {
          // No manifest — degrade silently
          console.log('☕ Soundscape: no manifest, falling back to ambient.');
          return;
        }
        manifest = m;
        console.log('☕ Soundscape: loaded ' + m.units.length + ' units.');
        start();
      });
    },

    updateBehavior: function (tags) {
      if (!tags) return;
      currentTags = tags;
      currentHour = new Date().getHours();
    },

    setHour: function (h) {
      currentHour = h;
    },

    getStatus: function () {
      return {
        initialized: initialized,
        running: running,
        unitsLoaded: manifest ? manifest.units.length : 0,
        activeKeynote: activeKeynote,
        currentTags: currentTags,
        currentHour: currentHour,
        soundmarkFired: soundmarkFired,
        sessionSeconds: Math.round((Date.now() - sessionStartTime) / 1000),
        cachedBuffers: Object.keys(bufferCache).length
      };
    }
  };
})();
