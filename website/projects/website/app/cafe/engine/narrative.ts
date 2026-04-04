// ── Narrative (敘事與 UX 體驗官) ─────────────────────────────
import type { NarrativeScript } from './types';
import { DIALOGUE_POOL } from './dialogues';

// playTyping / playClick injected at boot time
type AudioFns = { playTyping: () => void; playClick: () => void };

const Narrative = {
  isTyping: false,
  timeoutId: null as ReturnType<typeof setTimeout> | null,
  _audio: null as AudioFns | null,
  _promptCount: 0,

  scripts: {
    init: { name: 'System', text: '指紋比對完成。歡迎回到地球 Online 存檔點。' },
    cruz: {
      name: 'Cruz',
      text: '你換了一副面孔... 但你點黑咖啡時猶豫的那兩秒鐘，我認得。歡迎回來。',
    },
    cup: {
      name: 'Cruz',
      text: '這只杯子放很久了，金色裂痕還是很亮。喝吧，溫度剛剛好。',
    },
    journal: {
      name: 'System',
      text: '[ 動作：你翻開了手帳本 ]\n上一頁的墨水已經有點褪色了。你要寫下今天的裝備清單嗎？',
    },
  } as Record<string, NarrativeScript>,

  init(audioFns: AudioFns) {
    this._audio = audioFns;

    // Load prompt count from localStorage
    try {
      this._promptCount = parseInt(localStorage.getItem('cafe_prompt_count') || '0', 10);
    } catch { this._promptCount = 0; }

    // Click-to-dismiss: tap dialogue box to close immediately
    const box = document.getElementById('dialogue-box');
    box?.addEventListener('click', () => {
      if (!this.isTyping) this.dismiss();
    });
  },

  /** Get progressive placeholder based on prompt count */
  getPlaceholder(): string {
    const c = this._promptCount;
    if (c < 2) return '說點什麼...';
    if (c < 4) return '試試看給我一個指令...';
    return '> _';
  },

  /** Increment prompt count and persist */
  bumpPromptCount() {
    this._promptCount++;
    try { localStorage.setItem('cafe_prompt_count', String(this._promptCount)); } catch { /* */ }
  },

  /** Should we show CLI-style response decoration? */
  shouldLeakCLI(): boolean {
    return this._promptCount >= 5 && Math.random() < 0.4;
  },

  dismiss() {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    document.getElementById('dialogue-box')?.classList.remove('active');
    document.getElementById('base-layer')?.classList.remove('dimmed');
  },

  trigger(targetId: string) {
    if (this.isTyping) return;

    // Priority: dynamic override (boot.ts sets init/forceclose) > random pool
    let data = this.scripts[targetId];
    if (data) {
      delete this.scripts[targetId]; // one-shot, next time use pool
    } else if (DIALOGUE_POOL[targetId]) {
      const pool = DIALOGUE_POOL[targetId];
      data = pool[Math.floor(Math.random() * pool.length)];
    }
    if (!data) return;

    this._audio?.playClick();

    const base = document.getElementById('base-layer');
    if (targetId === 'journal') base?.classList.add('dimmed');
    else base?.classList.remove('dimmed');

    const box = document.getElementById('dialogue-box');
    const nEl = document.getElementById('d-name');
    const tEl = document.getElementById('d-text');
    if (!box || !nEl || !tEl) return;

    box.classList.add('active');
    nEl.innerText = data.name;
    this.typewriter(tEl, data.text, this.shouldLeakCLI());
  },

  typewriter(el: HTMLElement, text: string, cliLeak = false) {
    this.isTyping = true;
    el.textContent = '';

    // CLI leak: show "> running..." prefix first
    if (cliLeak) {
      el.textContent = '> running...';
      setTimeout(() => {
        el.textContent = '';
        this._typeInner(el, text, cliLeak);
      }, 800);
    } else {
      this._typeInner(el, text, false);
    }
  },

  _typeInner(el: HTMLElement, text: string, cliLeak: boolean) {
    let i = 0;
    const suffix = cliLeak ? ['\n\n[exit code: 0]', '\n\n✓ prompt accepted', ''][Math.floor(Math.random() * 3)] : '';

    const fullText = text + suffix;
    const type = () => {
      if (i < fullText.length) {
        el.textContent += fullText.charAt(i);
        this._audio?.playTyping();
        i++;
        setTimeout(type, 30 + Math.random() * 40);
      } else {
        this.isTyping = false;
        this.autoDismiss();
      }
    };
    type();
  },

  autoDismiss() {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(() => {
      document.getElementById('dialogue-box')?.classList.remove('active');
      document.getElementById('base-layer')?.classList.remove('dimmed');
    }, 8000);
  },
};

export default Narrative;
