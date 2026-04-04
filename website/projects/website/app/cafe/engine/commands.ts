// ── Commands (隱藏 Slash Commands) ─────────────────────────────
import { DIALOGUE_POOL } from './dialogues';

type CommandHandler = (args: string) => void;

// Scroll library reference (same as notebook.ts)
const SCROLL_LIBRARY = [
  '加薪談判的護盾',
  '婉拒加班的結界',
  '蘇格拉底的手術刀',
  '叛逆的點子風暴',
  '會議記錄壓縮術',
  '長文精華萃取術',
  '簡報骨架鍛造術',
  '費曼學習法啟動',
];

function _spData() {
  try { return JSON.parse(localStorage.getItem('cafe_soulprint') || '{}'); }
  catch { return {}; }
}

function _saveSp(data: Record<string, unknown>) {
  try { localStorage.setItem('cafe_soulprint', JSON.stringify(data)); }
  catch { /* */ }
}

function _showDialogue(name: string, text: string) {
  const box = document.getElementById('dialogue-box');
  const nEl = document.getElementById('d-name');
  const tEl = document.getElementById('d-text');
  if (!box || !nEl || !tEl) return;
  box.classList.add('active');
  nEl.innerText = name;
  tEl.textContent = '';
  // Quick typewriter
  let i = 0;
  const type = () => {
    if (i < text.length) {
      tEl.textContent += text.charAt(i);
      i++;
      setTimeout(type, 20 + Math.random() * 20);
    } else {
      setTimeout(() => box.classList.remove('active'), 8000);
    }
  };
  type();
}

function _bumpExplorer() {
  const sp = _spData();
  if (!sp.personality_signals) sp.personality_signals = {};
  sp.personality_signals.explorer = (sp.personality_signals.explorer || 0) + 1;
  _saveSp(sp);
}

const Commands = {
  _handlers: {} as Record<string, CommandHandler>,

  init() {
    this._handlers = {
      '/help': () => {
        _bumpExplorer();
        _showDialogue('System', [
          '你找到了秘密入口。',
          '',
          '可用指令：',
          '  /help   — 你正在看的這個',
          '  /mood   — Cruz 現在的狀態',
          '  /whoami — 你的靈魂指紋',
          '  /brew   — 隨機抽一個卷軸',
          '',
          '更多指令，等你發現。',
        ].join('\n'));
      },

      '/mood': () => {
        _bumpExplorer();
        fetch('/cafe-game/data/ambient-state.json')
          .then(r => r.ok ? r.json() : null)
          .then(state => {
            if (!state) {
              _showDialogue('System', '無法取得老闆的狀態。也許他不在線上。');
              return;
            }
            const moodLabels: Record<string, string> = {
              busy: '忙碌中',
              rest: '休息中',
              deep_work: '深度工作',
              teaching: '教學中',
              present: '在這裡',
            };
            _showDialogue('System', [
              `老闆狀態：${moodLabels[state.mood] || state.mood}`,
              `正在做：${state.doing || '—'}`,
              `地點：${state.where || '—'}`,
              state.updated_at ? `更新：${new Date(state.updated_at).toLocaleString('zh-TW')}` : '',
            ].filter(Boolean).join('\n'));
          })
          .catch(() => _showDialogue('System', '連線失敗。'));
      },

      '/whoami': () => {
        _bumpExplorer();
        const sp = _spData();
        const sig = sp.personality_signals || {};
        const keys = ['action', 'analysis', 'empathy', 'inspiration', 'influence', 'explorer'];
        const labels = ['行動', '分析', '共感', '靈感', '影響', '探索'];
        const vals = keys.map(k => (sig[k] as number) || 0);
        const maxVal = Math.max(...vals, 1);

        const bars = keys.map((k, i) => {
          const v = vals[i];
          const bar = '█'.repeat(Math.round((v / maxVal) * 10)) || '░';
          return `  ${labels[i]}  ${bar}  ${v}`;
        });

        _showDialogue('System', [
          `旅人 #${(sp.visit_count || 0)}`,
          `連續 ${sp.visit_streak || 0} 天`,
          '',
          ...bars,
        ].join('\n'));
      },

      '/brew': () => {
        _bumpExplorer();
        const scroll = SCROLL_LIBRARY[Math.floor(Math.random() * SCROLL_LIBRARY.length)];
        _showDialogue('Cruz', `今天的卷軸是——\n\n「${scroll}」\n\n有些咒語需要時間才會生效。`);
      },
    };
  },

  /** Returns true if input was handled as a command */
  execute(input: string): boolean {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed.startsWith('/')) return false;

    const cmd = trimmed.split(/\s+/)[0];
    const args = trimmed.slice(cmd.length).trim();
    const handler = this._handlers[cmd];

    if (handler) {
      handler(args);
      return true;
    }

    // Unknown command
    _showDialogue('System', `command not found: ${cmd}. Try /help`);
    return true;
  },
};

export default Commands;
