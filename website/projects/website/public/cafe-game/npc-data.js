(function () {
  'use strict';
  var STAR_TO_ID = {
    '北極同學': 'polaris', '新星小姐': 'nova', '米拉小姐': 'mira',
    '參宿先生': 'rigel', '天狼同學': 'sirius'
  };
  var SEAT_POSITIONS = [
    { tileX: 3, tileY: 5, facing: 'down' }, { tileX: 6, tileY: 5, facing: 'down' },
    { tileX: 9, tileY: 5, facing: 'down' }, { tileX: 3, tileY: 6, facing: 'down' },
    { tileX: 6, tileY: 6, facing: 'down' }, { tileX: 9, tileY: 6, facing: 'down' }
  ];
  var STATUS_COLOR = { green: '#6ecf6e', yellow: '#f0c040', red: '#e05050' };
  var ENERGY_CUPS = { '高': 3, '中': 2, '低': 1 };
  function _buildNoteBoardDialogue() {
    var cafeState = null;
    try { cafeState = window.CafeInteractions ? window.CafeInteractions.getState() : null; } catch(e) {}
    var notes = (cafeState && cafeState.notes) ? cafeState.notes.slice(-20) : [];
    if (notes.length === 0) {
      return '（一面軟木板，上面釘著幾根圖釘，但還沒有紙條。）\n「留給下一位想鼓勵別人的人。」— Cruz';
    }
    var text = '（軟木板上釘著 ' + notes.length + ' 張紙條。有些字跡工整，有些歪歪扭扭。）\n';
    for (var i = notes.length - 1; i >= Math.max(0, notes.length - 8); i--) {
      var n = notes[i];
      var preview = n.text.length > 20 ? n.text.substring(0, 20) + '⋯' : n.text;
      var days = '';
      if (n.at) {
        var d = new Date(n.at);
        var now = new Date();
        var diff = Math.floor((now - d) / 86400000);
        days = diff === 0 ? '今天' : diff + '天前';
      }
      text += '\n「' + preview + '」— 給' + (n.npcId || '某人') + '，' + days;
    }
    if (notes.length > 8) text += '\n\n⋯還有更多。';
    return text;
  }

  var OBJECT_DIALOGUE = {
    newsWall: { speaker: '新聞牆', text: '牆上貼滿了 AI 科技新聞剪報。最新一則的日期是今天。' },
    bookshelf: { speaker: '書架', text: 'Cruz 推薦的書：《原子習慣》、《反脆弱》、《當下的力量》……' },
    warRoomDoor: { speaker: '戰情室', text: '門上寫著「戰情室」。門是鎖的。（教練專用）' },
    cat: { speaker: '黑貓', text: '喵。（黑貓眨了眨眼，繼續趴在窗台上曬月光。）' },
    openSign: { speaker: 'OPEN', text: '霓虹燈嗡嗡作響。這間咖啡廳永遠為你開著。' },
    noteBoard: null // handled dynamically in getObjectDialogue
  };
  var data = null, npcList = [], ghostNpcs = [];

  function timeGreeting() {
    var h = new Date().getHours();
    return h < 12 ? '早安' : h < 18 ? '午安' : '晚安';
  }
  function timeStr() {
    var d = new Date();
    return d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }
  function isNightMode() { var h = new Date().getHours(); return h >= 22 || h < 6; }
  function getCruzTalks() { return parseInt(localStorage.getItem('cafe_cruz_talks') || '0', 10); }
  function incCruzTalks() { localStorage.setItem('cafe_cruz_talks', String(getCruzTalks() + 1)); }

  // ── Barista Memory: visit tracking helpers ────────────────────
  function getVisitCount() {
    return parseInt(localStorage.getItem('cafe_visit_count') || '0', 10);
  }
  function getLastVisitTime() {
    return parseInt(localStorage.getItem('cafe_last_visit_ts') || '0', 10);
  }
  function getDaysSinceLastVisit() {
    var last = getLastVisitTime();
    if (!last) return -1; // first visit
    return Math.floor((Date.now() - last) / 86400000);
  }
  function isLateNight() {
    var h = new Date().getHours();
    return h >= 0 && h < 5;
  }
  function recordVisit() {
    var count = getVisitCount() + 1;
    localStorage.setItem('cafe_visit_count', String(count));
    localStorage.setItem('cafe_last_visit_ts', String(Date.now()));
  }

  // ── Progressive Trust Ladder ─────────────────────────────────
  function getFirstVisit() {
    var d = localStorage.getItem('cafe_first_visit');
    if (!d) { d = new Date().toISOString(); localStorage.setItem('cafe_first_visit', d); }
    return new Date(d);
  }
  function getTrustDays() {
    return Math.floor((Date.now() - getFirstVisit().getTime()) / 86400000);
  }
  // 0: 定向期(0-7), 1: 探索期(8-30), 2: 情感交換(31-90), 3: 穩定交換(91+)
  function getTrustTier() {
    var d = getTrustDays();
    return d < 8 ? 0 : d < 31 ? 1 : d < 91 ? 2 : 3;
  }
  var TIER_LABELS = ['臨時紙杯', '專屬瓷杯', '刻名座位', '咖啡廳鑰匙'];
  var TIER_NAMES = ['定向期', '探索期', '情感交換', '穩定交換'];

  function buildNpcs() {
    npcList = []; ghostNpcs = [];
    if (!data) return;
    if (data.founder) {
      npcList.push({
        id: 'cruz', displayName: 'Cruz', color: '#f5a623',
        status: data.founder.status || 'green',
        tileX: 4, tileY: 2, facing: 'down', _src: data.founder
      });
    }
    var seats = data.seats || [], night = isNightMode();
    for (var i = 0; i < seats.length && i < SEAT_POSITIONS.length; i++) {
      var s = seats[i], pos = SEAT_POSITIONS[i];
      var npc = {
        id: STAR_TO_ID[s.id] || s.id, displayName: s.id,
        color: STATUS_COLOR[s.status] || '#aaa', status: s.status,
        tileX: pos.tileX, tileY: pos.tileY, facing: pos.facing, _src: s
      };
      (night && s.evening === null ? ghostNpcs : npcList).push(npc);
    }
  }

  function studentDialogue(s, night) {
    var p = night ? '（深夜了，' + s.id + '還在。）\n' : '';
    // Check coffee history for this NPC
    var npcKey = STAR_TO_ID[s.id] || s.id;
    var coffeeCount = 0;
    try {
      var ci = window.CafeInteractions;
      if (ci) { var st = ci.getState(); if (st && st.coffees) coffeeCount = st.coffees[npcKey] || 0; }
      if (!coffeeCount) {
        var lc = JSON.parse(localStorage.getItem('cafe_coffees') || '{}');
        if (typeof lc === 'object') coffeeCount = lc[npcKey] || 0;
      }
    } catch(e) {}
    var coffeeLine = '';
    if (coffeeCount >= 3) {
      coffeeLine = '（桌上擺著 ' + coffeeCount + ' 個空咖啡杯。都是你送的。）\n';
    } else if (coffeeCount >= 1) {
      coffeeLine = '（桌上有一杯你之前送的咖啡。）\n';
    }
    var line = s.status === 'green'
      ? '（' + s.id + '抬起頭，微微一笑。）\n「第 ' + s.days + ' 天了。還不錯。」'
      : s.status === 'yellow'
        ? '（' + s.id + '揉了揉眼睛。）\n「' + s.quest_title + '⋯⋯有點卡住了。」'
        : '（' + s.id + '沒有說話。桌上的咖啡已經冷了。）';
    if (coffeeCount >= 3) {
      line += '\n「⋯⋯你每次來都送咖啡。」\n（' + s.id + '頓了頓。）\n「謝謝。」';
    } else if (coffeeCount >= 1 && s.status !== 'red') {
      line += '\n（' + s.id + '看了看桌上的咖啡杯，嘴角動了一下。）';
    }
    if (s.status_text) line += '\n（' + s.status_text + '）';
    // Consecutive-day visitor recognition (once per session)
    var streak = window._visitorStreak || 0;
    var recognized = window._visitorRecognized || false;
    if (recognized && streak >= 3 && !window._recognitionShown) {
      window._recognitionShown = true;
      line = '（' + s.id + '抬起頭，看了你一眼。）\n「⋯⋯你昨天也來了對吧。」\n' + line;
    }
    // ── Trust tier dialogue layer ──
    var tier = getTrustTier(), trustDays = getTrustDays();
    if (tier >= 2 && s.status !== 'red') {
      // 情感交換: reveal confusions and goals
      var extra31 = [
        '（' + s.id + '停頓了一下。）\n「⋯⋯有時候我會想，走這條路到底對不對。」',
        '（' + s.id + '放下手中的東西。）\n「你知道嗎？第 ' + s.days + ' 天比第一天還難。」',
        '（' + s.id + '看了看窗外的天空。）\n「我有一個目標。不是什麼了不起的東西⋯⋯但很重要。」'
      ];
      line += '\n' + extra31[Math.floor(trustDays * 7 + s.days) % extra31.length];
    }
    if (tier >= 3) {
      // 穩定交換: core values, shared memory
      var extra90 = [
        '\n（' + s.id + '笑了，不是客氣那種。）\n「你每次來都坐那個位子。我注意到了。」',
        '\n（桌上多了一張小紙條，上面寫著「謝謝你一直來」。）\n（' + s.id + '假裝沒看到。）',
        '\n「' + trustDays + ' 天了。你知道這代表什麼嗎？」\n（' + s.id + '沒等你回答。）\n「代表你沒放棄。」'
      ];
      line += extra90[Math.floor(trustDays * 3 + s.days) % extra90.length];
    }
    return p + coffeeLine + line;
  }

  window.CafeNpcData = {
    async load(jsonUrl) {
      var resp = await fetch(jsonUrl || 'cafe-data-public.json');
      data = await resp.json(); buildNpcs(); return data;
    },
    getNpcs: function () {
      return npcList.map(function (n) {
        return { id: n.id, displayName: n.displayName, color: n.color,
          status: n.status, tileX: n.tileX, tileY: n.tileY, facing: n.facing };
      });
    },
    getDialogue: function (npcId) {
      var night = isNightMode();
      // Ghost NPC — gone for the night
      for (var g = 0; g < ghostNpcs.length; g++) {
        if (ghostNpcs[g].id === npcId) {
          var gn = ghostNpcs[g]._src;
          return { speaker: '空位', speakerColor: '#888',
            text: '（這張椅子上掛著一件外套。桌上有一杯冷掉的咖啡。）\n（' + gn.id + '今天走了。也許明天早上會回來。）',
            options: [{ label: '🚪 離開', value: 'leave' }] };
        }
      }
      // Cruz — progressive dialogue
      if (npcId === 'cruz' && data && data.founder) {
        var f = data.founder, st = f.streaks || {}, talks = getCruzTalks();
        incCruzTalks();
        var np = night ? '（深夜了，Cruz 還在。）\n' : '';
        if (talks === 0) return { speaker: 'Cruz ☕', speakerColor: '#f5a623',
          text: np + '「⋯⋯你站在那裡多久了？」\n（Cruz 擦了擦杯子，沒有抬頭。）\n「算了，坐下吧。咖啡在左邊。」',
          options: [{ label: '🚪 離開', value: 'leave' }] };
        if (talks === 1) return { speaker: 'Cruz ☕', speakerColor: '#f5a623',
          text: np + '「又來了。」\n（他把一杯咖啡推過來。）\n「這裡沒有菜單。你看到什麼，就是什麼。」',
          options: [{ label: '☕ 點一杯咖啡', value: 'coffee', trait: 'empathy' }, { label: '🚪 離開', value: 'leave' }] };
        var med = st['冥想連續天數'] || 0, fit = st['健身連續天數'] || 0;
        var cruzText = np + '「' + timeGreeting() + '。今天第 ' + (f.days || '?') + ' 天了。」\n（他看了看牆上的時鐘。）\n「冥想 ' + med + ' 天，健身 ' + fit + ' 天⋯⋯數字不重要，重要的是我還站在這裡。」';
        // ── Barista Memory: pattern-aware responses ──
        var visitCount = getVisitCount();
        var daysSince = getDaysSinceLastVisit();
        if (visitCount >= 6 && visitCount <= 10) {
          cruzText = np + '（你走到吧台前。一杯咖啡已經在那裡了。）\n' + cruzText;
        } else if (visitCount > 10) {
          cruzText = np + '（Cruz 沒有抬頭。但你的咖啡已經在老位子上了。）\n' + cruzText;
        }
        if (daysSince >= 3 && daysSince < 21) {
          cruzText += '\n\n「今天風比較大。」\n（他沒有看你，但這句話顯然是對你說的。）';
        } else if (daysSince === 0 && visitCount > 3) {
          // Same day return — silence, the cup is enough
        }
        if (isLateNight() && visitCount > 2) {
          cruzText += '\n\n「還沒睡啊。」\n（他繼續擦杯子。）';
        }
        // Acknowledge consecutive-day visitors
        var vStreak = window._visitorStreak || 0;
        if (vStreak >= 3) {
          cruzText += '\n\n「你連續來了 ' + vStreak + ' 天。」\n（他放下杯子。）\n「很少有人會這樣。」';
        }
        // ── Trust tier deepening ──
        var tier = getTrustTier(), trustDays = getTrustDays();
        // ── Kintsugi: absent visitor recognition ──
        var absentDays = window._cafeAbsentDays || 0;
        if (absentDays >= 90) {
          cruzText += '\n\n（Cruz 看著你，杯子停在半空中。）\n「⋯⋯' + absentDays + ' 天了。」\n（他放下杯子。杯身上有金色的裂痕。）\n「歡迎回來。這個位子一直空著。」';
        } else if (absentDays >= 60) {
          cruzText += '\n\n「你回來了。」\n（Cruz 沒有抬頭。他在擦一個有金色裂痕的杯子。）\n「' + absentDays + ' 天。不算久。⋯⋯也算久了。」';
        } else if (absentDays >= 21) {
          cruzText += '\n\n（Cruz 看了你一眼，從架上拿下一個杯子。）\n「這個杯子⋯⋯有人在的時候不會用。」\n（杯身上有一道金色的裂痕。修復過的痕跡。）\n「' + absentDays + ' 天。歡迎回來。」';
        }
        if (tier >= 1 && talks >= 3) {
          cruzText += '\n\n（Cruz 拿出一個杯子，不是紙杯。）\n「這個給你。不是一次性的那種。」';
        }
        if (tier >= 2) {
          cruzText += '\n\n「你來了 ' + trustDays + ' 天了。」\n（他沒有抬頭，但在笑。）\n「你知道嗎，這間咖啡廳⋯⋯是為了你們才開的。」';
        }
        if (tier >= 3) {
          cruzText += '\n\n（Cruz 從櫃台下面拿出一把舊鑰匙。）\n「這間店的鑰匙。不是真的，但你懂意思。」\n（他把鑰匙放在桌上。）\n「以後你來，不用敲門。」';
        }
        return { speaker: 'Cruz ☕', speakerColor: '#f5a623',
          text: cruzText,
          options: [{ label: '☕ 看看他的數據', value: 'data', trait: 'analysis' }, { label: '📝 聊聊', value: 'chat', trait: 'explorer' }, { label: '🔑 ' + TIER_LABELS[getTrustTier()] + '（第 ' + getTrustDays() + ' 天）', value: 'trust' }, { label: '🚪 離開', value: 'leave' }] };
      }
      // Students
      for (var i = 0; i < npcList.length; i++) {
        if (npcList[i].id === npcId && npcId !== 'cruz') {
          var s = npcList[i]._src;
          return { speaker: s.id, speakerColor: STATUS_COLOR[s.status] || '#aaa',
            text: studentDialogue(s, night),
            options: [{ label: '☕ 送他一杯咖啡', value: 'coffee', trait: 'empathy' }, { label: '📝 留張紙條鼓勵', value: 'note', trait: 'empathy' }, { label: '🚪 安靜離開', value: 'leave' }] };
        }
      }
      // Empty seat
      return { speaker: '空位', speakerColor: '#888',
        text: '（一張空椅子。桌上有人放了一張小卡片。）\n「留給下一個想改變的人。— Cruz」\n\n（椅背上掛著一件外套，好像有人曾經坐在這裡很久。）',
        options: [{ label: '⭐ 寫下你的名字', value: 'writeName', trait: 'influence' }, { label: '🚪 還沒準備好', value: 'leave' }] };
    },
    getObjectDialogue: function (objectId) {
      if (objectId === 'noteBoard') return _buildNoteBoardDialogue();
      if (objectId === 'clock')
        return { speaker: '時鐘', speakerColor: '#ccc', text: '現在是 ' + timeStr() + '。指針安靜地走著。' };
      if (objectId === 'coffeeMachine' && data) {
        var cups = (data.cafe_stats && data.cafe_stats.total_checkins) || 0;
        return { speaker: '咖啡機', speakerColor: '#8B4513', text: '咖啡機低聲嗡嗡作響。今天已經煮了 ' + cups + ' 杯。' };
      }
      var obj = OBJECT_DIALOGUE[objectId];
      return obj ? { speaker: obj.speaker, speakerColor: '#ccc', text: obj.text } : null;
    },
    getFounder: function () {
      if (!data || !data.founder) return null;
      var f = data.founder, st = f.streaks || {};
      var med = st['冥想連續天數'] || 0, fit = st['健身連續天數'] || 0;
      var text = timeGreeting() + '，歡迎回來。今天是我第 ' + f.days + ' 天站在這裡……' +
        '冥想 ' + med + ' 天了，健身 ' + fit + ' 天，身體比腦袋誠實。';
      if (f.status_text) text += '\n（' + f.status_text + '）';
      return { speaker: f.track_label + ' ' + f.id, speakerColor: STATUS_COLOR[f.status] || '#f0c040',
        text: text, options: [{ label: '☕ 看看他的數據', action: 'stats', trait: 'analysis' }, { label: '📝 聊聊', action: 'chat', trait: 'explorer' }, { label: '🚪 離開', action: 'leave' }],
        streaks: st, energy: f.energy };
    },
    getCoffeeCups: function (npcId) {
      for (var i = 0; i < npcList.length; i++) {
        if (npcList[i].id === npcId) {
          var e = npcList[i]._src.energy;
          return (e && ENERGY_CUPS[e['精力']]) || 1;
        }
      }
      if (data && data.founder) { var fe = data.founder.energy; return (fe && ENERGY_CUPS[fe['精力']]) || 1; }
      return 1;
    },
    getNotebookPage: function (npcId) {
      for (var i = 0; i < npcList.length; i++) {
        if (npcList[i].id === npcId) {
          var days = npcList[i]._src.days || 0;
          return { days: days, target: 90, ratio: Math.min(days / 90, 1) };
        }
      }
      return { days: 0, target: 90, ratio: 0 };
    },
    getCafeAmbience: function () {
      if (!data || !data.seats) return { mood: '安靜', label: '安靜' };
      var g = 0, y = 0, r = 0;
      data.seats.forEach(function (s) {
        if (s.status === 'green') g++; else if (s.status === 'yellow') y++; else if (s.status === 'red') r++;
      });
      if (r > g && r > y) return { mood: 'heavy', label: '有點沉重' };
      return (g >= y && g >= r) ? { mood: 'warm', label: '溫暖' } : { mood: 'quiet', label: '安靜' };
    },
    recordVisit: recordVisit
  };
})();
