// ── Notebook (手帳本 — Frosted Glass Panel) ───────────────────

type ScrollEntry = { title: string; hint: string; unlockAt: number };

type CreatorStateTimeline = { hour: number; state: string; vibe?: string; commits?: string[]; intensity?: number };
type CreatorState = {
  date: string;
  generated_at?: string;
  dominant_mood?: string;
  summary_vibe: string;
  timeline?: CreatorStateTimeline[];
  fragments?: Array<{ trigger: string; response: string; mood?: string }>;
};

function _spData() {
  try { return JSON.parse(localStorage.getItem('cafe_soulprint') || '{}'); }
  catch { return {}; }
}
function _spVisits(): number { return _spData().visit_count ?? 0; }

const SCROLL_LIBRARY: ScrollEntry[] = [
  { title: '加薪談判的護盾', hint: '加薪不是求人，是讓事實替你說話。', unlockAt: 0 },
  { title: '婉拒加班的結界', hint: '最強的防禦，是一個不需要解釋的「不」。', unlockAt: 3 },
  { title: '蘇格拉底的手術刀', hint: '真正的智慧不在於知道答案，而在於知道該問什麼。', unlockAt: 0 },
  { title: '叛逆的點子風暴', hint: '好點子從不在舒適區裡誕生。', unlockAt: 5 },
  { title: '會議記錄壓縮術', hint: '資訊的價值不在量，在密度。', unlockAt: 0 },
  {
    title: '長文精華萃取術',
    hint: '讀完一本書的價值，在於你能用一句話說清楚它。',
    unlockAt: 7,
  },
  {
    title: '簡報骨架鍛造術',
    hint: '好的簡報不是塞資訊，是帶人走一趟旅程。',
    unlockAt: 3,
  },
  {
    title: '費曼學習法啟動',
    hint: '真正理解一件事，才能用12歲小孩也聽得懂的話解釋。',
    unlockAt: 0,
  },
];

const Notebook = {
  _open: false,
  _activeTab: 'morning',

  init() {
    const trigger = document.getElementById('notebook-trigger');
    const closeBtn = document.getElementById('nb-close-btn');
    const tabBar = document.getElementById('nb-tabs');
    const nbBody = document.querySelector('#notebook-panel .nb-body');
    if (!trigger) return;

    trigger.classList.add('visible');
    trigger.addEventListener('click', () => this.toggle());
    closeBtn?.addEventListener('click', () => this.close());

    tabBar?.addEventListener('click', (e: Event) => {
      const t = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
      if (!t) return;
      const name = t.getAttribute('data-tab');
      if (name) this.setTab(name);
    });

    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this._open) this.close();
    });

    nbBody?.addEventListener('wheel', (e: Event) => e.stopPropagation(), {
      passive: false,
    } as AddEventListenerOptions);
    nbBody?.addEventListener('touchmove', (e: Event) => e.stopPropagation(), {
      passive: false,
    } as AddEventListenerOptions);
  },

  open() {
    if (this._open) return;
    this._open = true;
    document.getElementById('notebook-panel')?.classList.add('notebook-open');
    document.getElementById('notebook-trigger')?.classList.add('hidden');
    document.getElementById('base-layer')?.classList.add('nb-dimmed');
    this._renderTab(this._activeTab);
  },

  close() {
    if (!this._open) return;
    this._open = false;
    document.getElementById('notebook-panel')?.classList.remove('notebook-open');
    document.getElementById('notebook-trigger')?.classList.remove('hidden');
    document.getElementById('base-layer')?.classList.remove('nb-dimmed');
  },

  toggle() {
    if (this._open) this.close();
    else this.open();
  },

  setTab(name: string) {
    this._activeTab = name;
    document.querySelectorAll('#nb-tabs .nb-tab').forEach((el) => {
      (el as HTMLElement).classList.toggle('active', el.getAttribute('data-tab') === name);
    });
    ['morning', 'scrolls', 'journey', 'workshop'].forEach((k) => {
      document.getElementById(`nb-pane-${k}`)?.classList.toggle('active', k === name);
    });
    this._renderTab(name);
  },

  _renderTab(name: string) {
    if (name === 'morning') this._renderMorning();
    if (name === 'scrolls') this._renderScrolls();
    if (name === 'journey') this._renderJourney();
    if (name === 'workshop') this._renderWorkshop();
  },

  _renderMorning() {
    const el = document.getElementById('nb-morning-content');
    if (!el) return;

    fetch('/cafe-game/data/creator-state.json')
      .then(r => r.ok ? r.json() : null)
      .then((state: CreatorState | null) => this._renderMorningContent(el!, state))
      .catch(() => this._renderMorningContent(el!, null));
  },

  _renderMorningContent(el: HTMLElement, rawState: CreatorState | null) {
    const today = new Date();
    const dateStr = `${today.getFullYear()}.${String(today.getMonth()+1).padStart(2,'0')}.${String(today.getDate()).padStart(2,'0')}`;
    const weekday = ['日','一','二','三','四','五','六'][today.getDay()];
    const hour = today.getHours();
    const greeting = hour < 6 ? '夜深了，還醒著？' :
                     hour < 12 ? '早安。新的一天開始了。' :
                     hour < 18 ? '午安。窗外的光線正好。' :
                     '晚安。今天辛苦了。';

    // Day-deterministic cafe thought (30 entries, same logic as napkin)
    const dayOfYear = Math.floor((today.getTime() - new Date(today.getFullYear(),0,0).getTime()) / 86400000);
    const THOUGHTS = [
      '有些事情想不通的時候，先放下來喝杯咖啡。答案會自己浮上來。',
      '今天適合做一件你一直拖延的小事。不是大事，小事就好。',
      '最好的學習方法，是教別人你剛學到的東西。',
      '代碼寫不動的時候，去散步。走路的節奏會幫你想通。',
      '不需要等到完美才開始。開始了才會接近完美。',
      '今天的你，比昨天的你多知道了一些事。這就夠了。',
      '休息不是偷懶。休息是為了走更遠的路。',
      '讀一篇好文章，比刷一小時社群媒體值得。',
      '你上次跟朋友好好聊天是什麼時候？',
      '把手機放遠一點。讓自己無聊五分鐘。靈感在無聊裡誕生。',
    ];
    const thought = THOUGHTS[dayOfYear % THOUGHTS.length];

    // Validate creator-state freshness: accept today or yesterday only
    let state: CreatorState | null = null;
    if (rawState?.date) {
      const stateDate = new Date(rawState.date);
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const diffDays = Math.floor((todayMidnight.getTime() - stateDate.getTime()) / 86400000);
      if (diffDays >= 0 && diffDays <= 1) state = rawState;
    }

    const creatorBlock = state ? `
      <div style="margin:16px 0;padding:12px 0;border-top:1px solid rgba(212,163,115,0.15);border-bottom:1px solid rgba(212,163,115,0.15)">
        <div style="font-size:10px;color:#d4a373;opacity:0.5;margin-bottom:8px;letter-spacing:0.15em">老闆的昨日</div>
        <div style="font-size:13px;line-height:1.8;opacity:0.8">${state.summary_vibe}</div>
        ${state.timeline && state.timeline.length > 0 ? `
          <div style="display:flex;gap:4px;margin-top:10px;height:20px;align-items:end">
            ${state.timeline.map(b => `
              <div style="flex:1;height:${Math.max(4, (b.intensity ?? 0.5) * 20)}px;background:rgba(212,163,115,${0.15 + (b.intensity ?? 0.5) * 0.3});border-radius:2px" title="${b.state} (${b.hour}:00)"></div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    ` : '';

    el.innerHTML = `
      <div style="color:#d4a373;font-size:11px;letter-spacing:0.2em;margin-bottom:16px">
        ${dateStr}（${weekday}）
      </div>
      <div style="font-size:15px;line-height:1.8;margin-bottom:20px;opacity:0.95">
        ${greeting}
      </div>
      ${creatorBlock}
      ${(() => {
        const v = _spVisits();
        const mem = v >= 20 ? '這個角落的光線，好像只為你亮著。' :
                    v >= 11 ? '牆上那幅畫換了。沒人告訴你為什麼。' :
                    v >= 6  ? '書架上多了幾本書。你好像有印象。' :
                    v >= 3  ? '桌上的杯子還有餘溫。' : '';
        return mem ? `<div style="font-size:12px;opacity:0.45;margin-bottom:16px;font-style:italic">${mem}</div>` : '';
      })()}
      <div style="font-size:13px;line-height:1.9;opacity:0.7;border-left:2px solid rgba(212,163,115,0.3);padding-left:14px">
        ${thought}
      </div>
    `;
  },

  _renderScrolls() {
    const container = document.getElementById('nb-scrolls-content');
    if (!container) return;
    container.innerHTML = '';
    const visits = _spVisits();

    SCROLL_LIBRARY.forEach((scroll) => {
      const isUnlocked = visits >= scroll.unlockAt;
      const card = document.createElement('div');
      card.className = 'nb-scroll-card';
      const row = document.createElement('div');
      row.className = 'nb-scroll-row';
      const titleEl = document.createElement('span');
      titleEl.className = 'nb-scroll-title';
      titleEl.textContent = scroll.title;
      const lockEl = document.createElement('span');
      lockEl.className = 'nb-scroll-lock' + (isUnlocked ? ' unlocked' : '');
      lockEl.textContent = isUnlocked
        ? (scroll.unlockAt === 0 ? '✦ 初始解鎖' : `✦ 第${scroll.unlockAt}次造訪解鎖`)
        : `第${scroll.unlockAt}次`;
      row.appendChild(titleEl);
      row.appendChild(lockEl);
      card.appendChild(row);
      const hintEl = document.createElement('div');
      hintEl.className = 'nb-scroll-hint';
      hintEl.textContent = scroll.hint;
      card.appendChild(hintEl);
      container.appendChild(card);
    });
  },

  _renderJourney() {
    const container = document.getElementById('nb-journey-content');
    if (!container) return;
    container.innerHTML = '';
    const visitorId = localStorage.getItem('cafe_visitor_id') ?? '—';
    const visits = _spVisits();
    const firstVisit = localStorage.getItem('cafe_first_visit');
    const stats: Array<{ label: string; value: string }> = [
      {
        label: '旅人識別碼',
        value: visitorId.length > 16 ? visitorId.slice(0, 16) + '…' : visitorId,
      },
      { label: '造訪次數', value: visits > 0 ? `${visits} 次` : '初次到訪' },
      {
        label: '首次造訪',
        value: firstVisit ? new Date(firstVisit).toLocaleDateString('zh-TW') : '今日',
      },
    ];
    stats.forEach(({ label, value }) => {
      const row = document.createElement('div');
      row.className = 'nb-stat-row';
      const lEl = document.createElement('span');
      lEl.className = 'nb-stat-label';
      lEl.textContent = label;
      const vEl = document.createElement('span');
      vEl.className = 'nb-stat-value';
      vEl.textContent = value;
      row.appendChild(lEl);
      row.appendChild(vEl);
      container.appendChild(row);
    });

    // ── Bret Victor: Soulprint Radar ──
    const sp = _spData();
    const sig = sp.personality_signals || {};
    const keys = ['action','analysis','empathy','inspiration','influence','explorer'] as const;
    const labels = ['行動','分析','共感','靈感','影響','探索'];
    const vals = keys.map(k => (sig[k] as number) || 0);
    const maxVal = Math.max(...vals, 1);
    const norm = vals.map(v => v / maxVal);

    const radarDiv = document.createElement('div');
    radarDiv.style.cssText = 'margin-top:24px;display:flex;flex-direction:column;align-items:center';
    const size = 200; const cx = 100; const cy = 100; const r = 70;
    const angles = keys.map((_, i) => (Math.PI * 2 * i) / 6 - Math.PI / 2);
    const hexPts = angles.map((a) => `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`).join(' ');
    const dataPts = angles.map((a, i) => `${cx + r * norm[i] * Math.cos(a)},${cy + r * norm[i] * Math.sin(a)}`).join(' ');
    const labelsSvg = angles.map((a, i) => {
      const lx = cx + (r + 18) * Math.cos(a);
      const ly = cy + (r + 18) * Math.sin(a);
      return `<text x="${lx}" y="${ly}" fill="rgba(212,163,115,0.6)" font-size="10" text-anchor="middle" dominant-baseline="middle">${labels[i]}</text>`;
    }).join('');

    radarDiv.innerHTML = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <polygon points="${hexPts}" fill="none" stroke="rgba(212,163,115,0.2)" stroke-width="1"/>
        <polygon points="${dataPts}" fill="rgba(212,163,115,0.15)" stroke="rgba(212,163,115,0.6)" stroke-width="1.5"/>
        ${labelsSvg}
      </svg>
      ${vals.every(v => v === 0) ? '<div style="font-size:11px;opacity:0.4;margin-top:8px">你的輪廓尚未成形</div>' : ''}
    `;
    container.appendChild(radarDiv);

    // ── Alan Kay: Personal Corner ──
    if (visits > 10) {
      const corner = document.createElement('div');
      corner.style.cssText = 'margin-top:20px;font-size:12px;opacity:0.5;line-height:1.8;border-top:1px solid rgba(212,163,115,0.15);padding-top:14px';
      corner.textContent = '這間咖啡廳的這個角落，已經是你的了。';
      container.appendChild(corner);
    }
  },

  // ── Seymour Papert: Workshop (建造區) ──
  _renderWorkshop() {
    const container = document.getElementById('nb-workshop-content');
    if (!container) return;
    container.innerHTML = '';

    // Load existing scrolls
    let myScrolls: Array<{text: string; date: string}> = [];
    try { myScrolls = JSON.parse(localStorage.getItem('cafe_my_scrolls') || '[]'); } catch { /* */ }

    // Input area
    const inputArea = document.createElement('div');
    inputArea.style.cssText = 'margin-bottom:20px';
    const ta = document.createElement('textarea');
    ta.placeholder = '寫下你的第一個咒語...';
    ta.maxLength = 200;
    ta.style.cssText = 'width:100%;height:80px;background:rgba(255,255,255,0.05);border:1px solid rgba(212,163,115,0.2);border-radius:6px;color:#fff;font-size:13px;padding:10px;resize:none;font-family:inherit;outline:none';
    const btn = document.createElement('button');
    btn.textContent = '封印';
    btn.style.cssText = 'margin-top:8px;padding:6px 20px;background:rgba(212,163,115,0.15);border:1px solid rgba(212,163,115,0.3);color:#d4a373;border-radius:4px;cursor:pointer;font-size:12px;letter-spacing:0.1em';
    btn.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) return;
      myScrolls.unshift({ text, date: new Date().toLocaleDateString('zh-TW') });
      if (myScrolls.length > 10) myScrolls.pop();
      localStorage.setItem('cafe_my_scrolls', JSON.stringify(myScrolls));
      ta.value = '';
      this._renderWorkshop(); // re-render

      // Papert's reveal at scroll #3
      if (myScrolls.length === 3) {
        setTimeout(() => {
          const reveal = document.getElementById('papert-reveal');
          if (reveal) reveal.style.opacity = '1';
        }, 3000);
      }
    });
    inputArea.appendChild(ta);
    inputArea.appendChild(btn);
    container.appendChild(inputArea);

    // My scrolls list
    myScrolls.forEach((s, i) => {
      const card = document.createElement('div');
      card.style.cssText = 'padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06)';
      card.innerHTML = `
        <div style="font-size:10px;color:#d4a373;opacity:0.6;margin-bottom:4px">第${myScrolls.length - i}個咒語 · ${s.date}</div>
        <div style="font-size:13px;opacity:0.85;line-height:1.7">${s.text.replace(/</g,'&lt;')}</div>
      `;
      container.appendChild(card);
    });

    // Papert's reveal
    if (myScrolls.length >= 3) {
      const reveal = document.createElement('div');
      reveal.id = 'papert-reveal';
      reveal.style.cssText = 'margin-top:16px;font-size:12px;color:#d4a373;opacity:0.7;text-align:center;transition:opacity 2s ease';
      reveal.textContent = `你已經寫了 ${myScrolls.length} 個咒語。這就是 prompt engineering。`;
      container.appendChild(reveal);
    }

    // ── Coming Soon Feature Cards ──
    const WORKSHOP_FEATURES = [
      {
        icon: '⚒️',
        title: 'Prompt 鍛造台',
        desc: '烈焰吞噬混沌思緒，淬鍊為鋒利指令。',
      },
      {
        icon: '〰️',
        title: '頻率調音器',
        desc: '旋動幽冥刻度，校準與深淵的共振頻率。',
      },
      {
        icon: '🎭',
        title: '角色面具',
        desc: '戴上無面之具，化身千百陌生的自己。',
      },
    ];

    const divider = document.createElement('div');
    divider.style.cssText = 'margin:28px 0 20px;border-top:1px solid rgba(212,163,115,0.12);padding-top:18px';
    const workshopLabel = document.createElement('div');
    workshopLabel.style.cssText = 'font-size:10px;color:#d4a373;opacity:0.45;letter-spacing:0.18em;margin-bottom:16px;text-transform:uppercase';
    workshopLabel.textContent = '即將開放';
    divider.appendChild(workshopLabel);
    container.appendChild(divider);

    WORKSHOP_FEATURES.forEach((feat) => {
      const card = document.createElement('div');
      card.className = 'nb-scroll-card';
      card.style.cssText = 'opacity:0.72;cursor:default;margin-bottom:12px';

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px';

      const left = document.createElement('div');
      left.style.cssText = 'display:flex;align-items:center;gap:10px';

      const iconEl = document.createElement('span');
      iconEl.style.cssText = 'font-size:18px;line-height:1;opacity:0.75';
      iconEl.textContent = feat.icon;

      const titleEl = document.createElement('span');
      titleEl.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.85);letter-spacing:0.02em';
      titleEl.textContent = feat.title;

      left.appendChild(iconEl);
      left.appendChild(titleEl);

      const badge = document.createElement('span');
      badge.style.cssText = 'font-size:9px;letter-spacing:0.14em;color:#d4a373;opacity:0.55;border:1px solid rgba(212,163,115,0.25);border-radius:3px;padding:2px 7px;white-space:nowrap';
      badge.textContent = 'COMING SOON';

      row.appendChild(left);
      row.appendChild(badge);
      card.appendChild(row);

      const descEl = document.createElement('div');
      descEl.style.cssText = 'font-size:12px;opacity:0.5;line-height:1.75;padding-left:28px';
      descEl.textContent = feat.desc;
      card.appendChild(descEl);

      container.appendChild(card);
    });
  },
};

export default Notebook;
