(function () {
  'use strict';
  var TILE = 32, COLS = 15, ROWS = 11, W = COLS * TILE, H = ROWS * TILE;
  var MOVE_FRAMES = 6, STEP = 1000 / 60;
  var canvas, ctx, bgCanvas, bgCtx, map, sprites, npcs = [];
  var player = {
    tileX: 7, tileY: 10, pixelX: 0, pixelY: 0, facing: 'down',
    moving: false, moveT: 0, fromX: 0, fromY: 0, toX: 0, toY: 0
  };
  var adjacentSet = {};  // track which NPCs player is adjacent to (by index)
  var interactCb = null, moveCb = null, renderCb = null;
  var running = false, lastTime = 0;
  // ── Cinematic entry state ──
  var entryState = 0; // 0=not started, 1=waiting 5s, 2=cruz gazing, 3=spatial text, 4=done
  var entryStart = 0;
  var entryTextAlpha = 0;
  var entryTextTimer = 0;
  var ENTRY_WAIT = 5000;   // 5s silence before Cruz notices
  var ENTRY_GAZE = 500;    // 0.5s Cruz gaze before text
  var ENTRY_TEXT_DUR = 4000; // text display duration
  var ENTRY_LINE = '\u5916\u9762\u96E8\u5F88\u5927\u5427\uFF1F\u5148\u904E\u4F86\u5750\uFF0C\u5496\u5561\u6B63\u5728\u716E\u4E86\u3002';
  var inputBuffer = null;  // buffered direction for responsive movement
  var BOUNCE_CURVE = [-1, -2, -1, 0];
  var nightfallStart = 0, NIGHTFALL_DUR = 5000; // 5-second fade
  // ── Idle state tracking ──
  var lastIdleCheck = 0;
  var cachedIdleMinutes = 0;
  var IDLE_CHECK_INTERVAL = 5000;  // Check idle every 5 seconds
  var idleGazeTimer = 0;
  var idleGazeActive = false;
  var reducedMotion = false; // prefers-reduced-motion
  var grainCanvas = null, grainCtx = null; // film grain offscreen buffer
  var DIR = {
    up: { dx: 0, dy: -1 }, down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 }
  };

  function tileAt(x, y) {
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return 1;
    return map.collision ? map.collision[y * COLS + x] : 0;
  }
  function npcAt(x, y) {
    for (var i = 0; i < npcs.length; i++)
      if (npcs[i].tileX === x && npcs[i].tileY === y) return true;
    return false;
  }
  function npcIdAt(x, y) {
    for (var i = 0; i < npcs.length; i++)
      if (npcs[i].tileX === x && npcs[i].tileY === y) return npcs[i].id != null ? npcs[i].id : i;
    return null;
  }
  function facedTile() {
    var d = DIR[player.facing];
    return { x: player.tileX + d.dx, y: player.tileY + d.dy };
  }
  function lerp(a, b, t) { return a + (b - a) * (t * t * (3 - 2 * t)); }

  function drawBg() {
    bgCtx.clearRect(0, 0, W, H);
    if (!map || !map.floor) return;
    var useTiles = window.CafeTiles;
    for (var y = 0; y < ROWS; y++)
      for (var x = 0; x < COLS; x++) {
        if (useTiles) {
          useTiles.drawTile(bgCtx, map.floor[y * COLS + x], x, y, 'floor');
        } else {
          drawTile(bgCtx, map.floor[y * COLS + x], x, y);
        }
        if (map.walls) {
          var wid = map.walls[y * COLS + x];
          if (wid > 0) {
            if (useTiles) {
              useTiles.drawTile(bgCtx, wid, x, y, 'walls');
            } else {
              drawTile(bgCtx, wid, x, y);
            }
          }
        }
      }
    if (useTiles) useTiles.drawAmbience(bgCtx);
  }

  function drawTile(target, id, tx, ty) {
    if (!sprites || !sprites.image) {
      var c = ['#d4a574', '#8B6914', '#654321', '#4a7c59', '#a0522d'];
      target.fillStyle = c[id % c.length] || '#d4a574';
      target.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      return;
    }
    var cols = (sprites.image.width / TILE) | 0;
    var sx = (id % cols) * TILE, sy = ((id / cols) | 0) * TILE;
    target.drawImage(sprites.image, sx, sy, TILE, TILE, tx * TILE, ty * TILE, TILE, TILE);
  }

  function drawEntity(e, isPlayer) {
    var px = e.pixelX != null ? e.pixelX : e.tileX * TILE;
    var py = e.pixelY != null ? e.pixelY : e.tileY * TILE;
    var s = window.CafeSprites;
    var dir = e.facing || 'down';
    var t = Date.now();
    // Piano rare event: Cruz is away — skip his sprite, draw smoking cup instead
    if (!isPlayer && e.id === 'cruz' && window._cruzAtPiano) {
      if (s && s.drawSmokingCup) s.drawSmokingCup(ctx, px, py, t);
      return { x: px, y: py, w: TILE, h: TILE };
    }
    if (s && isPlayer) {
      var frame = player.moving ? (Math.floor(player.moveT / 3) % 2) : 0;
      s.drawPlayer(ctx, px, py, dir, frame);
    } else if (s && !isPlayer && e.id) {
      s.drawNpc(ctx, px, py, e.id, dir, e.status || 'green');
      s.drawStatusDot(ctx, px + 12, py - 4, e.status || 'green', t);
    } else {
      // Fallback: colored square
      ctx.fillStyle = isPlayer ? '#e63946' : '#457b9d';
      ctx.fillRect(px + 4, py + 4, TILE - 8, TILE - 8);
      ctx.fillStyle = '#fff';
      var ex = px + 10, ey = py + 10;
      if (dir === 'right') ex = px + 18;
      if (dir === 'up') ey = py + 6;
      if (dir === 'down') ey = py + 18;
      ctx.fillRect(ex, ey, 4, 4); ctx.fillRect(ex + 8, ey, 4, 4);
    }
    return { x: px, y: py, w: TILE, h: TILE };
  }

  function drawBubble(px, py) {
    var bx = px + 4, by = py - 20;
    var s = window.CafeSprites;
    if (s && s.drawPrompt) {
      s.drawPrompt(ctx, px + 8, py - 14, Date.now());
    } else {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
      ctx.fillRect(bx + 4, by + 6, 16, 14); ctx.strokeRect(bx + 4, by + 6, 16, 14);
      ctx.fillStyle = '#e63946'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('!', bx + 12, by + 17);
    }
    // Return oversized rect to cover bounce animation range
    return { x: bx, y: by, w: 24, h: 22 };
  }

  function scaleCanvas() {
    var r = Math.min(window.innerWidth / W, window.innerHeight / H);
    canvas.style.width = (W * r) + 'px';
    canvas.style.height = (H * r) + 'px';
  }

  function restoreBg() {
    // Full redraw from bg — 480x352 is trivial, eliminates all ghost artifacts
    ctx.drawImage(bgCanvas, 0, 0);
  }

  function update() {
    if (!player.moving) return;
    player.moveT++;
    var t = Math.min(player.moveT / MOVE_FRAMES, 1);
    player.pixelX = lerp(player.fromX, player.toX, t) | 0;
    player.pixelY = lerp(player.fromY, player.toY, t) | 0;
    if (t >= 1) {
      player.tileX = (player.toX / TILE) | 0;
      player.tileY = (player.toY / TILE) | 0;
      player.pixelX = player.toX;
      player.pixelY = player.toY;
      player.moving = false;
      if (moveCb) moveCb(player.tileX, player.tileY);
      // Execute buffered input
      if (inputBuffer) {
        var d = inputBuffer; inputBuffer = null;
        movePlayer(d);
      }
    }
  }

  function render() {
    // Full bg redraw (480x352 is trivial)
    restoreBg();

    // Update NPC facing toward player when close + micro-bounce on first adjacency
    var newAdjacentSet = {};
    for (var i = 0; i < npcs.length; i++) {
      var dx = player.tileX - npcs[i].tileX;
      var dy = player.tileY - npcs[i].tileY;
      var dist = Math.abs(dx) + Math.abs(dy);  // Manhattan distance
      if (dist <= 2) {
        // Face toward player (pick dominant axis)
        if (Math.abs(dx) >= Math.abs(dy)) {
          npcs[i].facing = dx > 0 ? 'right' : 'left';
        } else {
          npcs[i].facing = dy > 0 ? 'down' : 'up';
        }
      }
      // Micro-bounce: trigger when player first becomes adjacent (dist === 1)
      if (dist === 1) {
        newAdjacentSet[i] = true;
        if (!adjacentSet[i]) {
          // Newly adjacent — start bounce
          npcs[i].bounceT = 4;
        }
      }
      // Decrement bounce timer
      if (npcs[i].bounceT > 0) {
        npcs[i].bounceT--;
      }
      // Turn-back delay: reset facing only after 0.5s away from player
      if (dist > 2) {
        if (!npcs[i]._turnAwayTime) npcs[i]._turnAwayTime = Date.now();
        if (Date.now() - npcs[i]._turnAwayTime > 500) {
          npcs[i].facing = npcs[i].defaultFacing || 'down';
          npcs[i]._turnAwayTime = 0;
        }
      } else {
        npcs[i]._turnAwayTime = 0;
      }
    }
    adjacentSet = newAdjacentSet;

    // Draw all entities
    var ents = [];
    for (var i = 0; i < npcs.length; i++) {
      npcs[i].pixelX = npcs[i].tileX * TILE;
      npcs[i].pixelY = npcs[i].tileY * TILE - (BOUNCE_CURVE[npcs[i].bounceT] || 0);
      ents.push({ e: npcs[i], p: false });
    }
    ents.push({ e: player, p: true });
    ents.sort(function (a, b) { return a.e.pixelY - b.e.pixelY; });
    for (var j = 0; j < ents.length; j++)
      drawEntity(ents[j].e, ents[j].p);
    // 4. Draw bubble on top (after entities, so it's not covered)
    var ft = facedTile();
    var hasTarget = npcIdAt(ft.x, ft.y) !== null;
    if (!hasTarget && map && map.interactions) {
      for (var ii = 0; ii < map.interactions.length; ii++) {
        if (map.interactions[ii].tileX === ft.x && map.interactions[ii].tileY === ft.y) { hasTarget = true; break; }
      }
    }
    if (hasTarget)
      drawBubble(player.pixelX, player.pixelY);
    if (renderCb) renderCb(ctx, Date.now());

    // ── Cinematic multi-source lighting ──
    drawLighting(Date.now());

    // ── Idle companion effects ──
    // Check idle state every 5 seconds to avoid performance hit
    var nowMs = Date.now();
    if (nowMs - lastIdleCheck > IDLE_CHECK_INTERVAL) {
      lastIdleCheck = nowMs;
      if (window.CafeBehavior && window.CafeBehavior.getIdleMinutes) {
        cachedIdleMinutes = window.CafeBehavior.getIdleMinutes();
      }
    }
    if (cachedIdleMinutes >= 5 && entryState === 4) {
      // After 5 min idle: Cruz occasionally glances toward the player (every 30s, 2s gaze)
      var gazePhase = (nowMs / 1000) % 30; // 30-second cycle
      if (gazePhase < 2) {
        // Brief gaze: Cruz faces player during the 2s window
        if (!idleGazeActive) {
          idleGazeActive = true;
          for (var gi = 0; gi < npcs.length; gi++) {
            if (npcs[gi].id === 'cruz') npcs[gi].facing = 'down';
          }
        }
      } else {
        if (idleGazeActive) {
          idleGazeActive = false;
          for (var gi = 0; gi < npcs.length; gi++) {
            if (npcs[gi].id === 'cruz') npcs[gi].facing = npcs[gi].defaultFacing || 'down';
          }
        }
      }

      // After 15 min idle: subtle contemplative slowdown is handled by NPC animation externally
      // (wipe animation speed is in sprites.js — we signal via a flag)
      if (cachedIdleMinutes >= 15) {
        window._cafeIdleContemplative = true;
      } else {
        window._cafeIdleContemplative = false;
      }

      // After 30 min idle: dim ambient light very slightly — cocoon effect
      if (cachedIdleMinutes >= 30) {
        var dimAlpha = 0.05; // brightness *= 0.95 equivalent
        ctx.fillStyle = 'rgba(42,42,61,' + dimAlpha.toFixed(3) + ')';
        ctx.fillRect(0, 0, W, H);
      }
    } else {
      if (idleGazeActive) {
        idleGazeActive = false;
        for (var gi = 0; gi < npcs.length; gi++) {
          if (npcs[gi].id === 'cruz') npcs[gi].facing = npcs[gi].defaultFacing || 'down';
        }
      }
      window._cafeIdleContemplative = false;
    }

    // ── Cinematic entry sequence ──
    if (entryState > 0 && entryState < 4) {
      drawEntryOverlay(ctx, Date.now());
    }

    // Nightfall: 5-second fade-to-black on force close
    if (window._cafeForceClose) {
      if (!nightfallStart) nightfallStart = Date.now();
      var elapsed = Date.now() - nightfallStart;
      var alpha = Math.min(elapsed / NIGHTFALL_DUR, 1);
      // Smooth ease-in curve
      alpha = alpha * alpha;
      ctx.fillStyle = 'rgba(10,8,6,' + alpha.toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
      // Final farewell text when fully dark
      if (alpha >= 0.95) {
        ctx.save();
        ctx.globalAlpha = Math.min((alpha - 0.95) / 0.05, 1);
        ctx.fillStyle = '#f5a623';
        ctx.font = '16px monospace';
        ctx.textAlign = 'center';
        var farewell = window._cafeFarewell || '今天的營業時間結束了。外面的風很舒服，去走走吧。我們明天見。';
        // Wrap long farewell into centered lines
        var lines = farewell.split('\n');
        var baseY = H / 2 - (lines.length * 12);
        for (var li = 0; li < lines.length; li++) {
          ctx.fillText(lines[li], W / 2, baseY + li * 24);
        }
        ctx.restore();
      }
    }
  }

  // ── Cinematic entry overlay ──
  // Phase 1 (0-5s): black screen, rain audio only
  // Phase 2 (5-5.5s): radial light from counter, Cruz turns to face player
  // Phase 3 (5.5-9.5s): spatial text above Cruz, frameless whisper
  // Phase 4: done
  function drawEntryOverlay(ctx, now) {
    if (entryState === 0) return;
    var elapsed = now - entryStart;

    if (entryState === 1) {
      // Black overlay with slow fade — timings scale with ENTRY_WAIT
      var blackHold = ENTRY_WAIT * 0.4;   // pure black phase (2s at default 5s)
      var fadeDur = ENTRY_WAIT * 0.5;     // fade-out phase (2.5s at default 5s)
      var bloomStart = ENTRY_WAIT * 0.6;  // bloom begins (3s at default 5s)
      var bloomDur = ENTRY_WAIT * 0.4;    // bloom ramp (2s at default 5s)
      var fadeAlpha;
      if (elapsed < blackHold) fadeAlpha = 1;
      else fadeAlpha = Math.max(0, 1 - (elapsed - blackHold) / fadeDur);
      ctx.fillStyle = 'rgba(42,42,61,' + fadeAlpha.toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
      // Radial light bloom from Cruz's position (tile 4,2)
      if (elapsed > bloomStart) {
        var bloomT = Math.min((elapsed - bloomStart) / bloomDur, 1);
        var bloomAlpha = bloomT * 0.08;
        // Cruz sits at tile (4,2) — center of his sprite
        var cruzCX = 4 * TILE + TILE / 2;
        var cruzCY = 2 * TILE + TILE / 2;
        var bloomR = 40 + bloomT * 80; // subtle radius, max ~120px
        var grd = ctx.createRadialGradient(cruzCX, cruzCY, 0, cruzCX, cruzCY, bloomR);
        grd.addColorStop(0, 'rgba(212,160,87,' + bloomAlpha.toFixed(3) + ')');  // 琥珀暖 #D4A057
        grd.addColorStop(0.6, 'rgba(212,160,87,' + (bloomAlpha * 0.3).toFixed(3) + ')');
        grd.addColorStop(1, 'rgba(212,160,87,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, W, H);
      }
      if (elapsed >= ENTRY_WAIT) {
        entryState = 2;
        // Force Cruz to face player
        for (var i = 0; i < npcs.length; i++) {
          if (npcs[i].id === 'cruz') {
            npcs[i].facing = 'down'; // face toward door/player
          }
        }
        // Play door chime if audio available
        if (window.CafeAudio && window.CafeAudio.playInteract) {
          window.CafeAudio.playInteract();
        }
      }
    } else if (entryState === 2) {
      // Cruz gazing phase
      var gazeElapsed = now - (entryStart + ENTRY_WAIT);
      if (gazeElapsed >= ENTRY_GAZE) {
        entryState = 3;
        entryTextTimer = now;
        entryTextAlpha = 0;
      }
    } else if (entryState === 3) {
      // Spatial text phase
      var textElapsed = now - entryTextTimer;
      // Fade in text, hold, then fade out — timings scale with ENTRY_TEXT_DUR
      var textFadeIn = ENTRY_TEXT_DUR * 0.2;    // 20% fade-in (800ms at 4s)
      var textHoldEnd = ENTRY_TEXT_DUR * 0.8;   // hold until 80% (3200ms at 4s)
      var textFadeOut = ENTRY_TEXT_DUR * 0.2;   // 20% fade-out (800ms at 4s)
      if (textElapsed < textFadeIn) {
        entryTextAlpha = textElapsed / textFadeIn;
      } else if (textElapsed < textHoldEnd) {
        entryTextAlpha = 1;
      } else if (textElapsed < ENTRY_TEXT_DUR) {
        entryTextAlpha = 1 - (textElapsed - textHoldEnd) / textFadeOut;
      } else {
        entryTextAlpha = 0;
        entryState = 4;
        // Cruz goes back to default
        for (var i = 0; i < npcs.length; i++) {
          if (npcs[i].id === 'cruz') {
            npcs[i].facing = npcs[i].defaultFacing || 'down';
          }
        }
      }
      if (entryTextAlpha > 0) {
        // Draw text above Cruz's position (world-space)
        var cruzX = 7 * T, cruzY = 1 * T;
        ctx.save();
        ctx.globalAlpha = entryTextAlpha * 0.85;
        ctx.fillStyle = '#f5d6b0';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        // Get personalized lines from behavior engine
        var line1, line2;
        if (window.CafeBehavior) {
          var opening = window.CafeBehavior.getOpening();
          line1 = opening.line1;
          line2 = opening.line2;
          // Adjust audio rate if behavior detected
          if (window.CafeAudio && opening.audioRate !== 1.0) {
            // Adjust ambient playback rate via AAR if loaded
            if (window._cafeAmbientReal && window._cafeAmbientReal.source) {
              try { window._cafeAmbientReal.source.playbackRate.value = opening.audioRate; } catch(e) {}
            }
          }
          // Adjust brightness for doomscroller cocoon
          if (opening.brightness < 1.0) {
            ctx.fillStyle = 'rgba(42,42,61,' + (1 - opening.brightness) * 0.15 + ')';
            ctx.fillRect(0, 0, W, H);
          }
        } else {
          line1 = '\u5916\u9762\u96E8\u5F88\u5927\u5427\uFF1F';
          line2 = '\u5148\u904E\u4F86\u5750\uFF0C\u5496\u5561\u6B63\u5728\u716E\u4E86\u3002';
        }
        ctx.fillStyle = '#f5d6b0';
        ctx.fillText(line1, cruzX + 16, cruzY - 14);
        ctx.fillText(line2, cruzX + 16, cruzY - 3);
        ctx.restore();
      }
    }
  }

  // ── Cinematic multi-source lighting ──
  // 5 light layers: window cold, Cruz amber, machine red, laptop blue, night wash
  function drawLighting(now) {
    // 1. Window cold light — exterior bleeding through row-0 windows (cols 1-5)
    var winCX = 3 * TILE;    // center of window strip
    var winCY = 0;
    var coldR = TILE * 5;
    var coldGrd = ctx.createRadialGradient(winCX, winCY, 0, winCX, winCY + TILE * 3, coldR);
    coldGrd.addColorStop(0, 'rgba(100,140,200,0.07)');
    coldGrd.addColorStop(0.4, 'rgba(100,140,200,0.03)');
    coldGrd.addColorStop(1, 'rgba(100,140,200,0)');
    ctx.fillStyle = coldGrd;
    ctx.fillRect(0, 0, W, H);

    // 2. Cruz amber bloom — persistent, breathing rhythm
    var cruzCX = 4 * TILE + TILE / 2;
    var cruzCY = 2 * TILE + TILE / 2;
    var breathe = reducedMotion ? 0 : Math.sin(now / 4000) * 8;  // slow 4s pulse
    var warmR = 100 + breathe;
    var warmGrd = ctx.createRadialGradient(cruzCX, cruzCY, 0, cruzCX, cruzCY, warmR);
    warmGrd.addColorStop(0, 'rgba(212,160,87,0.12)');   // 琥珀暖 core
    warmGrd.addColorStop(0.5, 'rgba(212,160,87,0.04)');
    warmGrd.addColorStop(1, 'rgba(212,160,87,0)');
    ctx.fillStyle = warmGrd;
    ctx.fillRect(0, 0, W, H);

    // 3. Coffee machine indicator — tiny red warm spot at (7,2)
    var macCX = 7 * TILE + TILE / 2;
    var macCY = 2 * TILE + TILE / 2;
    var macGrd = ctx.createRadialGradient(macCX, macCY, 0, macCX, macCY, 45);
    macGrd.addColorStop(0, 'rgba(231,76,60,0.05)');
    macGrd.addColorStop(1, 'rgba(231,76,60,0)');
    ctx.fillStyle = macGrd;
    ctx.fillRect(0, 0, W, H);

    // 4. Laptop screen glow — flickers from any NPC with laptop item
    for (var li = 0; li < npcs.length; li++) {
      if (npcs[li].id === 'nova') {
        var novaCX = npcs[li].tileX * TILE + TILE / 2;
        var novaCY = npcs[li].tileY * TILE + TILE / 2;
        // Irregular flicker: two overlapping sin waves + random-ish jitter
        var flicker = 0.025 + Math.sin(now / 800) * 0.01 + Math.sin(now / 337) * 0.008;
        var scrGrd = ctx.createRadialGradient(novaCX, novaCY, 0, novaCX, novaCY, 38);
        scrGrd.addColorStop(0, 'rgba(126,200,227,' + flicker.toFixed(4) + ')');
        scrGrd.addColorStop(1, 'rgba(126,200,227,0)');
        ctx.fillStyle = scrGrd;
        ctx.fillRect(0, 0, W, H);
        break;
      }
    }

    // 5. Night wash — very subtle dark blue unifying tint
    ctx.fillStyle = 'rgba(42,42,61,0.025)';
    ctx.fillRect(0, 0, W, H);

    // 6. Film grain — analog texture (skip if reduced motion)
    if (!reducedMotion) drawFilmGrain(now);

    // 7. Light leak — warm diagonal from top-left corner
    var leakAlpha = 0.04 + Math.sin(now / 6000) * 0.015;
    var leakGrd = ctx.createLinearGradient(0, 0, W * 0.6, H * 0.6);
    leakGrd.addColorStop(0, 'rgba(255,200,100,' + leakAlpha.toFixed(4) + ')');
    leakGrd.addColorStop(0.3, 'rgba(255,180,80,' + (leakAlpha * 0.4).toFixed(4) + ')');
    leakGrd.addColorStop(1, 'rgba(255,180,80,0)');
    ctx.fillStyle = leakGrd;
    ctx.fillRect(0, 0, W, H);

    // 8. Color grading — slight warm shift + desaturation via overlay
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = 'rgba(180,140,100,0.03)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  // Film grain: noise texture regenerated every ~100ms for organic feel
  var lastGrainTime = 0;
  function drawFilmGrain(now) {
    if (!grainCanvas) {
      grainCanvas = document.createElement('canvas');
      grainCanvas.width = W; grainCanvas.height = H;
      grainCtx = grainCanvas.getContext('2d');
    }
    // Regenerate grain every 100ms (10fps noise)
    if (now - lastGrainTime > 100) {
      lastGrainTime = now;
      var imgData = grainCtx.createImageData(W, H);
      var d = imgData.data;
      for (var i = 0; i < d.length; i += 4) {
        var v = (Math.random() * 40) | 0; // 0-40 brightness range
        d[i] = v; d[i + 1] = v; d[i + 2] = v;
        d[i + 3] = 12; // very low opacity per pixel
      }
      grainCtx.putImageData(imgData, 0, 0);
    }
    ctx.drawImage(grainCanvas, 0, 0);
  }

  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);
    update();
    render();
  }

  function handleKey(e) {
    if (window._cafeForceClose) return; // Nightfall: freeze all input
    var k = e.key;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') { e.preventDefault(); movePlayer('up'); }
    else if (k === 'ArrowDown' || k === 's' || k === 'S') { e.preventDefault(); movePlayer('down'); }
    else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { e.preventDefault(); movePlayer('left'); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); movePlayer('right'); }
    else if (k === ' ' || k === 'Enter') { e.preventDefault(); interact(); }
  }

  function movePlayer(dir) {
    if (player.moving) { inputBuffer = dir; return; }
    player.facing = dir;
    var d = DIR[dir], nx = player.tileX + d.dx, ny = player.tileY + d.dy;
    if (tileAt(nx, ny) || npcAt(nx, ny)) return;
    if (window.CafeAudio) CafeAudio.playWalk();
    player.moving = true; player.moveT = 0;
    player.fromX = player.tileX * TILE; player.fromY = player.tileY * TILE;
    player.toX = nx * TILE; player.toY = ny * TILE;
  }

  function interact() {
    var ft = facedTile(), id = npcIdAt(ft.x, ft.y);
    if (id !== null && interactCb) {
      if (window.CafeAudio) window.CafeAudio.playInteract();
      interactCb(id, ft.x, ft.y); return;
    }
    // Also check map interaction points (objects, empty seats, etc.)
    if (map && map.interactions && interactCb) {
      for (var i = 0; i < map.interactions.length; i++) {
        var it = map.interactions[i];
        if (it.tileX === ft.x && it.tileY === ft.y) {
          interactCb(it.id, ft.x, ft.y);
          return;
        }
      }
    }
  }

  window.CafeEngine = {
    init: function (canvasId, mapData, spriteData, npcData) {
      canvas = document.getElementById(canvasId);
      ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      ctx.imageSmoothingEnabled = false;
      bgCanvas = document.createElement('canvas');
      bgCanvas.width = W; bgCanvas.height = H;
      bgCtx = bgCanvas.getContext('2d');
      bgCtx.imageSmoothingEnabled = false;
      map = mapData || {}; sprites = spriteData || {}; npcs = npcData || [];
      for (var i = 0; i < npcs.length; i++) {
        npcs[i].defaultFacing = npcs[i].facing || 'down';
      }
      player.tileX = 7; player.tileY = 10;
      player.pixelX = player.tileX * TILE; player.pixelY = player.tileY * TILE;
      player.facing = 'up'; player.moving = false;
      drawBg(); scaleCanvas();
      // Accessibility: detect reduced motion preference
      var mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      reducedMotion = mql.matches;
      if (mql.addEventListener) mql.addEventListener('change', function (e) { reducedMotion = e.matches; });
      window.addEventListener('resize', scaleCanvas);
      window.addEventListener('keydown', handleKey);
    },
    start: function () {
      running = true;
      ctx.drawImage(bgCanvas, 0, 0);
      render();
      requestAnimationFrame(loop);
    },
    startCinematicEntry: function () {
      if (!window._cafeEntryDone) {
        window._cafeEntryDone = true;
        // Scale entry timings based on visit tier
        var tier = window.CafeBehavior ? window.CafeBehavior.getVisitTier() : 'first';
        var opening = window.CafeBehavior ? window.CafeBehavior.getOpening() : {};
        if (tier === 'family' || opening.skipIntro) {
          // Family / skipIntro: no ceremony, straight to done
          entryState = 4;
          return;
        }
        if (tier === 'returning') {
          ENTRY_WAIT = 1000;    // 1s overlay fade
          ENTRY_GAZE = 500;     // 0.5s gaze
          ENTRY_TEXT_DUR = 2500; // 2.5s text
        } else if (tier === 'regular') {
          ENTRY_WAIT = 500;     // 0.5s overlay
          ENTRY_GAZE = 300;     // 0.3s gaze
          ENTRY_TEXT_DUR = 1200; // 1.2s text
        }
        // 'first' keeps the defaults (5000, 500, 4000)
        entryState = 1;
        entryStart = Date.now();
      }
    },
    movePlayer: movePlayer,
    interact: interact,
    getPlayerPos: function () {
      return { tileX: player.tileX, tileY: player.tileY, pixelX: player.pixelX, pixelY: player.pixelY, facing: player.facing };
    },
    onInteract: function (cb) { interactCb = cb; },
    onMove: function (cb) { moveCb = cb; },
    onRender: function (cb) { renderCb = cb; },
    setNpcData: function (data) {
      npcs = data || [];
      for (var i = 0; i < npcs.length; i++) {
        npcs[i].defaultFacing = npcs[i].facing || 'down';
      }
      adjacentSet = {};
    },
    teleport: function (tx, ty, dir) {
      player.tileX = tx; player.tileY = ty;
      player.pixelX = tx * TILE; player.pixelY = ty * TILE;
      player.facing = dir || 'down'; player.moving = false;
    }
  };
})();
