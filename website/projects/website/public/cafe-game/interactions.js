/**
 * interactions.js — Engine/Map/Dialogue/NPC glue + Vercel API (localStorage fallback)
 */
;(function() {
  'use strict';
  var API = location.hostname === 'localhost' ? '' : 'https://thinker.cafe';
  var visitorId = null, coffeesSent = {}, notesSent = {}, cafeState = null, noteOpen = false;
  var dialogueCooldown = 0;

  function init() {
    visitorId = localStorage.getItem('cafe_visitor_id');
    if (!visitorId) {
      visitorId = 'v_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
      localStorage.setItem('cafe_visitor_id', visitorId);
    }
    try { coffeesSent = JSON.parse(localStorage.getItem('cafe_coffees') || '{}');
          notesSent = JSON.parse(localStorage.getItem('cafe_notes') || '{}'); } catch(e) {}
    window._visitorStreak = 0; window._visitorRecognized = false; window._recognitionShown = false;
    if (window.CafeNpcData && window.CafeNpcData.recordVisit) window.CafeNpcData.recordVisit();
    post('/api/cafe/visit', { visitorId: visitorId, path: [] }).then(function(d) {
      window._visitorStreak = d.streak || 0; window._visitorRecognized = d.recognized || false;
    }).catch(function() {});
    fetch(API + '/api/cafe/state?visitorId=' + encodeURIComponent(visitorId)).then(function(r) { return r.json(); })
      .then(function(d) { cafeState = d; if (d.forceClose) triggerForceClose(); window._cafeAbsentDays = d.absentDays || 0; }).catch(function() {});
    window.CafeEngine.onInteract(handleInteract);
    window.addEventListener('beforeunload', function() {
      var log = lingerLog.slice(-50).map(function(l) { return [l.x, l.y, l.frames]; });
      if (log.length) navigator.sendBeacon(API + '/api/cafe/visit',
        new Blob([JSON.stringify({ visitorId: visitorId, path: log })], { type: 'application/json' }));
    });
  }

  function post(path, body) {
    return fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) }).then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.forceClose) triggerForceClose(d.farewell);
        return d;
      });
  }

  function triggerForceClose(farewell) {
    if (window._cafeForceClose) return; // already triggered
    window._cafeForceClose = true;
    window._cafeFarewell = farewell || '今天的營業時間結束了。外面的風很舒服，去走走吧。我們明天見。';
    // Nightfall: fade out all audio over 3 seconds
    if (window.CafeAudio && window.CafeAudio.fadeOut) CafeAudio.fadeOut();
  }

  function handleInteract(targetId, tileX, tileY) {
    if (noteOpen || (window.CafeDialogue && window.CafeDialogue.isOpen())) return;
    if (Date.now() < dialogueCooldown) return;
    var npcs = window.CafeNpcData ? window.CafeNpcData.getNpcs() : [];
    for (var n = 0; n < npcs.length; n++) { if (npcs[n].id === targetId) { handleNpc(targetId); return; } }
    var map = window.CafeMap, interaction = null;
    for (var i = 0; i < map.interactions.length; i++) {
      var it = map.interactions[i];
      if (it.tileX === tileX && it.tileY === tileY) { interaction = it; break; }
    }
    if (!interaction) return;
    if (interaction.type === 'npc') handleNpc(interaction.id);
    else if (interaction.type === 'object') handleObject(interaction.id);
    else if (interaction.type === 'grimoire') {
      // Bookshelf = Prompt Library (The Grimoire)
      if (window.CafeScrollDispenser) window.CafeScrollDispenser.openGrimoire();
    }
  }

  function handleNpc(npcId) {
    var data = window.CafeNpcData; if (!data) return;
    // Hero's Return: if talking to Cruz and player has an active quest, check return first
    if (npcId === 'cruz' && window.CafeScrollDispenser && window.CafeScrollDispenser.cruzCheckReturn()) return;
    var dlg;
    if (npcId === 'cruz') dlg = data.getDialogue('cruz');
    else if (npcId.indexOf('empty') === 0 || npcId === 'lastSeat') dlg = data.getObjectDialogue('empty');
    else dlg = data.getDialogue(npcId);
    if (!dlg) return;
    var notes = cafeState && cafeState.notes ? cafeState.notes.filter(function(n) { return n.npcId === npcId; }) : [];
    if (notes.length > 0) dlg.text += '\n（桌上壓著一張紙條：「' + notes[notes.length - 1].text + '」— 陌生人）';
    window.CafeDialogue.show(dlg).then(function(c) { dialogueCooldown = Date.now() + 300; if (c) handleChoice(npcId, c); });
  }

  function handleObject(objectId) {
    var data = window.CafeNpcData; if (!data) return;
    var dlg = data.getObjectDialogue(objectId); if (!dlg) return;
    window.CafeDialogue.show(dlg).then(function(c) { dialogueCooldown = Date.now() + 300;
      if (c === 'writeName') {
        showNameRegistration(objectId);
      }
    });
  }

  function sysMsg(text) { window.CafeDialogue.show({ speaker: '系統', speakerColor: '#95a5a6', text: text }); }

  // ── Personality Signal Collector ────────────────────────────────
  function recordPersonalitySignal(trait) {
    var signals = JSON.parse(localStorage.getItem('cafe_personality_signals') || '[]');
    signals.push({ type: trait, ts: Date.now() });
    // Keep last 100 signals
    if (signals.length > 100) signals = signals.slice(-100);
    localStorage.setItem('cafe_personality_signals', JSON.stringify(signals));
  }

  function getPersonalityProfile() {
    var signals = JSON.parse(localStorage.getItem('cafe_personality_signals') || '[]');
    var counts = { action: 0, analysis: 0, empathy: 0, inspiration: 0, influence: 0, explorer: 0 };
    signals.forEach(function(s) { if (counts[s.type] !== undefined) counts[s.type]++; });
    var total = signals.length;
    if (total < 3) return null; // Not enough data
    // Find dominant
    var max = 0, dominant = null;
    Object.keys(counts).forEach(function(k) { if (counts[k] > max) { max = counts[k]; dominant = k; } });
    return { dominant: dominant, counts: counts, total: total, confidence: max / total };
  }

  // Resolve which trait a chosen option carries, looking it up from the dialogue options
  function _resolveChoiceTrait(npcId, choice) {
    var npcData = window.CafeNpcData; if (!npcData) return null;
    var dlg;
    try {
      if (npcId === 'cruz') dlg = npcData.getDialogue('cruz');
      else if (npcId.indexOf('empty') === 0 || npcId === 'lastSeat') dlg = null;
      else dlg = npcData.getDialogue(npcId);
    } catch(e) { return null; }
    if (!dlg || !dlg.options) return null;
    for (var i = 0; i < dlg.options.length; i++) {
      var opt = dlg.options[i];
      if ((opt.value === choice || opt.action === choice) && opt.trait) return opt.trait;
    }
    return null;
  }

  function handleChoice(npcId, choice) {
    // Record personality signal if this choice carries a trait
    var trait = _resolveChoiceTrait(npcId, choice);
    if (trait) recordPersonalitySignal(trait);

    if (choice === 'coffee') {
      if (window.CafeAudio) CafeAudio.playCoffee();
      post('/api/cafe/coffee', { npcId: npcId, visitorId: visitorId }).then(function(d) {
        coffeesSent[npcId] = (coffeesSent[npcId] || 0) + 1;
        localStorage.setItem('cafe_coffees', JSON.stringify(coffeesSent));
        sysMsg('你默默地把一杯咖啡放在桌上。\n（今天有 ' + d.today + ' 杯咖啡被送出。）');
      }).catch(function() {
        coffeesSent[npcId] = (coffeesSent[npcId] || 0) + 1;
        localStorage.setItem('cafe_coffees', JSON.stringify(coffeesSent));
        sysMsg('你默默地把一杯咖啡放在桌上。');
      });
    } else if (choice === 'note') { showNoteInput(npcId); }
    else if (choice === 'writeName') { showNameRegistration(npcId); }
    else if (choice === 'data') { showCruzData(); }
    else if (choice === 'chat') { showCruzChat(); }
    else if (choice === 'scroll_shield') { if (window.CafeScrollDispenser) window.CafeScrollDispenser.cruzDispenseScroll('shield'); }
    else if (choice === 'scroll_blade') { if (window.CafeScrollDispenser) window.CafeScrollDispenser.cruzDispenseScroll('blade'); }
    else if (choice === 'scroll_arcane') { if (window.CafeScrollDispenser) window.CafeScrollDispenser.cruzDispenseScroll('arcane'); }
    else if (choice === 'scroll_forge') { if (window.CafeScrollDispenser) window.CafeScrollDispenser.cruzDispenseScroll('forge'); }
    else if (choice === 'scroll_sight') { if (window.CafeScrollDispenser) window.CafeScrollDispenser.cruzDispenseScroll('sight'); }
  }

  function showCruzData() {
    var data = window.CafeNpcData;
    if (!data || !data.getFounder) { sysMsg('Cruz 的數據暫時無法讀取。'); return; }
    var f = data.getFounder();
    var text = '「你要看數據？」\n（Cruz 把一本破舊的筆記本推過來。）\n\n';
    text += '📅 第 ' + (f.days || '?') + ' 天\n\n';

    // Dynamic streaks
    var st = f.streaks || {};
    var stKeys = Object.keys(st);
    if (stKeys.length > 0) {
      text += '── 連續紀錄 ──\n';
      for (var i = 0; i < stKeys.length; i++) {
        text += stKeys[i] + '：' + st[stKeys[i]] + ' 天\n';
      }
      text += '\n';
    }

    // Dynamic energy
    var en = f.energy || {};
    var enKeys = Object.keys(en);
    if (enKeys.length > 0) {
      text += '── 能量狀態 ──\n';
      for (var j = 0; j < enKeys.length; j++) {
        // Truncate long values to first line
        var val = String(en[enKeys[j]]).split('\n')[0];
        text += enKeys[j] + '：' + val + '\n';
      }
    }

    text += '\n「看完了嗎？數字只是影子。」';
    window.CafeDialogue.show({ speaker: 'Cruz ☕', speakerColor: '#f5a623', text: text,
      options: [{ label: '🚪 謝謝', value: 'leave' }] });
  }

  function showCruzChat() {
    var msgs = [
      '「這個位子⋯⋯以前是我的。現在是所有人的。」\n\n（Cruz 看著窗外的月光。）」',
      '「你知道嗎，這裡的咖啡不加糖。」「因為苦才能嚐出甜。」',
      '「學生問我什麼時候可以畢業。」「我說——當你不再需要這個問題的時候。」',
      '「曾經有人凌晨三點來這裡，只為了坐在空椅子上。」「什麼都沒點。什麼都沒說。」「坐了兩個小時。」「第二天他開始了他的第一天。」',
    ];
    var msg = msgs[Math.floor(Math.random() * msgs.length)];
    window.CafeDialogue.show({ speaker: 'Cruz ☕', speakerColor: '#f5a623', text: msg,
      options: [{ label: '🚪 安靜離開', value: 'leave' }] });
  }

  function showNameRegistration(seatId) {
    // Check if already registered
    var reg = localStorage.getItem('cafe_registration');
    if (reg) {
      try {
        var parsed = JSON.parse(reg);
        sysMsg('你已經在等候名單上了。\n你的星星代號：' + parsed.title + '\n「' + parsed.why + '」\n\n第 ' + parsed.position + ' 位等候者。');
        return;
      } catch(e) {}
    }
    noteOpen = true;
    var overlay = el('div', { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
      background: 'rgba(0,0,0,0.7)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' });
    var panel = el('div', { background: 'rgba(26,18,11,0.97)', border: '2px solid #f5a623', color: '#fdf6e3',
      fontFamily: 'monospace', padding: '20px', borderRadius: '8px', width: '340px', maxWidth: '90vw', boxSizing: 'border-box' });
    var title = el('div', { fontSize: '16px', marginBottom: '6px', color: '#f5a623', fontWeight: 'bold', textAlign: 'center' },
      { textContent: '留給下一個想改變的人' });
    var subtitle = el('div', { fontSize: '12px', marginBottom: '14px', color: '#95a5a6', textAlign: 'center', lineHeight: '1.5' },
      { textContent: '寫下你的名字。\n這不是承諾，只是開始。' });
    var input = el('input', { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.1)',
      border: '1px solid #f5a623', color: '#fdf6e3', fontFamily: 'monospace', padding: '10px', fontSize: '15px',
      borderRadius: '4px', outline: 'none', textAlign: 'center' }, { type: 'text', maxLength: 30, placeholder: '你的名字' });
    var footer = el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '14px' });
    var hint = el('span', { fontSize: '11px', color: '#5d4037' }, { textContent: '你會得到一顆屬於你的星星' });
    var btn = el('button', { background: '#f5a623', color: '#1a120b', border: 'none', padding: '8px 20px',
      fontFamily: 'monospace', fontSize: '14px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }, { textContent: '寫下' });

    function cleanup() { noteOpen = false; if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    function submit() {
      var name = input.value.trim();
      if (!name || name.length < 1) return;
      cleanup();
      // Immediate optimistic feedback
      if (window.CafeAudio) CafeAudio.playNoteSent();
      sysMsg('你拿起筆，在名單上寫下了自己的名字。\n⋯⋯\n正在為你尋找屬於你的星星。');
      post('/api/cafe/register', { visitorId: visitorId, name: name, seat: seatId || 'pending' })
        .then(function(d) {
          if (d.already) {
            sysMsg('你已經在名單上了。\n你的星星：' + d.star + '\n第 ' + (d.position || '?') + ' 位。');
            return;
          }
          // Save registration locally
          localStorage.setItem('cafe_registration', JSON.stringify({
            star: d.star, title: d.title, zh: d.zh, why: d.why, seat: d.seat, position: d.position
          }));
          window._cafeRegistration = d;
          var text = '⋯⋯\n\n';
          text += '筆跡還沒乾，天花板上彷彿有一顆星星亮了起來。\n\n';
          text += '你的星星：' + d.title + '（' + d.zh + '）\n';
          text += '「' + d.why + '」\n\n';
          text += '你是第 ' + d.position + ' 位在這裡寫下名字的人。\n';
          text += '\n（Cruz 沒有抬頭，但他微微點了一下。）';
          sysMsg(text);
        })
        .catch(function() {
          localStorage.setItem('cafe_want_seat', 'true');
          sysMsg('你寫下了名字。\n筆跡有點歪，但那是你的。\n\n（名單暫時無法連線，但你的名字已經在這裡了。）');
        });
    }
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') submit(); else if (e.key === 'Escape') cleanup();
      e.stopPropagation();
    });
    overlay.addEventListener('click', function(e) { if (e.target === overlay) cleanup(); });
    footer.append(hint, btn); panel.append(title, subtitle, input, footer);
    overlay.appendChild(panel); document.body.appendChild(overlay); input.focus();
  }

  function el(tag, styles, props) {
    var e = document.createElement(tag);
    if (styles) Object.assign(e.style, styles);
    if (props) for (var k in props) e[k] = props[k];
    return e;
  }

  function showNoteInput(npcId) {
    noteOpen = true;
    var overlay = el('div', { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
      background: 'rgba(0,0,0,0.6)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' });
    var panel = el('div', { background: 'rgba(26,18,11,0.95)', border: '2px solid #f5a623', color: '#fdf6e3',
      fontFamily: 'monospace', padding: '16px', borderRadius: '6px', width: '320px', maxWidth: '90vw', boxSizing: 'border-box' });
    var title = el('div', { fontSize: '14px', marginBottom: '10px', color: '#f5a623', fontWeight: 'bold' }, { textContent: '留一張紙條' });
    var input = el('input', { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.08)',
      border: '1px solid #f5a623', color: '#fdf6e3', fontFamily: 'monospace', padding: '8px', fontSize: '14px',
      borderRadius: '3px', outline: 'none' }, { type: 'text', maxLength: 50, placeholder: '寫幾個字給他...' });
    var footer = el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' });
    var counter = el('span', { fontSize: '12px', color: '#95a5a6' }, { textContent: '0/50' });
    var btn = el('button', { background: '#f5a623', color: '#1a120b', border: 'none', padding: '6px 16px',
      fontFamily: 'monospace', fontSize: '14px', borderRadius: '3px', cursor: 'pointer', fontWeight: 'bold' }, { textContent: '留下' });

    input.addEventListener('input', function() { counter.textContent = input.value.length + '/50'; });
    function cleanup() { noteOpen = false; if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    function submit() {
      var text = input.value.trim(); if (!text) return; cleanup();
      if (window.CafeAudio) CafeAudio.playNoteSent();
      post('/api/cafe/note', { npcId: npcId, text: text, visitorId: visitorId })
        .then(function() { sysMsg('你的紙條被壓在咖啡杯下面了。'); })
        .catch(function() {
          notesSent[npcId] = (notesSent[npcId] || 0) + 1;
          localStorage.setItem('cafe_notes', JSON.stringify(notesSent));
          sysMsg('你撕下一張紙，寫了幾個字，壓在咖啡杯下面。\n他不會知道是誰寫的。');
        });
    }
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') submit(); else if (e.key === 'Escape') cleanup();
      e.stopPropagation();
    });
    overlay.addEventListener('click', function(e) { if (e.target === overlay) cleanup(); });
    footer.append(counter, btn); panel.append(title, input, footer);
    overlay.appendChild(panel); document.body.appendChild(overlay); input.focus();
  }

  // Ghost tracking (Kojima-style linger map)
  var lingerLog = [];
  function trackLinger() {
    if (!window.CafeEngine) return;
    var pos = window.CafeEngine.getPlayerPos(); if (!pos) return;
    var last = lingerLog[lingerLog.length - 1];
    if (last && last.x === pos.tileX && last.y === pos.tileY) last.frames++;
    else { lingerLog.push({ x: pos.tileX, y: pos.tileY, frames: 1 }); if (lingerLog.length > 200) lingerLog.shift(); }
  }

  window.CafeInteractions = {
    init: init,
    startGhostTracking: function() { setInterval(trackLinger, 500); },
    getVisitorId: function() { return visitorId; },
    getCoffeesSent: function() { return coffeesSent; },
    getLingerLog: function() { return lingerLog; },
    getState: function() { return cafeState; },
    getPersonalityProfile: getPersonalityProfile,
  };
})();
