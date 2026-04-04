// ── Cinematographer (光學與微塵工程師) ────────────────────────
import type { AmbientState } from './types';

const MOOD_CSS: Record<string, { brightness: number; warmth: string; dust: number }> = {
  busy:      { brightness: 0.65, warmth: 'sepia(0.08)', dust: 12 },
  rest:      { brightness: 0.55, warmth: 'sepia(0.12)', dust: 10 },
  deep_work: { brightness: 0.85, warmth: 'sepia(0.03)', dust: 25 },
  teaching:  { brightness: 0.9,  warmth: 'sepia(0.05)', dust: 28 },
  present:   { brightness: 1.0,  warmth: 'sepia(0)',    dust: 30 },
};

const Cinematographer = {
  baseLayer: null as HTMLElement | null,
  cursor: null as HTMLElement | null,
  _isBooted: () => false, // will be replaced by boot coordinator
  _ambientInterval: null as ReturnType<typeof setInterval> | null,
  _currentMood: 'present' as string,

  init(isBootedFn: () => boolean) {
    this._isBooted = isBootedFn;
    this.baseLayer = document.getElementById('base-layer');
    this.cursor = document.getElementById('cursor-follower');
    this.initDust();
    this.initParallaxAndCursor();
    this._applyVisitorAmbient();
    this._applyTimeOfDay();
  },

  initDust() {
    const container = document.getElementById('dust-container');
    if (!container) return;
    // Miyazaki: seasonal dust color
    const month = new Date().getMonth();
    const dustColor = month <= 2 ? 'rgba(200,220,255,0.4)' :
                      month <= 5 ? 'rgba(255,230,180,0.5)' :
                      month <= 8 ? 'rgba(255,200,150,0.5)' :
                                   'rgba(180,200,230,0.4)';
    const dustGlow = month <= 2 ? 'rgba(200,220,255,0.6)' :
                     month <= 5 ? 'rgba(255,230,180,0.6)' :
                     month <= 8 ? 'rgba(255,200,150,0.6)' :
                                  'rgba(180,200,230,0.6)';
    for (let i = 0; i < 30; i++) {
      const mote = document.createElement('div');
      mote.className = 'dust-mote';
      const size = 1 + Math.random() * 2;
      mote.style.width = `${size}px`;
      mote.style.height = `${size}px`;
      mote.style.background = dustColor;
      mote.style.boxShadow = `0 0 6px ${dustGlow}`;
      mote.style.left = `${Math.random() * 100}vw`;
      mote.style.top = `${50 + Math.random() * 50}vh`;
      mote.style.animationDuration = `${10 + Math.random() * 15}s`;
      mote.style.animationDelay = `${Math.random() * 10}s`;
      container.appendChild(mote);
    }
  },

  initParallaxAndCursor() {
    const hitboxes = document.querySelectorAll('.hitbox');

    document.addEventListener('mousemove', (e) => {
      if (!this._isBooted()) return;
      const x = e.clientX;
      const y = e.clientY;

      if (this.cursor) {
        this.cursor.style.left = `${x}px`;
        this.cursor.style.top = `${y}px`;
      }

      const moveX = (x - window.innerWidth / 2) / 70;
      const moveY = (y - window.innerHeight / 2) / 70;
      if (this.baseLayer && this.baseLayer.classList.contains('awake')) {
        this.baseLayer.style.transition = 'filter 1s ease';
        this.baseLayer.style.transform = `translate(${-moveX}px, ${-moveY}px) scale(1.04)`;
      }
    });

    hitboxes.forEach((box) => {
      box.addEventListener('mouseenter', () => this.cursor?.classList.add('magnetic'));
      box.addEventListener('mouseleave', () => this.cursor?.classList.remove('magnetic'));
    });

    // Touch drag for mobile "look around"
    let touchStartX = 0;
    let touchStartY = 0;
    document.addEventListener(
      'touchstart',
      (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      },
      { passive: true },
    );
    document.addEventListener(
      'touchmove',
      (e) => {
        if (!this._isBooted() || !this.baseLayer?.classList.contains('awake')) return;
        const dx = (e.touches[0].clientX - touchStartX) / 8;
        const dy = (e.touches[0].clientY - touchStartY) / 8;
        const clampX = Math.max(-15, Math.min(15, dx));
        const clampY = Math.max(-10, Math.min(10, dy));
        this.baseLayer.style.transition = 'filter 1s ease';
        this.baseLayer.style.transform = `translate(${clampX}px, ${clampY}px) scale(1.04)`;
      },
      { passive: true },
    );
    document.addEventListener('touchend', () => {
      if (this.baseLayer?.classList.contains('awake')) {
        this.baseLayer.style.transition = 'transform 0.8s ease, filter 1s ease';
        this.baseLayer.style.transform = 'translate(0,0) scale(1.04)';
      }
    });
  },

  // ── Ambient State (感知 Cruz 即時狀態) ────────────────────
  startAmbientPoll() {
    this._applyAmbient(); // first fetch immediately
    this._ambientInterval = setInterval(() => this._applyAmbient(), 60_000); // poll every 60s
  },

  _applyAmbient() {
    fetch('/cafe-game/data/ambient-state.json')
      .then(r => r.ok ? r.json() as Promise<AmbientState> : null)
      .then(state => {
        if (!state?.mood || state.mood === this._currentMood) return;
        this._currentMood = state.mood;
        this._transitionMood(state.mood);

        // Show ambient status whisper
        const whisper = document.getElementById('ambient-whisper');
        if (whisper) {
          const labels: Record<string, string> = {
            busy: '老闆正在開會⋯ 咖啡廳安靜下來了',
            rest: '老闆下班了。燈光調暗，享受寧靜',
            deep_work: '老闆正在專注開發中',
            teaching: '老闆正在上課，靈感在流動',
            present: '老闆在這裡',
          };
          whisper.textContent = labels[state.mood] || '';
          whisper.style.opacity = '1';
          setTimeout(() => { whisper.style.opacity = '0'; }, 8000);
        }
      })
      .catch(() => {}); // silent fail
  },

  _transitionMood(mood: string) {
    const cfg = MOOD_CSS[mood] || MOOD_CSS.present;
    if (!this.baseLayer?.classList.contains('awake')) return;

    // Smooth brightness/warmth transition
    this.baseLayer.style.transition = 'filter 3s ease';
    this.baseLayer.style.filter = `brightness(${cfg.brightness}) ${cfg.warmth}`;

    // Adjust dust density
    const container = document.getElementById('dust-container');
    if (container) {
      const motes = container.querySelectorAll('.dust-mote');
      motes.forEach((m, i) => {
        (m as HTMLElement).style.opacity = i < cfg.dust ? '1' : '0';
      });
    }

    // Dim/brighten person blur based on mood
    const personBlur = document.getElementById('person-blur');
    if (personBlur) {
      personBlur.style.transition = 'opacity 3s ease';
      personBlur.style.opacity = mood === 'busy' || mood === 'rest' ? '0.8' : '0.4';
    }
  },

  // ── Alan Kay: Visitor Ambient Layer ──
  _applyVisitorAmbient() {
    let sp: Record<string, unknown> = {};
    try { sp = JSON.parse(localStorage.getItem('cafe_soulprint') || '{}'); } catch { /* */ }
    const visits = (sp.visit_count as number) || 0;
    const streak = (sp.visit_streak as number) || 0;
    const dustContainer = document.getElementById('dust-container');
    const ambientLight = document.getElementById('ambient-light');

    if (visits < 3 && ambientLight) {
      // New visitor: warmer, brighter dust
      ambientLight.style.opacity = '1.2';
    }
    if (visits > 10 && dustContainer) {
      // Old friend: gold-tinted halo
      const halo = document.createElement('div');
      halo.id = 'visitor-halo';
      halo.style.cssText = 'position:fixed;bottom:0;left:0;width:30vw;height:30vh;background:radial-gradient(ellipse at bottom left,rgba(212,163,115,0.06) 0%,transparent 70%);pointer-events:none;z-index:3';
      document.body.appendChild(halo);
    }
    if (streak > 5 && this.baseLayer) {
      // Streak bonus: slightly brighter
      this.baseLayer.dataset.visitorBoost = '0.05';
    }
  },

  // ── Miyazaki: Time-of-Day Light Cycle ──
  _applyTimeOfDay() {
    const hour = new Date().getHours();
    const ambientLight = document.getElementById('ambient-light');
    const windowLight = document.getElementById('window-light');

    // Time slots: [saturate, hue-rotate, ambientOpacity, ambientColor, windowOpacity]
    type TimeSlot = { sat: number; hue: number; aOp: number; aColor: string; wOp: number };
    const slots: Record<string, TimeSlot> = {
      night:   { sat: 0.6,  hue: -10, aOp: 0.2, aColor: 'rgba(255,180,100,0.08)', wOp: 0 },
      dawn:    { sat: 0.85, hue: 0,   aOp: 0.5, aColor: 'rgba(200,220,255,0.10)', wOp: 0.6 },
      morning: { sat: 1.0,  hue: 0,   aOp: 0.8, aColor: 'rgba(255,214,153,0.12)', wOp: 1 },
      noon:    { sat: 1.05, hue: 5,   aOp: 0.9, aColor: 'rgba(255,200,120,0.14)', wOp: 0.8 },
      afternoon: { sat: 0.9, hue: 10, aOp: 0.7, aColor: 'rgba(255,160,80,0.12)',  wOp: 0.5 },
      dusk:    { sat: 0.7,  hue: 15,  aOp: 0.5, aColor: 'rgba(255,120,60,0.10)',  wOp: 0.15 },
      evening: { sat: 0.6,  hue: -5,  aOp: 0.3, aColor: 'rgba(255,180,100,0.08)', wOp: 0 },
    };

    const slot = hour < 6  ? slots.night :
                 hour < 9  ? slots.dawn :
                 hour < 12 ? slots.morning :
                 hour < 15 ? slots.noon :
                 hour < 18 ? slots.afternoon :
                 hour < 21 ? slots.dusk : slots.evening;

    // Apply to base-layer via CSS custom properties (won't fight brightness)
    if (this.baseLayer) {
      this.baseLayer.style.setProperty('--tod-saturate', `${slot.sat}`);
      this.baseLayer.style.setProperty('--tod-hue', `${slot.hue}deg`);
    }
    if (ambientLight) {
      ambientLight.style.background = `radial-gradient(circle at center, ${slot.aColor} 0%, transparent 60%)`;
      ambientLight.style.opacity = `${slot.aOp}`;
    }
    if (windowLight) {
      windowLight.style.opacity = `${slot.wOp}`;
    }
  },
};

export default Cinematographer;
