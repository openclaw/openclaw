/**
 * notebook.js — Diegetic Smartphone/Notebook UI (主權容器)
 *
 * A physical paper notebook that slides in from the right edge.
 * Three tabs: 晨報 (news), 卷軸 (collected scrolls), 旅程 (journey stats).
 *
 * Namespace: window.CafeNotebook
 * z-index: 9500 (above vignette/grain, below dialogue at 9999)
 */
;(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────
  var panel, body, tabEls, contentEls, triggerBtn, backdrop;
  var _open = false;
  var _activeTab = 'news';
  var _newsCache = null;
  var _container = null;

  // ─── Styles (injected into <head>) ───────────────────────────────
  var STYLE = [
    '#notebook-panel {',
    '  position: fixed; top: 0; bottom: 0; right: 0;',
    '  width: min(320px, 85vw);',
    '  transform: translateX(100%);',
    '  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);',
    '  z-index: 9500;',
    '  display: flex; flex-direction: column;',
    '  background: #fdf6e3;',
    '  background-image: repeating-linear-gradient(',
    '    transparent, transparent 27px, rgba(194,178,150,0.25) 27px, rgba(194,178,150,0.25) 28px',
    '  );',
    '  box-shadow: none;',
    '  font-family: "Courier New", Courier, monospace;',
    '  color: #1a1410;',
    '  user-select: none;',
    '  -webkit-user-select: none;',
    '  box-sizing: border-box;',
    '  overflow: hidden;',
    '}',
    '#notebook-panel.notebook-open {',
    '  transform: translateX(0);',
    '  box-shadow: -8px 0 24px rgba(0,0,0,0.4);',
    '}',
    '',
    '/* Leather spine */',
    '.notebook-spine {',
    '  position: absolute; left: 0; top: 0; bottom: 0; width: 4px;',
    '  background: linear-gradient(to right, #2a1f14, #3d2b1f);',
    '  z-index: 1;',
    '}',
    '',
    '/* Header */',
    '.notebook-header {',
    '  display: flex; align-items: center; justify-content: space-between;',
    '  padding: 14px 14px 8px 18px;',
    '  border-bottom: 1px solid #d4c4a8;',
    '  flex-shrink: 0;',
    '}',
    '.notebook-title {',
    '  font-size: 18px; font-weight: bold; letter-spacing: 2px;',
    '  color: #3d2b1f;',
    '  font-style: italic;',
    '}',
    '.notebook-close-btn {',
    '  width: 28px; height: 28px; line-height: 28px; text-align: center;',
    '  font-size: 20px; cursor: pointer; color: #8a7a6a;',
    '  border-radius: 4px; transition: background 0.15s;',
    '}',
    '.notebook-close-btn:hover { background: rgba(0,0,0,0.08); }',
    '',
    '/* Tabs */',
    '.notebook-tabs {',
    '  display: flex; flex-shrink: 0;',
    '  border-bottom: 2px solid #c4956a;',
    '  padding: 0 14px 0 18px;',
    '}',
    '.notebook-tabs .tab {',
    '  flex: 1; text-align: center; padding: 8px 4px; cursor: pointer;',
    '  font-size: 13px; letter-spacing: 1px; color: #8a7a6a;',
    '  background: #d4c4a8; border-radius: 4px 4px 0 0;',
    '  margin-right: 2px; transition: background 0.2s, color 0.2s;',
    '  border: 1px solid transparent; border-bottom: none;',
    '}',
    '.notebook-tabs .tab:last-child { margin-right: 0; }',
    '.notebook-tabs .tab.active {',
    '  background: #fdf6e3; color: #1a1410; font-weight: bold;',
    '  border-color: #c4956a;',
    '  position: relative; top: 1px;',
    '}',
    '',
    '/* Body */',
    '.notebook-body {',
    '  flex: 1; overflow-y: auto; overflow-x: hidden;',
    '  padding: 14px 16px 20px 18px;',
    '  -webkit-overflow-scrolling: touch;',
    '  overscroll-behavior: contain;',
    '}',
    '.notebook-body .tab-content { display: none; }',
    '.notebook-body .tab-content.active { display: block; }',
    '',
    '/* Tab section titles */',
    '.nb-section-title {',
    '  font-size: 16px; font-weight: bold; color: #3d2b1f;',
    '  font-style: italic; margin-bottom: 2px;',
    '}',
    '.nb-section-subtitle {',
    '  font-size: 11px; color: #8a7a6a; margin-bottom: 14px;',
    '  letter-spacing: 0.5px;',
    '}',
    '',
    '/* News tab */',
    '.nb-news-date {',
    '  font-size: 11px; color: #a89880; margin-bottom: 10px;',
    '  border-bottom: 1px dashed #d4c4a8; padding-bottom: 6px;',
    '}',
    '.nb-news-body {',
    '  font-size: 13px; line-height: 1.7; color: #2a1f14;',
    '}',
    '.nb-news-body h3 {',
    '  font-size: 14px; font-weight: bold; color: #3d2b1f;',
    '  margin: 12px 0 4px 0; font-style: italic;',
    '}',
    '.nb-news-link {',
    '  display: inline-block; margin-top: 14px;',
    '  color: #c4956a; font-size: 12px; text-decoration: none;',
    '  border-bottom: 1px solid #c4956a;',
    '}',
    '.nb-news-link:hover { color: #f5a623; border-color: #f5a623; }',
    '.nb-news-empty {',
    '  text-align: center; color: #a89880; padding: 30px 10px;',
    '  font-size: 13px; line-height: 1.8; white-space: pre-line;',
    '}',
    '',
    '/* Scrolls tab */',
    '.nb-scroll-empty {',
    '  text-align: center; color: #a89880; padding: 30px 10px;',
    '  font-size: 13px; line-height: 1.6;',
    '}',
    '.nb-scroll-card {',
    '  border: 1px solid #c4956a; border-radius: 4px;',
    '  padding: 10px 12px; margin-bottom: 10px;',
    '  background: rgba(196,149,106,0.08);',
    '}',
    '.nb-scroll-card-title {',
    '  font-size: 13px; font-weight: bold; color: #3d2b1f;',
    '  margin-bottom: 6px;',
    '}',
    '.nb-scroll-card-preview {',
    '  font-size: 12px; line-height: 1.5; color: #5a4a3a;',
    '  margin-bottom: 8px; white-space: pre-line;',
    '}',
    '.nb-scroll-card-full {',
    '  display: none; font-size: 12px; line-height: 1.5;',
    '  color: #2a1f14; margin-bottom: 8px; white-space: pre-wrap;',
    '  word-break: break-word;',
    '}',
    '.nb-scroll-card-full.expanded { display: block; }',
    '.nb-scroll-card-actions { display: flex; gap: 8px; justify-content: flex-end; }',
    '.nb-scroll-btn {',
    '  font-size: 11px; padding: 3px 8px; cursor: pointer;',
    '  background: #c4956a; color: #fdf6e3; border: none; border-radius: 3px;',
    '  font-family: "Courier New", monospace; transition: background 0.15s;',
    '}',
    '.nb-scroll-btn:hover { background: #f5a623; }',
    '',
    '/* Journey tab */',
    '.nb-journey-stat {',
    '  display: flex; justify-content: space-between; align-items: center;',
    '  padding: 8px 0; border-bottom: 1px dashed #d4c4a8;',
    '  font-size: 13px;',
    '}',
    '.nb-journey-stat:last-child { border-bottom: none; }',
    '.nb-journey-label { color: #5a4a3a; }',
    '.nb-journey-value { font-weight: bold; color: #3d2b1f; }',
    '.nb-journey-card {',
    '  border: 2px solid #c4956a; border-radius: 6px;',
    '  padding: 14px; margin-top: 6px;',
    '  background: rgba(196,149,106,0.06);',
    '  border-image: none;',
    '}',
    '',
    '/* Trigger button */',
    '#notebook-trigger {',
    '  position: fixed; top: 12px; right: 12px;',
    '  width: 36px; height: 36px;',
    '  z-index: 9490; cursor: pointer;',
    '  background: rgba(26,18,11,0.75); border: 1px solid #c4956a;',
    '  border-radius: 4px; display: flex; align-items: center; justify-content: center;',
    '  color: #f0e6d2; font-size: 14px; font-family: monospace;',
    '  transition: opacity 0.2s, background 0.15s;',
    '  user-select: none; -webkit-user-select: none; touch-action: manipulation;',
    '}',
    '#notebook-trigger:hover { background: rgba(26,18,11,0.9); }',
    '#notebook-trigger.hidden { opacity: 0; pointer-events: none; }',
    '',
    '/* Backdrop */',
    '#notebook-backdrop {',
    '  position: fixed; inset: 0; z-index: 9499;',
    '  background: rgba(0,0,0,0.15);',
    '  opacity: 0; pointer-events: none;',
    '  transition: opacity 0.3s;',
    '}',
    '#notebook-backdrop.active { opacity: 1; pointer-events: auto; }',
  ].join('\n');

  // ─── Helpers ─────────────────────────────────────────────────────
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }

  function miniMarkdown(md) {
    if (!md) return '';
    return md
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  function safeCall(obj, method, args) {
    if (obj && typeof obj[method] === 'function') {
      try { return obj[method].apply(obj, args || []); } catch (_) {}
    }
    return undefined;
  }

  // ─── DOM Build ───────────────────────────────────────────────────
  function buildDOM() {
    // Inject styles
    var styleEl = document.createElement('style');
    styleEl.textContent = STYLE;
    document.head.appendChild(styleEl);

    // Backdrop (click to close)
    backdrop = el('div');
    backdrop.id = 'notebook-backdrop';
    document.body.appendChild(backdrop);

    // Panel
    panel = el('div');
    panel.id = 'notebook-panel';

    // Spine
    panel.appendChild(el('div', 'notebook-spine'));

    // Header
    var header = el('div', 'notebook-header');
    header.appendChild(el('div', 'notebook-title', '手帳本'));
    var closeBtn = el('div', 'notebook-close-btn', '\u00d7');
    closeBtn.setAttribute('role', 'button');
    closeBtn.setAttribute('aria-label', 'Close notebook');
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Tabs
    var tabBar = el('div', 'notebook-tabs');
    var tabDefs = [
      { key: 'news', label: '晨報' },
      { key: 'scrolls', label: '卷軸' },
      { key: 'journey', label: '旅程' },
    ];
    tabEls = {};
    tabDefs.forEach(function (t) {
      var tab = el('div', 'tab', t.label);
      tab.setAttribute('data-tab', t.key);
      if (t.key === _activeTab) tab.classList.add('active');
      tabBar.appendChild(tab);
      tabEls[t.key] = tab;
    });
    panel.appendChild(tabBar);

    // Body
    body = el('div', 'notebook-body');
    contentEls = {};
    ['news', 'scrolls', 'journey'].forEach(function (key) {
      var c = el('div', 'tab-content' + (key === _activeTab ? ' active' : ''));
      c.id = 'tab-' + key;
      body.appendChild(c);
      contentEls[key] = c;
    });

    // Prevent scroll propagation to game canvas
    body.addEventListener('wheel', function (e) { e.stopPropagation(); }, { passive: false });
    body.addEventListener('touchmove', function (e) { e.stopPropagation(); }, { passive: false });

    panel.appendChild(body);
    document.body.appendChild(panel);

    // Trigger button
    triggerBtn = el('div');
    triggerBtn.id = 'notebook-trigger';
    // Book icon drawn with Unicode box-drawing chars
    triggerBtn.innerHTML = '<span style="font-size:16px;line-height:1">\u25A1</span>';
    triggerBtn.setAttribute('role', 'button');
    triggerBtn.setAttribute('aria-label', 'Open notebook');
    document.body.appendChild(triggerBtn);

    // ─── Events ──────────────────────────────────────────────────
    closeBtn.addEventListener('click', function () { CafeNotebook.close(); });
    backdrop.addEventListener('click', function () { CafeNotebook.close(); });
    triggerBtn.addEventListener('click', function () { CafeNotebook.toggle(); });

    tabBar.addEventListener('click', function (e) {
      var t = e.target.closest('.tab');
      if (!t) return;
      var name = t.getAttribute('data-tab');
      if (name) CafeNotebook.setTab(name);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _open) {
        CafeNotebook.close();
        return;
      }
      // 'n' toggles notebook, but only when not typing and dialogue not open
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (window.CafeDialogue && window.CafeDialogue.isOpen && window.CafeDialogue.isOpen()) return;
        CafeNotebook.toggle();
      }
    });
  }

  // ─── Tab Renderers ───────────────────────────────────────────────

  // --- News ---
  function renderNews() {
    var wrap = contentEls.news;
    wrap.innerHTML = '';

    wrap.appendChild(el('div', 'nb-section-title', '系統脈搏'));
    wrap.appendChild(el('div', 'nb-section-subtitle', 'Heartbeat Briefing'));

    if (_newsCache) {
      showBriefingContent(wrap, _newsCache);
      return;
    }

    var loading = el('div', 'nb-news-empty', '正在連接心跳...');
    wrap.appendChild(loading);

    // Try shelter briefing first, fallback to thinker-news
    fetch('/api/cafe-game/data/briefing.json')
      .then(function (r) {
        if (!r.ok) throw new Error('no briefing');
        return r.json();
      })
      .then(function (data) {
        _newsCache = data;
        wrap.removeChild(loading);
        showBriefingContent(wrap, data);
      })
      .catch(function () {
        // Fallback: try thinker-news
        fetch('https://thinkercafe-tw.github.io/thinker-news/latest.json')
          .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
          .then(function (data) {
            _newsCache = data;
            wrap.removeChild(loading);
            showLegacyNewsContent(wrap, data);
          })
          .catch(function () {
            loading.innerHTML = [
              '心跳暫時離線...',
              '',
              '      ( (    ',
              '       ) )   ',
              '    .______. ',
              '    |      |]',
              '    \\      / ',
              "     `----'  ",
            ].join('\n');
          });
      });
  }

  function showBriefingContent(wrap, data) {
    if (data.date) {
      wrap.appendChild(el('div', 'nb-news-date', data.date + ' ' + (data.time || '')));
    }
    var bodyDiv = el('div', 'nb-news-body');
    var lines = [];
    lines.push('<h3>Beat #' + (data.beat || '?') + '</h3>');

    // Status indicators
    var gw = data.gateway ? '\u2705' : '\u274c';
    var ol = data.ollama ? '\u2705' : '\u274c';
    lines.push('<strong>Gateway</strong> ' + gw + ' &nbsp; <strong>Ollama</strong> ' + ol);

    if (data.guardian_mode) {
      lines.push('<br><strong>Guardian</strong>: ' + data.guardian_mode +
        ' (score: ' + (data.guardian_score || 0).toFixed(2) + ')');
    }
    if (data.evo_phase !== undefined && data.evo_phase !== -1) {
      lines.push('<br><strong>Evolution</strong>: Phase ' + data.evo_phase);
    }
    if (data.threads_unreplied > 0) {
      lines.push('<br><strong>Threads</strong>: ' + data.threads_unreplied + ' unreplied');
    }
    if (data.cpu_load) {
      lines.push('<br><strong>CPU</strong>: ' + data.cpu_load);
    }

    // Actions
    if (data.actions && data.actions.length > 0) {
      lines.push('<h3>Actions</h3>');
      data.actions.forEach(function (a) {
        lines.push(a + '<br>');
      });
    } else {
      lines.push('<br><em>All quiet. \u2615</em>');
    }

    bodyDiv.innerHTML = lines.join('');
    wrap.appendChild(bodyDiv);
  }

  function showLegacyNewsContent(wrap, data) {
    if (data.date) {
      wrap.appendChild(el('div', 'nb-news-date', data.date));
    }
    var bodyDiv = el('div', 'nb-news-body');
    var content = data.notion_content || data.content || '';
    bodyDiv.innerHTML = miniMarkdown(content);
    wrap.appendChild(bodyDiv);

    if (data.website_url) {
      var link = el('a', 'nb-news-link', '閱讀完整版 \u2192');
      link.href = data.website_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      wrap.appendChild(link);
    }
  }

  // --- Scrolls ---
  function renderScrolls() {
    var wrap = contentEls.scrolls;
    wrap.innerHTML = '';

    wrap.appendChild(el('div', 'nb-section-title', '魔法卷軸收藏'));
    wrap.appendChild(el('div', 'nb-section-subtitle', 'Your Collected Spells'));

    var raw = localStorage.getItem('cafe_scrolls_collected');
    var scrolls;
    try { scrolls = JSON.parse(raw); } catch (_) { scrolls = null; }

    if (!scrolls || !Array.isArray(scrolls) || scrolls.length === 0) {
      wrap.appendChild(el('div', 'nb-scroll-empty',
        '你還沒有收集到任何卷軸。<br>去找書架上的魔法書吧。'));
      return;
    }

    scrolls.forEach(function (scroll) {
      var card = el('div', 'nb-scroll-card');

      // Title
      var title = scroll.title || '未命名卷軸';
      card.appendChild(el('div', 'nb-scroll-card-title', '\u2727 ' + title));

      // Preview (first 2 lines)
      var fullPrompt = scroll.prompt || scroll.content || '';
      var lines = fullPrompt.split('\n');
      var preview = lines.slice(0, 2).join('\n');
      if (lines.length > 2) preview += '\n...';
      card.appendChild(el('div', 'nb-scroll-card-preview', preview));

      // Full content (hidden)
      var fullDiv = el('div', 'nb-scroll-card-full');
      fullDiv.textContent = fullPrompt;
      card.appendChild(fullDiv);

      // Actions
      var actions = el('div', 'nb-scroll-card-actions');

      var copyBtn = el('button', 'nb-scroll-btn', '複製咒語');
      copyBtn.addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(fullPrompt).then(function () {
            copyBtn.textContent = '已複製!';
            setTimeout(function () { copyBtn.textContent = '複製咒語'; }, 1200);
          });
        }
      });

      var expandBtn = el('button', 'nb-scroll-btn', '展開');
      expandBtn.addEventListener('click', function () {
        var expanded = fullDiv.classList.toggle('expanded');
        expandBtn.textContent = expanded ? '收合' : '展開';
      });

      actions.appendChild(copyBtn);
      actions.appendChild(expandBtn);
      card.appendChild(actions);

      wrap.appendChild(card);
    });
  }

  // --- Journey ---
  function renderJourney() {
    var wrap = contentEls.journey;
    wrap.innerHTML = '';

    wrap.appendChild(el('div', 'nb-section-title', '你的咖啡旅程'));
    wrap.appendChild(el('div', 'nb-section-subtitle', 'Your Coffee Journey'));

    var card = el('div', 'nb-journey-card');

    var stats = [];

    // Visit count
    var visits = parseInt(localStorage.getItem('cafe_visit_count'), 10) || 0;
    stats.push({ label: '來訪次數', value: visits + ' 次' });

    // Visit tier
    var tier = safeCall(window.CafeBehavior, 'getVisitTier');
    if (tier) {
      stats.push({ label: '旅人等級', value: tier });
    }

    // Personality archetype
    var archetype = safeCall(window.CafeBehavior, 'classify');
    if (archetype) {
      var archName = (typeof archetype === 'object' && archetype.name) ? archetype.name : String(archetype);
      stats.push({ label: '旅人類型', value: archName });
    }

    // Coffees given
    var coffees = 0;
    try {
      var c = localStorage.getItem('cafe_coffees');
      if (c) {
        var parsed = JSON.parse(c);
        coffees = Array.isArray(parsed) ? parsed.length : (parseInt(c, 10) || 0);
      }
    } catch (_) {
      coffees = parseInt(localStorage.getItem('cafe_coffees'), 10) || 0;
    }
    stats.push({ label: '贈送咖啡', value: coffees + ' 杯' });

    // Notes left
    var notes = 0;
    try {
      var n = localStorage.getItem('cafe_notes');
      if (n) {
        var pn = JSON.parse(n);
        notes = Array.isArray(pn) ? pn.length : 0;
      }
    } catch (_) { notes = 0; }
    stats.push({ label: '留下紙條', value: notes + ' 張' });

    stats.forEach(function (s) {
      var row = el('div', 'nb-journey-stat');
      row.appendChild(el('span', 'nb-journey-label', s.label));
      row.appendChild(el('span', 'nb-journey-value', s.value));
      card.appendChild(row);
    });

    wrap.appendChild(card);

    // Fallback message if behavior module isn't loaded
    if (!window.CafeBehavior) {
      var note = el('div', 'nb-section-subtitle');
      note.style.marginTop = '12px';
      note.style.fontStyle = 'italic';
      note.textContent = '(多來幾次，我會慢慢認識你的)';
      wrap.appendChild(note);
    }
  }

  // ─── Tab rendering dispatch ──────────────────────────────────────
  var renderers = {
    news: renderNews,
    scrolls: renderScrolls,
    journey: renderJourney,
  };

  function renderActiveTab() {
    var fn = renderers[_activeTab];
    if (fn) fn();
  }

  // ─── Public API ──────────────────────────────────────────────────
  var CafeNotebook = {

    init: function (containerEl) {
      _container = containerEl || document.body;
      buildDOM();
    },

    open: function () {
      if (_open) return;
      _open = true;
      window._notebookOpen = true;
      panel.classList.add('notebook-open');
      backdrop.classList.add('active');
      triggerBtn.classList.add('hidden');
      renderActiveTab();
      safeCall(window.CafeAudio, 'playPageTurn');
    },

    close: function () {
      if (!_open) return;
      _open = false;
      window._notebookOpen = false;
      panel.classList.remove('notebook-open');
      backdrop.classList.remove('active');
      triggerBtn.classList.remove('hidden');
      safeCall(window.CafeAudio, 'playNotebookClose');
    },

    toggle: function () {
      if (_open) CafeNotebook.close();
      else CafeNotebook.open();
    },

    isOpen: function () {
      return _open;
    },

    setTab: function (tabName) {
      if (!contentEls[tabName]) return;
      if (tabName === _activeTab && _open) return;
      _activeTab = tabName;

      // Update tab visuals
      Object.keys(tabEls).forEach(function (k) {
        tabEls[k].classList.toggle('active', k === tabName);
      });
      Object.keys(contentEls).forEach(function (k) {
        contentEls[k].classList.toggle('active', k === tabName);
      });

      renderActiveTab();
      safeCall(window.CafeAudio, 'playPageTurn');
    },

    getActiveTab: function () {
      return _activeTab;
    },
  };

  window.CafeNotebook = CafeNotebook;
})();
