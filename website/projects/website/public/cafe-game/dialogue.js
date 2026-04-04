// CafeDialogue — RPG dialogue system for cafe game
// Zero dependencies, DOM-based, character-by-character with variable timing
(function () {
  const PAUSE = { ',': 120, '，': 120, '.': 240, '。': 240, '!': 60, '！': 60,
    '…': 100, '⋯': 100, '\n': 200, ' ': 30 };
  const SPEEDS = { 'Cruz ☕': 80, 'Cruz': 80, '北極同學': 70, '新星小姐': 35, '米拉小姐': 45, '參宿先生': 40, '天狼同學': 50 };
  const OBJ_SPEED = 30;
  let container, box, nameTag, textEl, indicator, optionsEl;
  let resolve, animId, charIdx, fullText, pages, pageIdx, opts, selIdx;
  let shakeCallback, open = false, animating = false;

  function css(el, s) { Object.assign(el.style, s); }

  function build() {
    box = document.createElement('div');
    css(box, { position: 'absolute', bottom: '0', left: '0', right: '0',
      background: 'rgba(26,18,11,0.92)', border: '2px solid #f5a623',
      padding: '12px', zIndex: '9999', display: 'none', boxSizing: 'border-box',
      fontFamily: 'monospace', color: '#f0e6d2', fontSize: '15px', lineHeight: '1.6',
      borderRadius: '4px 4px 0 0', userSelect: 'none',
      transform: 'translateY(20px)', opacity: '0',
      transition: 'transform 100ms ease-out, opacity 100ms ease-out' });
    nameTag = document.createElement('div');
    css(nameTag, { fontFamily: 'sans-serif', fontWeight: 'bold', fontSize: '13px',
      marginBottom: '6px', letterSpacing: '1px' });
    textEl = document.createElement('div');
    css(textEl, { minHeight: '48px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
    indicator = document.createElement('div');
    css(indicator, { textAlign: 'right', fontSize: '14px', opacity: '0', transition: 'opacity .2s' });
    indicator.textContent = '▼';
    optionsEl = document.createElement('div');
    css(optionsEl, { marginTop: '8px', display: 'none' });
    box.append(nameTag, textEl, indicator, optionsEl);
    container.appendChild(box);
  }

  function shake() {
    if (!shakeCallback) return;
    shakeCallback(2, 3);
  }

  function baseSpeed(speaker) {
    return SPEEDS[speaker] ?? OBJ_SPEED;
  }

  function paginate(text) {
    // Split into pages of ~120 chars at natural break points
    const MAX = 120;
    if (text.length <= MAX) return [text];
    const result = []; let buf = '';
    for (const ch of text) {
      buf += ch;
      if (buf.length >= MAX && (ch === '。' || ch === '.' || ch === '\n' || ch === '！' || ch === '!')) {
        result.push(buf); buf = '';
      }
    }
    if (buf) result.push(buf);
    return result.length ? result : [text];
  }

  function renderOptions() {
    optionsEl.innerHTML = '';
    if (!opts || !opts.length) { css(optionsEl, { display: 'none' }); return; }
    css(optionsEl, { display: 'block' });
    opts.forEach((o, i) => {
      const row = document.createElement('div');
      css(row, { padding: '4px 8px', cursor: 'pointer', borderRadius: '3px',
        background: i === selIdx ? 'rgba(245,166,35,0.25)' : 'transparent',
        color: i === selIdx ? '#f5a623' : '#f0e6d2', transition: 'all .1s',
        fontFamily: 'sans-serif', fontSize: '14px' });
      row.textContent = (i === selIdx ? '▸ ' : '  ') + o.label;
      row.onpointerdown = () => { selIdx = i; renderOptions(); };
      row.onpointerup = () => confirm();
      optionsEl.appendChild(row);
    });
  }

  function typeChar(speed) {
    if (charIdx >= fullText.length) { animating = false; doneTyping(); return; }
    // Nightfall interrupt: stop typing mid-sentence on force close
    if (window._cafeForceClose) {
      animating = false;
      clearTimeout(animId);
      // Show farewell text instead
      textEl.textContent = window._cafeFarewell || '今天的營業時間結束了。外面的風很舒服，去走走吧。我們明天見。';
      nameTag.textContent = '建築師';
      nameTag._speaker = '建築師';
      css(nameTag, { color: '#95a5a6' });
      doneTyping();
      return;
    }
    const ch = fullText[charIdx++];
    textEl.textContent += ch;
    if (window.CafeAudio && ch !== ' ' && ch !== '\n') CafeAudio.playBeep(nameTag._speaker);
    const extra = PAUSE[ch] || 0;
    animId = setTimeout(() => typeChar(speed), speed + extra);
  }

  function doneTyping() {
    const hasMore = pageIdx < pages.length - 1;
    const hasOpts = !hasMore && opts && opts.length;
    css(indicator, { opacity: hasMore ? '1' : '0' });
    if (hasOpts) { selIdx = 0; renderOptions(); }
  }

  function skipAnim() { clearTimeout(animId); textEl.textContent = fullText; animating = false; doneTyping(); }

  function confirm() {
    if (opts && opts.length) { close(opts[selIdx].value); }
    else { close(null); }
  }

  function advance(speaker) {
    if (window._cafeForceClose) { close(null); return; }
    if (animating) { skipAnim(); return; }
    if (pageIdx < pages.length - 1) {
      pageIdx++; showPage(speaker);
    } else { confirm(); }
  }

  function showPage(speaker) {
    fullText = pages[pageIdx]; charIdx = 0;
    textEl.textContent = ''; animating = true;
    css(indicator, { opacity: '0' });
    css(optionsEl, { display: 'none' });
    typeChar(baseSpeed(speaker));
  }

  function close(value) {
    clearTimeout(animId);
    open = false; animating = false;
    css(box, { display: 'none', transform: 'translateY(20px)', opacity: '0' });
    if (resolve) { const r = resolve; resolve = null; r(value); }
  }

  function handleKey(e) {
    if (!open) return;
    // Stop event from reaching engine while dialogue is open
    e.stopPropagation();
    const k = e.key;
    if (k === ' ' || k === 'Enter') { e.preventDefault(); advance(nameTag._speaker); }
    else if (opts && opts.length && !animating) {
      if (k === 'ArrowUp' || k === 'ArrowLeft') { selIdx = (selIdx - 1 + opts.length) % opts.length; renderOptions(); }
      else if (k === 'ArrowDown' || k === 'ArrowRight') { selIdx = (selIdx + 1) % opts.length; renderOptions(); }
    }
  }

  window.CafeDialogue = {
    init(el) {
      container = el;
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      build();
      document.addEventListener('keydown', handleKey);
      box.addEventListener('pointerdown', (e) => { if (e.target === box || e.target === textEl || e.target === indicator) advance(nameTag._speaker); });
    },

    show({ speaker, speakerColor, text, options }) {
      return new Promise((res) => {
        resolve = res;
        opts = options || null;
        nameTag.textContent = speaker || '';
        nameTag._speaker = speaker;
        css(nameTag, { color: speakerColor || '#f5a623' });
        pages = paginate(text); pageIdx = 0;
        open = true;
        css(box, { display: 'block' });
        // Trigger slide-in animation on next frame
        requestAnimationFrame(() => {
          css(box, { transform: 'translateY(0)', opacity: '1' });
        });
        shake();
        showPage(speaker);
      });
    },

    close() { close(null); },
    isOpen() { return open; },
    onShake(cb) { shakeCallback = cb; }
  };
})();
