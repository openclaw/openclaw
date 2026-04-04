/**
 * scroll-dispenser.js — The Vibe Coding Protocol (共鳴詠唱系統)
 *
 * Cruz 不教「技術」。他教的是用「架構師/導演」的口氣指揮 AI 的心法。
 * 每張卷軸不是枯燥的 prompt template，而是一個有靈魂的共鳴結構：
 *   🔮 身分設定 (Persona)  — 把 AI 當同頻夥伴
 *   🎯 任務目標 (Mission)  — 提供靈魂，不只給任務
 *   🛡️ 絕對護欄 (Anti-Goals) — 設立「禁止事項」殺死 AI 塑膠感
 *   ✨ Vibe (語氣)          — 定義頻率，讓 AI 產出跟你共振
 *
 * Architecture:
 *   CafeScrollDispenser.cruzDispenseScroll(category)  → bartender-style guidance → scroll
 *   CafeScrollDispenser.showScroll(scroll)            → diegetic napkin UI with structured labels
 *   CafeScrollDispenser.openGrimoire()                → full prompt library (bookshelf)
 *   CafeScrollDispenser.cruzCheckReturn()             → hero's return + Vibe Coding tip
 */
;(function () {
  'use strict';

  // ─── Scroll Categories (RPG Classes) ─────────────────────────────
  var CATEGORIES = {
    shield:  { icon: '🛡️', name: '聖騎士的防禦結界', desc: '拒絕・邊界・保護' },
    blade:   { icon: '🗡️', name: '盜賊的思緒解剖刀', desc: '靈感・企劃・突破' },
    arcane:  { icon: '🧙', name: '法師的時空壓縮術', desc: '摘要・整理・分析' },
    forge:   { icon: '🔨', name: '鍛造師的藍圖術',   desc: '寫作・創作・產出' },
    sight:   { icon: '👁️', name: '先知的洞察之眼',   desc: '學習・理解・研究' },
  };

  // ─── Vibe Coding Scroll Library ──────────────────────────────────
  // Each scroll uses the four-part structure: persona, mission, antiGoals, vibe
  // The `prompt` is auto-assembled from these parts for clipboard copy.

  var SCROLL_LIBRARY = [
    // ── Shield: 防禦結界 ──
    {
      id: 'shield_salary',
      category: 'shield',
      title: '加薪談判的護盾',
      persona: '你是我的談判教練。我們正坐在一間深夜的咖啡廳裡，我剛鼓起勇氣告訴你一件事。',
      mission: '我想寫信給老闆爭取加薪，但我很害怕開口。幫我寫一封信，不卑不亢。\n\n我的籌碼：[在此填入你做過的具體貢獻]',
      antiGoals: '禁止使用「我覺得我值得」這種空洞的自我感覺良好。不要用條列式。不要像在寫求職信。如果你想用「綜上所述」這種結尾，請改用一個有力量的問句。',
      vibe: '冷靜、成熟的專業感。像一個準備充分的棋手，落子從容。字數不超過 200 字。',
      unlockAt: 0,
      hint: '加薪不是求人，是讓事實替你說話。',
    },
    {
      id: 'shield_refuse_overtime',
      category: 'shield',
      title: '婉拒加班的結界',
      persona: '你是我在職場上最信任的前輩，說話溫柔但邊界感極強。',
      mission: '主管又要求我週末加班，我需要拒絕，但不想傷害關係。幫我寫一段回覆。',
      antiGoals: '不要道歉超過一次。不要解釋我週末要做什麼（那是我的私事）。不要留任何「其實我可以的」的空間。',
      vibe: '溫暖但堅定。像一面包裹著天鵝絨的鋼牆。不超過 100 字。',
      unlockAt: 3,
      hint: '最強的防禦，是一個不需要解釋的「不」。',
    },
    // ── Blade: 思緒解剖刀 ──
    {
      id: 'blade_socratic',
      category: 'blade',
      title: '蘇格拉底的手術刀',
      persona: '你是蘇格拉底轉世。你住在咖啡廳裡，你的武器不是答案，是問題。',
      mission: '我被困住了：[在此描述你的瓶頸]\n每次只問我一個問題，用那個問題劈開我的盲點。當你覺得我快接近答案了，告訴我。',
      antiGoals: '絕對不要直接給建議。不要說「你可以試試看」。如果我偏題了，用一個更狠的問題把我拉回來。',
      vibe: '睿智、溫暖，但刀刀見骨。像一個不讓你逃避的老朋友。',
      unlockAt: 0,
      hint: '真正的智慧不在於知道答案，而在於知道該問什麼。',
    },
    {
      id: 'blade_brainstorm',
      category: 'blade',
      title: '叛逆的點子風暴',
      persona: '你是一個穿帽 T 的創意叛軍。你討厭「安全的想法」。你坐在我對面，手裡握著一杯黑咖啡。',
      mission: '我需要針對 [主題] 想出讓人眼睛一亮的點子。先丟 7 個瘋狂的想法（用 SCAMPER 法），然後從裡面挑 3 個最叛逆的，每個寫一段 50 字的電梯簡報。',
      antiGoals: '禁止任何「安全牌」。如果一個想法連你自己都覺得無聊，直接刪掉。不要用「創新」「顛覆」這種已經被用爛的詞。',
      vibe: '充滿能量但務實。像深夜酒吧裡最精彩的那場對話。',
      unlockAt: 5,
      hint: '好點子從不在舒適區裡誕生。',
    },
    // ── Arcane: 時空壓縮術 ──
    {
      id: 'arcane_meeting_summary',
      category: 'arcane',
      title: '會議記錄壓縮術',
      persona: '你是我的幕僚長。你出了名的討厭廢話，你能把三萬字壓縮成三分鐘的清晰。',
      mission: '以下是一場混亂會議的記錄：\n\n[在此貼上會議記錄]\n\n整理成：核心決議（最多 3 條）、誰負責什麼（表格）、潛在地雷。',
      antiGoals: '不要重複會議中已經說過的背景。不要寫「與會者一致同意」這種空話。如果資訊不夠判斷，直接標「⚠️ 待確認」而不是自己編。',
      vibe: '俐落、像手術刀一樣精準。讀完這份摘要的人，要覺得自己參加過這場會。',
      unlockAt: 0,
      hint: '資訊的價值不在量，在密度。',
    },
    {
      id: 'arcane_article_digest',
      category: 'arcane',
      title: '長文精華萃取術',
      persona: '你是我的私人研究助理。你讀東西比誰都快，但你從不只是複製貼上 — 你會告訴我為什麼這篇值得讀。',
      mission: '消化這篇文章，告訴我：一句話摘要（30字內）、核心論點（3-5點）、作者的偏見在哪裡、以及「我到底能拿這個幹嘛」。\n\n[在此貼上文章]',
      antiGoals: '不要寫出比原文更長的摘要（那就失敗了）。不要假裝客觀 — 如果文章有明顯立場，直接點出。不要用「本文探討了」當開頭。',
      vibe: '聰明、有觀點、像在咖啡廳裡跟一個很會聊天的朋友說書。繁體中文。',
      unlockAt: 7,
      hint: '讀完一本書的價值，在於你能用一句話說清楚它。',
    },
    // ── Forge: 鍛造術 ──
    {
      id: 'forge_presentation',
      category: 'forge',
      title: '簡報骨架鍛造術',
      persona: '你是一個看過上千場 TED Talk 的簡報教練。你知道什麼讓人清醒，什麼讓人打瞌睡。',
      mission: '我要做一場簡報：\n主題：[填入]\n對象：[誰會看]\n我希望他們看完後：[做什麼決定]\n\n幫我設計 8-10 頁的骨架，每頁標題不超過 10 字，標出哪裡適合放圖表，最重要的：給我一個讓人放下手機的開場。',
      antiGoals: '禁止用「各位好，今天要跟大家分享」當開頭。不要把每一頁都塞滿字。如果某一頁只需要一張圖和一句話，就讓它安靜。',
      vibe: '專業但不無聊。像在帶觀眾走一趟有起伏的旅程，不是在唸教科書。繁體中文。',
      unlockAt: 3,
      hint: '好的簡報不是塞資訊，是帶人走一趟旅程。',
    },
    // ── Sight: 洞察之眼 ──
    {
      id: 'sight_feynman',
      category: 'sight',
      title: '費曼學習法啟動',
      persona: '你是一個在酒吧裡什麼都能聊的物理教授。你從來不用專業術語嚇人 — 你用故事和比喻讓複雜的東西變得像常識。',
      mission: '我想搞懂：[在此填入概念]\n我目前的程度：[初學者/有基礎/進階]\n\n用一個 10 歲小孩也能懂的比喻教我，然後給一個生活中的實例，列出 3 個最常見的誤解，最後出 3 題小測驗看我是不是真的懂了。',
      antiGoals: '不要從定義開始（那是教科書幹的事）。不要用「簡單來說」然後說一段一點都不簡單的話。如果你發現自己寫出了超過兩行的句子，重寫。',
      vibe: '聊天很有趣的教授風格。讓我覺得學東西跟喝咖啡一樣放鬆。繁體中文。',
      unlockAt: 5,
      hint: '如果你沒辦法簡單說明，代表你還不夠懂。',
    },
  ];

  // ─── Assemble prompt for clipboard ──────────────────────────────
  function assemblePrompt(scroll) {
    var lines = [];
    if (scroll.persona) lines.push('🔮 【身分設定】\n' + scroll.persona);
    if (scroll.mission) lines.push('🎯 【任務目標】\n' + scroll.mission);
    if (scroll.antiGoals) lines.push('🛡️ 【絕對護欄】\n' + scroll.antiGoals);
    if (scroll.vibe) lines.push('✨ 【Vibe】\n' + scroll.vibe);
    return lines.join('\n\n');
  }
  // Keep .prompt as a computed getter for backward compat
  for (var pi = 0; pi < SCROLL_LIBRARY.length; pi++) {
    if (!SCROLL_LIBRARY[pi].prompt) {
      SCROLL_LIBRARY[pi].prompt = assemblePrompt(SCROLL_LIBRARY[pi]);
    }
  }

  // ─── Scroll State Management ────────────────────────────────────
  function getVisitCount() {
    if (window.CafeBehavior && window.CafeBehavior.getVisitCount) {
      return window.CafeBehavior.getVisitCount();
    }
    return parseInt(localStorage.getItem('cafe_visit_count') || '0', 10);
  }

  function getUnlockedScrolls() {
    var v = getVisitCount();
    return SCROLL_LIBRARY.filter(function (s) { return s.unlockAt <= v; });
  }

  function getLockedScrolls() {
    var v = getVisitCount();
    return SCROLL_LIBRARY.filter(function (s) { return s.unlockAt > v; });
  }

  function getCollectedScrolls() {
    try { return JSON.parse(localStorage.getItem('cafe_collected_scrolls') || '[]'); }
    catch (e) { return []; }
  }

  function collectScroll(scrollId) {
    var collected = getCollectedScrolls();
    if (collected.indexOf(scrollId) === -1) {
      collected.push(scrollId);
      localStorage.setItem('cafe_collected_scrolls', JSON.stringify(collected));
    }
  }

  // ─── Active Quest Tracking ──────────────────────────────────────
  function setActiveQuest(scrollId) {
    localStorage.setItem('cafe_active_quest', JSON.stringify({
      scrollId: scrollId, dispensedAt: Date.now()
    }));
  }

  function getActiveQuest() {
    try { return JSON.parse(localStorage.getItem('cafe_active_quest')); }
    catch (e) { return null; }
  }

  function clearActiveQuest() { localStorage.removeItem('cafe_active_quest'); }

  // ─── Dynamic Scroll Dispenser ───────────────────────────────────
  function dispense(context) {
    var unlocked = getUnlockedScrolls();
    var candidates = unlocked.filter(function (s) {
      return s.category === context.category;
    });
    if (candidates.length === 0) candidates = unlocked;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ─── Diegetic Scroll UI (Cruz's Napkin) ─────────────────────────
  // Renders the four-part Vibe Coding structure with colored labels
  function showScroll(scroll, onClose) {
    var overlay = document.createElement('div');
    _css(overlay, {
      position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
      background: 'rgba(0,0,0,0)', zIndex: '20000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'background 0.5s ease',
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { overlay.style.background = 'rgba(0,0,0,0.75)'; });
    });

    var cat = CATEGORIES[scroll.category] || { icon: '📜', name: '未知卷軸' };

    // Parchment panel
    var parchment = document.createElement('div');
    _css(parchment, {
      background: 'linear-gradient(135deg, #2c1f14 0%, #1a120a 100%)',
      border: '2px solid #8b6914',
      borderRadius: '6px',
      padding: '20px',
      maxWidth: '440px',
      width: '92vw',
      maxHeight: '82vh',
      overflowY: 'auto',
      fontFamily: 'monospace',
      color: '#f0e6d2',
      boxShadow: '0 0 30px rgba(245,166,35,0.15), inset 0 0 20px rgba(0,0,0,0.3)',
      transform: 'scale(0.9) translateY(20px)',
      opacity: '0',
      transition: 'transform 0.4s ease, opacity 0.4s ease',
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        parchment.style.transform = 'scale(1) translateY(0)';
        parchment.style.opacity = '1';
      });
    });

    // Header
    var header = document.createElement('div');
    _css(header, { textAlign: 'center', marginBottom: '16px' });
    header.innerHTML =
      '<div style="font-size:11px;color:#5d4037;margin-bottom:4px">' + _esc(cat.icon + ' ' + cat.name) + '</div>' +
      '<div style="font-size:16px;color:#f5a623;font-weight:bold;letter-spacing:1px">📜 Cruz 的餐巾紙</div>' +
      '<div style="font-size:13px;color:#e8dcc8;margin-top:6px;font-weight:bold">' + _esc(scroll.title) + '</div>';

    // Structured prompt body — each section has a colored label
    var body = document.createElement('div');
    _css(body, { marginBottom: '12px' });

    var sections = [
      { icon: '🔮', label: '身分設定', color: '#a78bfa', text: scroll.persona },
      { icon: '🎯', label: '任務目標', color: '#60a5fa', text: scroll.mission },
      { icon: '🛡️', label: '絕對護欄', color: '#f87171', text: scroll.antiGoals },
      { icon: '✨', label: 'Vibe', color: '#fbbf24', text: scroll.vibe },
    ];

    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (!sec.text) continue;
      var block = document.createElement('div');
      _css(block, {
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(139,105,20,0.2)',
        borderLeft: '3px solid ' + sec.color,
        borderRadius: '0 4px 4px 0',
        padding: '10px 12px',
        marginBottom: '8px',
      });
      block.innerHTML =
        '<div style="font-size:11px;color:' + sec.color + ';font-weight:bold;margin-bottom:4px;letter-spacing:1px">' +
          sec.icon + ' 【' + _esc(sec.label) + '】</div>' +
        '<div style="font-size:12px;line-height:1.7;color:#e8dcc8;white-space:pre-wrap;word-break:break-word">' +
          _esc(sec.text) + '</div>';
      body.appendChild(block);
    }

    // Hint
    var hint = document.createElement('div');
    _css(hint, { fontSize: '11px', color: '#8b6914', fontStyle: 'italic', textAlign: 'center', marginBottom: '14px' });
    hint.textContent = '「' + (scroll.hint || '') + '」';

    // Footer instruction
    var footer = document.createElement('div');
    _css(footer, { fontSize: '10px', color: '#5d4037', textAlign: 'center', marginBottom: '14px', lineHeight: '1.5' });
    footer.textContent = '點擊「收下卷軸」複製到剪貼簿。\n帶著這個架構，去告訴 AI 你真正的感覺。';

    // Buttons
    var btnRow = document.createElement('div');
    _css(btnRow, { display: 'flex', gap: '8px', justifyContent: 'center' });

    var fullPrompt = assemblePrompt(scroll);
    var copyBtn = _makeBtn('📋 收下卷軸', '#f5a623', function () {
      _copyToClipboard(fullPrompt);
      copyBtn.textContent = '✓ 已複製到剪貼簿';
      copyBtn.style.background = 'rgba(46,125,50,0.6)';
      collectScroll(scroll.id);
      setActiveQuest(scroll.id);
      if (window.CafeAudio && window.CafeAudio.playInteract) window.CafeAudio.playInteract();
      setTimeout(function () { _closeOverlay(overlay, onClose); }, 1200);
    });
    copyBtn.title = '複製後，貼到 ChatGPT、Claude 或 Gemini 施放';

    var closeBtn = _makeBtn('放回去', '#5d4037', function () {
      _closeOverlay(overlay, onClose);
    });

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(closeBtn);

    parchment.appendChild(header);
    parchment.appendChild(body);
    parchment.appendChild(hint);
    parchment.appendChild(footer);
    parchment.appendChild(btnRow);
    overlay.appendChild(parchment);
    document.body.appendChild(overlay);

    function onKey(e) { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); _closeOverlay(overlay, onClose); } }
    document.addEventListener('keydown', onKey);
  }

  // ─── Grimoire UI (Bookshelf) ────────────────────────────────────
  function openGrimoire(onClose) {
    var unlocked = getUnlockedScrolls();
    var locked = getLockedScrolls();
    var collected = getCollectedScrolls();

    var overlay = document.createElement('div');
    _css(overlay, {
      position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
      background: 'rgba(0,0,0,0)', zIndex: '20000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'background 0.5s ease',
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { overlay.style.background = 'rgba(0,0,0,0.8)'; });
    });

    var panel = document.createElement('div');
    _css(panel, {
      background: 'linear-gradient(180deg, #1a120a 0%, #0d0906 100%)',
      border: '2px solid #8b6914',
      borderRadius: '8px',
      padding: '20px',
      maxWidth: '500px',
      width: '92vw',
      maxHeight: '85vh',
      overflowY: 'auto',
      fontFamily: 'monospace',
      color: '#f0e6d2',
      boxShadow: '0 0 40px rgba(245,166,35,0.1)',
      transform: 'scale(0.95)',
      opacity: '0',
      transition: 'transform 0.3s ease, opacity 0.3s ease',
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { panel.style.transform = 'scale(1)'; panel.style.opacity = '1'; });
    });

    // Title
    var title = document.createElement('div');
    _css(title, { textAlign: 'center', marginBottom: '20px' });
    title.innerHTML =
      '<div style="font-size:18px;color:#f5a623;font-weight:bold;letter-spacing:3px">📚 共鳴詠唱書架</div>' +
      '<div style="font-size:11px;color:#5d4037;margin-top:4px">The Grimoire — Vibe Coding 心法卷軸</div>' +
      '<div style="font-size:11px;color:#8b6914;margin-top:2px">' +
        unlocked.length + ' / ' + SCROLL_LIBRARY.length + ' 已解鎖</div>';

    panel.appendChild(title);

    // Group by category
    var catKeys = Object.keys(CATEGORIES);
    for (var ci = 0; ci < catKeys.length; ci++) {
      var catKey = catKeys[ci];
      var cat = CATEGORIES[catKey];
      var catScrolls = SCROLL_LIBRARY.filter(function (s) { return s.category === catKey; });
      if (catScrolls.length === 0) continue;

      var section = document.createElement('div');
      _css(section, { marginBottom: '16px' });
      section.innerHTML = '<div style="font-size:13px;color:#f5a623;margin-bottom:8px;border-bottom:1px solid rgba(139,105,20,0.3);padding-bottom:4px">' +
        cat.icon + ' ' + _esc(cat.name) + ' <span style="color:#5d4037;font-size:11px">— ' + _esc(cat.desc) + '</span></div>';

      for (var si = 0; si < catScrolls.length; si++) {
        var scroll = catScrolls[si];
        var isUnlocked = unlocked.indexOf(scroll) !== -1;
        var isCollected = collected.indexOf(scroll.id) !== -1;

        var item = document.createElement('div');
        _css(item, {
          padding: '8px 10px',
          marginBottom: '4px',
          borderRadius: '4px',
          cursor: isUnlocked ? 'pointer' : 'default',
          background: isCollected ? 'rgba(245,166,35,0.08)' : 'rgba(255,255,255,0.02)',
          border: '1px solid ' + (isCollected ? 'rgba(245,166,35,0.2)' : 'rgba(255,255,255,0.05)'),
          transition: 'background 0.2s',
          opacity: isUnlocked ? '1' : '0.4',
        });

        if (isUnlocked) {
          item.innerHTML =
            '<span style="font-size:12px;color:#e8dcc8">' + _esc(scroll.title) + '</span>' +
            (isCollected ? ' <span style="font-size:10px;color:#f5a623">✦ 已收集</span>' : '');
          (function (s, isC) {
            item.addEventListener('click', function () {
              _closeOverlay(overlay, null);
              showScroll(s, onClose);
            });
            item.addEventListener('mouseenter', function () { item.style.background = 'rgba(245,166,35,0.12)'; });
            item.addEventListener('mouseleave', function () { item.style.background = isC ? 'rgba(245,166,35,0.08)' : 'rgba(255,255,255,0.02)'; });
          })(scroll, isCollected);
        } else {
          item.innerHTML =
            '<span style="font-size:12px;color:#5d4037">🔒 再來 ' + scroll.unlockAt + ' 次解鎖</span>';
        }

        section.appendChild(item);
      }
      panel.appendChild(section);
    }

    var closeBtn = _makeBtn('關上書架', '#5d4037', function () {
      _closeOverlay(overlay, onClose);
    });
    _css(closeBtn, { display: 'block', margin: '16px auto 0', width: 'auto' });
    panel.appendChild(closeBtn);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    function onKey(e) { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); _closeOverlay(overlay, onClose); } }
    document.addEventListener('keydown', onKey);
  }

  // ─── Hero's Return ──────────────────────────────────────────────
  function checkReturn() {
    var quest = getActiveQuest();
    if (!quest) return null;
    if (Date.now() - quest.dispensedAt < 30 * 60 * 1000) return null;
    return quest;
  }

  function settleReturn(success) {
    var quest = getActiveQuest();
    if (!quest) return;
    clearActiveQuest();
    if (success) {
      var xp = parseInt(localStorage.getItem('cafe_scroll_xp') || '0', 10) + 50;
      localStorage.setItem('cafe_scroll_xp', String(xp));
      var visits = parseInt(localStorage.getItem('cafe_visit_count') || '0', 10);
      localStorage.setItem('cafe_visit_count', String(visits + 1));
    }
    return { xp: success ? 50 : 0, totalXp: parseInt(localStorage.getItem('cafe_scroll_xp') || '0', 10) };
  }

  // ─── Cruz's Bartender-Style Guidance ────────────────────────────
  // Cruz doesn't say "use this prompt". He guides the player to find their own Vibe.
  function cruzDispenseScroll(category) {
    var scroll = dispense({ category: category || 'blade' });
    if (!scroll) return;

    // Step 1: Receive emotion (Cruz catches the feeling first)
    var receive = [
      '（Cruz 把一杯剛沖好的淺焙推過來。）\n\n「先不要想你要『做什麼』。喝口這個。」',
      '（Cruz 放下手上正在擦的杯子，安靜地看著你。）\n\n「⋯⋯聽起來你已經想了很久了。」',
      '（Cruz 把咖啡放在桌上，杯子底下壓著一張摺好的餐巾紙。）\n\n「我以前也遇過一樣的事。」',
    ];

    // Step 2: Guide to Vibe (Cruz helps find the feeling)
    var guide = [
      '「關鍵不是你要 AI 做什麼 — 而是你希望它用什麼頻率跟你共振。」\n「想像一下：如果這件事做完了，你希望看到的那個結果，它的語氣是什麼？」',
      '「大部分人跟 AI 說話像在填表格。但你想想，你跟你最信任的朋友求助時，你會怎麼開口？」\n「那種口氣，就是你的咒語。」',
      '「我教你一個心法：先告訴 AI 你是誰，再告訴它不准做什麼。」\n「護欄比方向更重要 — 因為 AI 最擅長的就是偏離。」',
    ];

    // Step 3: Dispense scroll
    var dispenseLines = [
      '（Cruz 從圍裙口袋裡掏出一張寫滿字的餐巾紙。）\n\n「我幫你把架構寫好了。你只需要在 [括號] 裡填入你自己的話。」\n「帶去找城裡的魔像 — ChatGPT、Claude、Gemini 都行。把上面的字唸給他們聽。」',
      '（Cruz 把餐巾紙推過來，上面的字跡工整但帶著咖啡漬。）\n\n「這不只是一段指令。這是一個架構 — 身分、目標、護欄、語氣。」\n「學會這四個東西，你就不需要我了。去吧。」',
    ];

    var r = receive[Math.floor(Math.random() * receive.length)];
    var g = guide[Math.floor(Math.random() * guide.length)];
    var d = dispenseLines[Math.floor(Math.random() * dispenseLines.length)];

    if (window.CafeDialogue) {
      // Three-beat dialogue: receive → guide → dispense
      window.CafeDialogue.show({
        speaker: 'Cruz ☕', speakerColor: '#f5a623', text: r,
      }).then(function () {
        return window.CafeDialogue.show({
          speaker: 'Cruz ☕', speakerColor: '#f5a623', text: g,
        });
      }).then(function () {
        return window.CafeDialogue.show({
          speaker: 'Cruz ☕', speakerColor: '#f5a623', text: d,
        });
      }).then(function () {
        showScroll(scroll);
      });
    } else {
      showScroll(scroll);
    }
  }

  // Cruz's hero return — teaches Vibe Coding principles
  function cruzCheckReturn() {
    var quest = checkReturn();
    if (!quest) return false;
    var scroll = SCROLL_LIBRARY.find(function (s) { return s.id === quest.scrollId; });
    var scrollName = scroll ? scroll.title : '那張餐巾紙';

    if (window.CafeDialogue) {
      window.CafeDialogue.show({
        speaker: 'Cruz ☕',
        speakerColor: '#f5a623',
        text: '（Cruz 注意到你回來了，微微揚起下巴。）\n\n「上次那張「' + scrollName + '」⋯⋯城裡的魔像有回應你嗎？」',
        options: [
          { label: '有的，很有用', value: 'success', trait: 'action' },
          { label: '還在研究中', value: 'pending' },
          { label: '效果不太好', value: 'failed' },
        ],
      }).then(function (choice) {
        if (choice === 'success') {
          var result = settleReturn(true);
          _showXpPopup(result.xp);
          // Teach a Vibe Coding principle as reward
          var lessons = [
            '「很好。你知道為什麼有用嗎？因為你給了它一個身分，而不只是一個任務。」\n「記住：AI 不怕複雜的問題 — 它怕的是空洞的問題。」',
            '「下次試試把護欄寫得更狠一點。告訴它『禁止用哪些詞』，你會發現它突然變聰明了。」\n「因為你切掉了它最愛走的捷徑。」',
            '「學會了吧？真正的力量不是魔像的 — 是你設定頻率的能力。」\n「同一個咒語，有 Vibe 跟沒 Vibe，差了十條街。」',
            '「不錯。下次可以試試在開頭加一句情境描述：『我們正坐在⋯⋯』」\n「這不是廢話 — 這是在幫 AI 建立一個『空間』讓它在裡面思考。」',
          ];
          window.CafeDialogue.show({
            speaker: 'Cruz ☕', speakerColor: '#f5a623',
            text: '（Cruz 滿意地點了點頭。）\n\n' + lessons[Math.floor(Math.random() * lessons.length)],
          });
        } else if (choice === 'failed') {
          settleReturn(false);
          window.CafeDialogue.show({
            speaker: 'Cruz ☕', speakerColor: '#f5a623',
            text: '「沒關係。失敗的咒語比成功的更值錢 — 因為它告訴你邊界在哪。」\n\n' +
              '「試試這樣：把 AI 的回覆貼回去，然後跟它說『這不是我要的，我要的感覺是⋯⋯』」\n' +
              '「用感覺去修正，比用邏輯修正快三倍。」\n\n（Cruz 推過一杯新的咖啡。）',
          });
        } else {
          window.CafeDialogue.show({
            speaker: 'Cruz ☕', speakerColor: '#f5a623',
            text: '「不急。有時候卷軸需要等正確的時機才施放。」\n「但記住 — 別等到完美。先施放，再修正。」',
          });
        }
      });
    }
    return true;
  }

  // ─── Utility ────────────────────────────────────────────────────
  function _css(el, styles) { Object.assign(el.style, styles); }

  function _esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function _makeBtn(text, borderColor, onClick) {
    var btn = document.createElement('button');
    _css(btn, {
      background: 'rgba(26,18,11,0.9)',
      border: '1px solid ' + borderColor,
      color: '#f0e6d2',
      fontFamily: 'monospace',
      fontSize: '13px',
      padding: '8px 16px',
      borderRadius: '4px',
      cursor: 'pointer',
      transition: 'background 0.2s, transform 0.1s',
    });
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    btn.addEventListener('mouseenter', function () { btn.style.background = 'rgba(245,166,35,0.15)'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = 'rgba(26,18,11,0.9)'; });
    btn.addEventListener('mousedown', function () { btn.style.transform = 'scale(0.97)'; });
    btn.addEventListener('mouseup', function () { btn.style.transform = 'scale(1)'; });
    return btn;
  }

  function _closeOverlay(overlay, callback) {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (callback) callback();
    }, 300);
  }

  function _copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  function _showXpPopup(xp) {
    var popup = document.createElement('div');
    _css(popup, {
      position: 'fixed', top: '40%', left: '50%',
      transform: 'translate(-50%, -50%)',
      fontSize: '28px', fontFamily: 'monospace', fontWeight: 'bold',
      color: '#f5a623',
      textShadow: '0 0 20px rgba(245,166,35,0.6)',
      zIndex: '30000', pointerEvents: 'none',
      transition: 'transform 1.5s ease-out, opacity 1.5s ease-out',
    });
    popup.textContent = '+' + xp + ' EXP';
    document.body.appendChild(popup);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        popup.style.transform = 'translate(-50%, -50%) translateY(-60px)';
        popup.style.opacity = '0';
      });
    });
    setTimeout(function () { if (popup.parentNode) popup.parentNode.removeChild(popup); }, 2000);
  }

  // ─── Public API ─────────────────────────────────────────────────
  window.CafeScrollDispenser = {
    dispense: dispense,
    showScroll: showScroll,
    openGrimoire: openGrimoire,
    checkReturn: checkReturn,
    settleReturn: settleReturn,
    cruzDispenseScroll: cruzDispenseScroll,
    cruzCheckReturn: cruzCheckReturn,
    getUnlockedScrolls: getUnlockedScrolls,
    getCollectedScrolls: getCollectedScrolls,
    assemblePrompt: assemblePrompt,
    CATEGORIES: CATEGORIES,
    SCROLL_LIBRARY: SCROLL_LIBRARY,
  };
})();
