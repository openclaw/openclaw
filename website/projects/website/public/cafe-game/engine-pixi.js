/**
 * Thinker Cafe — PixiJS 8 WebGL Engine
 * Replaces Canvas 2D engine.js with GPU-accelerated rendering.
 * All other modules (sprites, tiles, npc-data, interactions, audio, behavior) unchanged.
 */
(function () {
  'use strict';
  var PIXI = window.PIXI;
  if (!PIXI) { console.error('☕ PixiJS not loaded'); return; }

  var TILE = 32, COLS = 15, ROWS = 11, W = COLS * TILE, H = ROWS * TILE;
  var MOVE_FRAMES = 6;
  var app, stage;
  // Layer containers (bottom → top)
  var bgLayer, entityLayer, lightLayer, uiLayer, overlayLayer;
  // Sprites
  var bgSprite;
  var playerPixi, entityPixis = {};
  var playerGlow = { core: null, halo: null };
  var bubbleGfx;
  // (Per-entity canvases created on demand via getEntityCanvas)
  // Filters
  var bloomSprites = [];
  var colorFilter, noiseFilter;
  // Door threshold breathing anchor (two-sprite: cool + warm, cross-fade on sin cycle)
  var doorBreath = { cool: null, warm: null };
  // State
  var map, npcs = [], interactCb = null, moveCb = null, renderCb = null;
  var player = {
    tileX: 7, tileY: 10, pixelX: 0, pixelY: 0, facing: 'down',
    moving: false, moveT: 0, fromX: 0, fromY: 0, toX: 0, toY: 0
  };
  var adjacentSet = {};
  var inputBuffer = null;
  var BOUNCE_CURVE = [-1, -2, -1, 0];
  // Entry state
  var entryState = 0, entryStart = 0;
  var entryTextAlpha = 0, entryTextTimer = 0;
  var ENTRY_WAIT = 5000, ENTRY_GAZE = 500, ENTRY_TEXT_DUR = 4000;
  var nightfallStart = 0, NIGHTFALL_DUR = 5000;
  // Idle
  var lastIdleCheck = 0, cachedIdleMinutes = 0, IDLE_CHECK_INTERVAL = 5000;
  var idleGazeActive = false;
  var reducedMotion = false;

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

  // ── Per-entity offscreen canvases (avoid Texture.from cache collision) ──
  var entityCanvases = {};  // key → { canvas, ctx, texture }

  function getEntityCanvas(key) {
    if (!entityCanvases[key]) {
      var c = document.createElement('canvas');
      c.width = TILE; c.height = TILE;
      var ctx = c.getContext('2d');
      var tex = PIXI.Texture.from(c, { scaleMode: 'nearest' });
      entityCanvases[key] = { canvas: c, ctx: ctx, texture: tex };
    }
    return entityCanvases[key];
  }


  // ── Bake tilemap to a single GPU texture ──
  function bakeTilemap() {
    var bakeCanvas = document.createElement('canvas');
    bakeCanvas.width = W; bakeCanvas.height = H;
    var bakeCtx = bakeCanvas.getContext('2d');
    var useTiles = window.CafeTiles;
    if (!map || !map.floor) return bakeCanvas;
    for (var y = 0; y < ROWS; y++)
      for (var x = 0; x < COLS; x++) {
        if (useTiles) {
          useTiles.drawTile(bakeCtx, map.floor[y * COLS + x], x, y, 'floor');
        }
        if (map.walls) {
          var wid = map.walls[y * COLS + x];
          if (wid > 0 && useTiles) useTiles.drawTile(bakeCtx, wid, x, y, 'walls');
        }
      }
    if (useTiles) useTiles.drawAmbience(bakeCtx);
    return bakeCanvas;
  }

  // ── Create bloom light sprites (dual-layer: inner core + wide halo) ──
  function createBloomLights() {
    // Helper: add a dual-layer light (bright tight core + soft wide halo)
    function addDualBloom(x, y, coreR, haloR, color, coreA, haloA, breathe) {
      // Inner core — small, bright, simulates filament
      var core = createGlowSprite(coreR, color, coreA);
      core.x = x; core.y = y; core.blendMode = 'add';
      lightLayer.addChild(core);
      bloomSprites.push({ sprite: core, baseScale: 1, breathe: breathe });
      // Outer halo — large, diffuse ambient wash
      var halo = createGlowSprite(haloR, color, haloA);
      halo.x = x; halo.y = y; halo.blendMode = 'add';
      lightLayer.addChild(halo);
      bloomSprites.push({ sprite: halo, baseScale: 1, breathe: breathe });
    }

    // ── Bar pendant lamps (aligned with ambience overlay: x=4.5, 7.5, 10.5) ──
    // These are the hero lights for the intro pan — all 3 must glow
    var barPendants = [
      { x: 4.5, y: 1.5, breathe: true },   // left pendant (over Cruz's workspace)
      { x: 7.5, y: 1.5, breathe: true },    // center pendant (over coffee machine)
      { x: 10.5, y: 1.5, breathe: true },   // right pendant (over register area)
    ];
    for (var bp = 0; bp < barPendants.length; bp++) {
      addDualBloom(
        barPendants[bp].x * TILE, barPendants[bp].y * TILE,
        30, 150, 0xF0C060, 0.55, 0.22, barPendants[bp].breathe
      );
    }

    // Cruz personal glow — warm golden halo (brighter than pendants, he's the star)
    addDualBloom(
      4 * TILE + TILE / 2, 2 * TILE + TILE / 2,
      45, 170, 0xF0C060, 0.65, 0.28, true
    );

    // Coffee machine — red indicator core + subtle glow
    addDualBloom(
      7 * TILE + TILE / 2, 2 * TILE + TILE / 2,
      18, 60, 0xE74C3C, 0.4, 0.12, false
    );

    // ── Seating area lamps (dimmer than bar — audience, not stage) ──
    var seatLamps = [
      { x: 4.5, y: 4.5 },   // left aisle
      { x: 10.5, y: 4.5 },  // right aisle
    ];
    for (var sl = 0; sl < seatLamps.length; sl++) {
      addDualBloom(
        seatLamps[sl].x * TILE, seatLamps[sl].y * TILE,
        20, 90, 0xD4A087, 0.45, 0.12, false
      );
    }

    // ── Aisle bloom breadcrumbs (floor-reflected light, door → bar visual trail) ──
    // Match ambience overlay pools at y=4.5,6.0,7.5,9.0 along center x=7.5
    // Slightly brighter near bar (y=4.5), fades toward door (y=9.0)
    var aisleLights = [
      { x: 7.5, y: 4.5, coreA: 0.28, haloA: 0.12 },  // nearest bar — brightest, phone-readable
      { x: 7.5, y: 6.0, coreA: 0.23, haloA: 0.10 },
      { x: 7.5, y: 7.5, coreA: 0.19, haloA: 0.08 },
      { x: 7.5, y: 9.0, coreA: 0.14, haloA: 0.06 },  // nearest door — fading gradient
      { x: 7.5, y: 10.0, coreA: 0.10, haloA: 0.04 }, // doorway — closes the dark gap
    ];
    for (var al = 0; al < aisleLights.length; al++) {
      addDualBloom(
        aisleLights[al].x * TILE, aisleLights[al].y * TILE,
        13, 60, 0xD4A087, aisleLights[al].coreA, aisleLights[al].haloA, true
      );
    }

    // Window cold light — moonlight spill (single layer, wide)
    var coldBloom = createGlowSprite(200, 0x6488C8, 0.2);
    coldBloom.x = 3 * TILE; coldBloom.y = 0;
    coldBloom.blendMode = 'add';
    lightLayer.addChild(coldBloom);
    bloomSprites.push({ sprite: coldBloom, baseScale: 1, breathe: false });

    // General ambient fill
    var ambFill = createGlowSprite(300, 0xC8A882, 0.1);
    ambFill.x = W / 2; ambFill.y = H / 2;
    ambFill.blendMode = 'add';
    lightLayer.addChild(ambFill);
    bloomSprites.push({ sprite: ambFill, baseScale: 1, breathe: false });
  }

  // ── Player warm pulse — additive glow that follows the player sprite ──
  // Reads as a personal lantern: confirms where YOU are on phone screens.
  // Two layers: tight amber core (footstep radius) + wide soft halo (body warmth).
  function createPlayerGlow() {
    // Core: tight, bright, simulates warm light pooling at feet
    var core = createGlowSprite(28, 0xFFCC88, 0.55);
    core.blendMode = 'add';
    lightLayer.addChild(core);
    playerGlow.core = core;

    // Halo: wide, diffuse, wraps the player in warm ambient
    var halo = createGlowSprite(72, 0xE8A060, 0.18);
    halo.blendMode = 'add';
    lightLayer.addChild(halo);
    playerGlow.halo = halo;
  }

  function createGlowSprite(radius, color, alpha) {
    var c = document.createElement('canvas');
    var size = radius * 2;
    c.width = size; c.height = size;
    var g = c.getContext('2d');
    var r = ((color >> 16) & 0xFF);
    var gv = ((color >> 8) & 0xFF);
    var b = (color & 0xFF);
    var grad = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
    grad.addColorStop(0, 'rgba(' + r + ',' + gv + ',' + b + ',' + alpha + ')');
    grad.addColorStop(0.5, 'rgba(' + r + ',' + gv + ',' + b + ',' + (alpha * 0.3) + ')');
    grad.addColorStop(1, 'rgba(' + r + ',' + gv + ',' + b + ',0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    var sprite = new PIXI.Sprite(PIXI.Texture.from(c, { scaleMode: 'linear' }));
    sprite.anchor.set(0.5);
    return sprite;
  }

  // ── Window displacement (rain glass refraction) ──
  var dispSprite, dispFilter;

  function initWindowDisplacement() {
    // Generate a tileable grayscale raindrop displacement map
    var mapSize = 128;
    var dCanvas = document.createElement('canvas');
    dCanvas.width = mapSize; dCanvas.height = mapSize;
    var dCtx = dCanvas.getContext('2d');
    // Base neutral gray (128 = no displacement)
    dCtx.fillStyle = '#808080';
    dCtx.fillRect(0, 0, mapSize, mapSize);
    // Scatter water droplets as lighter/darker spots
    for (var i = 0; i < 60; i++) {
      var dx = Math.random() * mapSize;
      var dy = Math.random() * mapSize;
      var dr = 1 + Math.random() * 4;
      var bright = 100 + Math.floor(Math.random() * 56); // 100-155 range
      var grad = dCtx.createRadialGradient(dx, dy, 0, dx, dy, dr);
      grad.addColorStop(0, 'rgb(' + bright + ',' + bright + ',' + bright + ')');
      grad.addColorStop(1, 'rgb(128,128,128)');
      dCtx.fillStyle = grad;
      dCtx.beginPath(); dCtx.arc(dx, dy, dr, 0, Math.PI * 2); dCtx.fill();
    }
    // Add vertical streak patterns (rain running down glass)
    for (var s = 0; s < 15; s++) {
      var sx = Math.random() * mapSize;
      var sLen = 20 + Math.random() * 40;
      var sy = Math.random() * (mapSize - sLen);
      dCtx.strokeStyle = 'rgba(160,160,160,0.4)';
      dCtx.lineWidth = 0.5 + Math.random();
      dCtx.beginPath();
      dCtx.moveTo(sx, sy);
      // Slightly wavy vertical line
      for (var p = 0; p < sLen; p += 4) {
        dCtx.lineTo(sx + Math.sin(p * 0.3) * 1.5, sy + p);
      }
      dCtx.stroke();
    }

    var dispTexture = PIXI.Texture.from(dCanvas, { scaleMode: 'linear' });
    dispSprite = new PIXI.Sprite(dispTexture);
    dispSprite.texture.source.style.addressMode = 'repeat';
    // Position over window area (cols 1-5, rows 0-1)
    dispSprite.x = TILE;
    dispSprite.y = 0;
    dispSprite.width = 5 * TILE;
    dispSprite.height = 2 * TILE;
    dispSprite.alpha = 0; // invisible — only used as displacement source
    stage.addChild(dispSprite);

    dispFilter = new PIXI.DisplacementFilter({ sprite: dispSprite, scale: { x: 3, y: 4 } });
    // Apply only to background layer (tiles behind windows)
    bgLayer.filters = bgLayer.filters ? bgLayer.filters.concat([dispFilter]) : [dispFilter];
  }

  function updateWindowDisplacement() {
    if (!dispSprite || reducedMotion) return;
    // Scroll displacement map downward to simulate rain flowing on glass
    dispSprite.y += 0.3;
    if (dispSprite.y > 2 * TILE) dispSprite.y = 0;
    // Subtle horizontal drift
    dispSprite.x = TILE + Math.sin(Date.now() / 3000) * 2;
  }

  // ── Particle systems ──
  var rainParticles = [], steamParticles = [], dustParticles = [];
  var particleLayer;

  function initParticles() {
    particleLayer = new PIXI.Container();
    stage.addChild(particleLayer);

    // Rain drops — 120 particles falling on window area
    for (var i = 0; i < 120; i++) {
      var rain = new PIXI.Graphics();
      rain.rect(0, 0, 1, 3 + Math.random() * 3);
      rain.fill({ color: 0xB4D2E6, alpha: 0.15 + Math.random() * 0.15 });
      rain.x = Math.random() * (6 * TILE); // window area cols 0-5
      rain.y = Math.random() * (TILE * 2);
      rain._vy = 150 + Math.random() * 200;
      rain._maxY = TILE * 2;
      particleLayer.addChild(rain);
      rainParticles.push(rain);
    }

    // Coffee steam — 8 particles, slow rising wisps with proper alpha curve
    for (var j = 0; j < 8; j++) {
      var steam = new PIXI.Graphics();
      steam.circle(0, 0, 1.2 + Math.random() * 1.2);
      steam.fill({ color: 0xE8D5C0, alpha: 0 });
      steam.x = 4 * TILE + 8 + Math.random() * 16;
      steam.y = 2 * TILE - 4;
      steam._life = Math.random();
      steam._speed = 5 + Math.random() * 8; // slower rise
      steam._startX = steam.x;
      steam._wobblePhase = Math.random() * Math.PI * 2;
      particleLayer.addChild(steam);
      steamParticles.push(steam);
    }

    // Dust motes — 25 floating particles
    for (var k = 0; k < 25; k++) {
      var dust = new PIXI.Graphics();
      dust.circle(0, 0, 0.5 + Math.random() * 0.5);
      dust.fill({ color: 0xD4A087, alpha: 0 });
      dust.x = TILE + Math.random() * (W - TILE * 2);
      dust.y = TILE + Math.random() * (H - TILE * 2);
      dust._phase = Math.random() * Math.PI * 2;
      dust._speed = 1 + Math.random() * 2;
      particleLayer.addChild(dust);
      dustParticles.push(dust);
    }
  }

  function updateParticles(dt) {
    var now = Date.now();
    // Rain
    for (var i = 0; i < rainParticles.length; i++) {
      var r = rainParticles[i];
      r.y += r._vy * dt;
      if (r.y > r._maxY) {
        r.y = -4;
        r.x = Math.random() * (6 * TILE);
      }
    }
    // Steam — slow wisp with {start:0, middle:0.35, end:0} alpha curve
    for (var j = 0; j < steamParticles.length; j++) {
      var s = steamParticles[j];
      s._life += dt * 0.2; // slower lifecycle
      if (s._life > 1) {
        s._life = 0;
        s.x = s._startX;
        s.y = 2 * TILE - 4;
        s._wobblePhase = Math.random() * Math.PI * 2;
      }
      s.y -= s._speed * dt;
      // Gentle S-curve wobble
      s.x = s._startX + Math.sin(s._wobblePhase + s._life * 3) * 3;
      // Alpha: ramp up to 0.35 at life=0.4, hold briefly, fade out
      var life = s._life;
      if (life < 0.3) s.alpha = (life / 0.3) * 0.35;
      else if (life < 0.6) s.alpha = 0.35;
      else s.alpha = 0.35 * (1 - (life - 0.6) / 0.4);
      // Scale up slightly as it rises (expanding wisp)
      s.scale.set(1 + life * 0.6);
    }
    // Dust
    for (var k = 0; k < dustParticles.length; k++) {
      var d = dustParticles[k];
      d._phase += dt * 0.2;
      d.x += Math.sin(d._phase) * d._speed * dt;
      d.y += Math.cos(d._phase * 0.7) * d._speed * dt * 0.5;
      d.alpha = 0.08 + Math.sin(d._phase) * 0.04;
      // Wrap
      if (d.x < TILE) d.x = W - TILE * 2;
      if (d.x > W - TILE) d.x = TILE;
      if (d.y < TILE) d.y = H - TILE * 2;
      if (d.y > H - TILE) d.y = TILE;
    }
  }

  // ── Setup GPU filters ──
  function setupFilters() {
    // Color grading: gentle warm tint (NOT full sepia — too dark)
    colorFilter = new PIXI.ColorMatrixFilter();
    colorFilter.brightness(1.35, false);    // lift overall brightness first
    colorFilter.saturate(-0.1, true);       // slight desaturation for film look
    // Warm tint: custom matrix that shifts slightly toward amber without crushing blacks
    var warmFilter = new PIXI.ColorMatrixFilter();
    warmFilter.matrix = [
      1.05, 0.05, 0,    0, 0.02,   // R: slight boost
      0,    1.0,  0.02, 0, 0.01,   // G: tiny warm shift
      0,    0,    0.88, 0, 0,      // B: reduce blue for warmth
      0,    0,    0,    1, 0       // A: unchanged
    ];

    // Film grain moved to CSS SVG overlay (zero JS cost per frame)
    // Apply to stage
    stage.filters = [colorFilter, warmFilter];
  }

  // ── Update entity sprites each frame ──
  function updateEntities() {
    var sprites = window.CafeSprites;
    if (!sprites) return;
    var now = Date.now();

    // Update NPC facing toward player
    var newAdjacentSet = {};
    for (var i = 0; i < npcs.length; i++) {
      var dx = player.tileX - npcs[i].tileX;
      var dy = player.tileY - npcs[i].tileY;
      var dist = Math.abs(dx) + Math.abs(dy);
      if (dist <= 2) {
        if (Math.abs(dx) >= Math.abs(dy)) {
          npcs[i].facing = dx > 0 ? 'right' : 'left';
        } else {
          npcs[i].facing = dy > 0 ? 'down' : 'up';
        }
      }
      if (dist === 1) {
        newAdjacentSet[i] = true;
        if (!adjacentSet[i]) npcs[i].bounceT = 4;
      }
      if (npcs[i].bounceT > 0) npcs[i].bounceT--;
      if (dist > 2) {
        if (!npcs[i]._turnAwayTime) npcs[i]._turnAwayTime = now;
        if (now - npcs[i]._turnAwayTime > 500) {
          npcs[i].facing = npcs[i].defaultFacing || 'down';
          npcs[i]._turnAwayTime = 0;
        }
      } else {
        npcs[i]._turnAwayTime = 0;
      }
    }
    adjacentSet = newAdjacentSet;

    // Draw each NPC to its own offscreen canvas → update GPU texture
    for (var j = 0; j < npcs.length; j++) {
      var npc = npcs[j];
      var key = npc.id || ('npc_' + j);
      if (!entityPixis[key]) {
        var ec = getEntityCanvas(key);
        entityPixis[key] = new PIXI.Sprite(ec.texture);
        entityPixis[key].width = TILE;
        entityPixis[key].height = TILE;
        entityLayer.addChild(entityPixis[key]);
      }
      var pixiSpr = entityPixis[key];
      npc.pixelX = npc.tileX * TILE;
      npc.pixelY = npc.tileY * TILE - (BOUNCE_CURVE[npc.bounceT] || 0);

      // Draw NPC to its dedicated canvas
      var npcEc = getEntityCanvas(key);
      npcEc.ctx.clearRect(0, 0, TILE, TILE);
      if (npc.id === 'cruz' && window._cruzAtPiano) {
        if (sprites.drawSmokingCup) sprites.drawSmokingCup(npcEc.ctx, 0, 0, now);
      } else if (npc.id && sprites.drawNpc) {
        sprites.drawNpc(npcEc.ctx, 0, 0, npc.id, npc.facing || 'down', npc.status || 'green');
      } else {
        npcEc.ctx.fillStyle = '#457b9d';
        npcEc.ctx.fillRect(4, 4, TILE - 8, TILE - 8);
      }
      npcEc.texture.source.update();
      pixiSpr.x = npc.pixelX;
      pixiSpr.y = npc.pixelY;
      pixiSpr.zIndex = npc.pixelY;
    }

    // Player sprite (dedicated canvas)
    if (!playerPixi) {
      var pec = getEntityCanvas('_player');
      playerPixi = new PIXI.Sprite(pec.texture);
      playerPixi.width = TILE;
      playerPixi.height = TILE;
      entityLayer.addChild(playerPixi);
    }
    var playerEc = getEntityCanvas('_player');
    playerEc.ctx.clearRect(0, 0, TILE, TILE);
    var pFrame = player.moving ? (Math.floor(player.moveT / 3) % 2) : 0;
    if (sprites.drawPlayer) sprites.drawPlayer(playerEc.ctx, 0, 0, player.facing, pFrame);
    playerEc.texture.source.update();
    playerPixi.x = player.pixelX;
    playerPixi.y = player.pixelY;
    playerPixi.zIndex = player.pixelY;

    entityLayer.sortChildren();
  }

  // ── Interaction bubble ──
  function updateBubble() {
    var ft = facedTile();
    var hasTarget = npcIdAt(ft.x, ft.y) !== null;
    if (!hasTarget && map && map.interactions) {
      for (var i = 0; i < map.interactions.length; i++) {
        if (map.interactions[i].tileX === ft.x && map.interactions[i].tileY === ft.y) {
          hasTarget = true; break;
        }
      }
    }
    if (!bubbleGfx) {
      bubbleGfx = new PIXI.Graphics();
      uiLayer.addChild(bubbleGfx);
    }
    bubbleGfx.clear();
    if (hasTarget) {
      var bx = player.pixelX + 12, by = player.pixelY - 16;
      var bounce = Math.sin(Date.now() / 500 * Math.PI) * 2;
      by += bounce;
      // White bubble
      bubbleGfx.roundRect(bx, by - 5, 16, 12, 2);
      bubbleGfx.fill({ color: 0xFFFFFF });
      bubbleGfx.stroke({ color: 0xBBBBBB, width: 1 });
      // Red !
      bubbleGfx.rect(bx + 7, by - 3, 2, 5);
      bubbleGfx.fill({ color: 0xE74C3C });
      bubbleGfx.rect(bx + 7, by + 3, 2, 2);
      bubbleGfx.fill({ color: 0xE74C3C });
    }
  }

  // ── Ambient vignette: bar brightest → tables medium → corners darkest ──
  function createAmbientVignette() {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');

    // ── Layer 1: darkness vignette — corners crush to near-black ──
    // Centered on bar cluster so bar stays fully lit and contrast is obvious at phone distance
    var vcx = 7.5 * TILE;   // 240px — bar center x
    var vcy = 1.5 * TILE;   // 48px  — bar height
    var innerR = 55;         // bar area: fully transparent
    var outerR = Math.sqrt(W * W + H * H) * 0.72;
    var grad = ctx.createRadialGradient(vcx, vcy, innerR, vcx, vcy, outerR);
    grad.addColorStop(0,    'rgba(10,8,6,0)');     // bar center — untouched
    grad.addColorStop(0.30, 'rgba(10,8,6,0.12)'); // table zone — reads on phone
    grad.addColorStop(0.58, 'rgba(10,8,6,0.28)'); // mid-floor — clearly dimmer
    grad.addColorStop(0.80, 'rgba(10,8,6,0.42)'); // far floor — strong shadow
    grad.addColorStop(1,    'rgba(10,8,6,0.55)'); // corners — decisively dark
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // ── Layer 2: bar warm hotspot — additive golden wash centered on bar ──
    // Makes bar feel like an actual radiant source, not just the absence of darkness
    var hcx = 7.5 * TILE;
    var hcy = 2.0 * TILE;   // slightly lower — sits on bar surface, not above
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.scale(1, 0.55);      // squash vertically: wide spread, shallow depth
    var hotspot = ctx.createRadialGradient(0, 0, 0, 0, 0, 5 * TILE);
    hotspot.addColorStop(0,    'rgba(255,210,120,0.11)'); // warm golden center
    hotspot.addColorStop(0.35, 'rgba(240,190,90,0.05)');  // gentle taper
    hotspot.addColorStop(0.70, 'rgba(220,170,70,0.02)');  // whisper
    hotspot.addColorStop(1,    'rgba(200,150,60,0)');
    ctx.fillStyle = hotspot;
    ctx.beginPath();
    ctx.arc(0, 0, 5 * TILE, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    var sprite = new PIXI.Sprite(PIXI.Texture.from(c, { scaleMode: 'linear' }));
    sprite.x = 0; sprite.y = 0;
    sprite.alpha = 1;
    overlayLayer.addChild(sprite);
  }

  // ── Door light pool: warm daylight spilling in from entrance (tile 7, row 10) ──
  function createDoorLightPool() {
    var c = document.createElement('canvas');
    // Pool canvas covers roughly 4×3 tiles so the gradient has room to breathe
    var poolW = 4 * TILE;   // 128px
    var poolH = 3 * TILE;   // 96px
    c.width = poolW; c.height = poolH;
    var ctx = c.getContext('2d');

    // Elliptical warm glow — wider than tall (light fan from doorway)
    var rx = poolW * 0.5;   // horizontal radius = half canvas width
    var ry = poolH * 0.45;  // vertical radius slightly less (flattened ellipse)
    var cx = poolW * 0.5;
    var cy = poolH * 0.55;  // shifted downward so peak sits near door tile edge

    // Use a scaled radial gradient to simulate ellipse (scale ctx, draw circle)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);  // squash vertically to make circle → ellipse
    var grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0,    'rgba(255,220,160,0.22)'); // warm amber core — phone-readable
    grad.addColorStop(0.4,  'rgba(255,210,140,0.12)'); // mid fade
    grad.addColorStop(0.75, 'rgba(255,200,120,0.05)'); // outer whisper
    grad.addColorStop(1,    'rgba(255,200,120,0)');    // fully transparent edge
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    var tex = PIXI.Texture.from(c, { scaleMode: 'linear' });
    var sprite = new PIXI.Sprite(tex);
    // Position: door tile center = (7 * TILE + TILE/2) = 240px, row 10 = 320px
    // Offset the pool so it sits just inside the room (centered on x=240, top at y≈288)
    sprite.x = 7 * TILE + TILE / 2 - poolW / 2;  // 240 - 64 = 176px
    sprite.y = 9 * TILE - poolH * 0.3;            // sits mostly on row 9–10
    sprite.blendMode = 'add';                       // additive so it brightens floor tiles
    sprite.alpha = 1;
    overlayLayer.addChildAt(sprite, 0);            // insert below vignette so vignette edges still apply
  }

  // ── Table area warm wash: static amber glow over seating clusters ──
  // At 375px phone width, table zones read as dark rectangles.
  // This adds faint additive amber light (no breathe, alpha=0.12) so they
  // register as "tables with warm light" rather than "floor void."
  function createTableWarmWash() {
    // Table clusters: left (cols 2-5, rows 4-7) and right (cols 9-12, rows 4-7)
    // Center each wash on the cluster midpoint; use a wide halo radius
    var tableWashes = [
      { x: 3.5 * TILE, y: 5.5 * TILE },   // left cluster center
      { x: 4.5 * TILE, y: 7.0 * TILE },   // left cluster lower
      { x: 10.5 * TILE, y: 5.5 * TILE },  // right cluster center
      { x: 11.5 * TILE, y: 7.0 * TILE },  // right cluster lower
    ];
    for (var tw = 0; tw < tableWashes.length; tw++) {
      var wash = createGlowSprite(80, 0xD4881A, 0.12);
      wash.x = tableWashes[tw].x;
      wash.y = tableWashes[tw].y;
      wash.blendMode = 'add';
      lightLayer.addChild(wash);
      // Static — not pushed to bloomSprites, no breathe animation
    }
  }

  // ── Corridor of light: shadow columns flanking the center aisle ──
  // Left seating block (cols 0-5) and right seating block (cols 9-14) are darkened
  // with a soft-edged dark mask. The center aisle (cols 6-8) stays bright.
  // At phone distance this reads as a single "lane of light" pointing from door → bar.
  // Uses 'normal' blend (not multiply) baked into a static canvas overlay on overlayLayer.
  function createCorridorMask() {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');

    // ── Left column shadow: cols 0–5 (x=0 to x=192) ──
    // Gradient: opaque shadow on far-left edge, transparent at aisle boundary (x≈192)
    var leftGrad = ctx.createLinearGradient(0, 0, 6 * TILE, 0);
    leftGrad.addColorStop(0,    'rgba(8,6,4,0.52)');  // far-left wall — very dark
    leftGrad.addColorStop(0.45, 'rgba(8,6,4,0.38)');  // mid-seating block
    leftGrad.addColorStop(0.78, 'rgba(8,6,4,0.18)');  // near aisle — gentle fade
    leftGrad.addColorStop(1,    'rgba(8,6,4,0)');      // aisle edge — fully transparent
    ctx.fillStyle = leftGrad;
    // Only rows 3-10 (seating + floor, skip bar row 0-2 so bar stays bright)
    ctx.fillRect(0, 3 * TILE, 6 * TILE, 8 * TILE);

    // ── Right column shadow: cols 9–14 (x=288 to x=480) ──
    var rightGrad = ctx.createLinearGradient(9 * TILE, 0, W, 0);
    rightGrad.addColorStop(0,    'rgba(8,6,4,0)');      // aisle edge — fully transparent
    rightGrad.addColorStop(0.22, 'rgba(8,6,4,0.18)');  // near aisle
    rightGrad.addColorStop(0.55, 'rgba(8,6,4,0.38)');  // mid-seating block
    rightGrad.addColorStop(1,    'rgba(8,6,4,0.52)');   // far-right wall
    ctx.fillStyle = rightGrad;
    ctx.fillRect(9 * TILE, 3 * TILE, 6 * TILE, 8 * TILE);

    // ── Subtle vertical fade: shadow intensifies toward door (rows 8-10) ──
    // This reinforces the depth gradient so near rows feel further from bar glow
    var bottomGrad = ctx.createLinearGradient(0, 7 * TILE, 0, H);
    bottomGrad.addColorStop(0,   'rgba(8,6,4,0)');
    bottomGrad.addColorStop(0.5, 'rgba(8,6,4,0.08)');
    bottomGrad.addColorStop(1,   'rgba(8,6,4,0.14)');
    ctx.fillStyle = bottomGrad;
    // Apply to full width but skip the center aisle cols 6-8 so aisle stays clean
    ctx.fillRect(0, 7 * TILE, 6 * TILE, 4 * TILE);
    ctx.fillRect(9 * TILE, 7 * TILE, 6 * TILE, 4 * TILE);

    var sprite = new PIXI.Sprite(PIXI.Texture.from(c, { scaleMode: 'linear' }));
    sprite.x = 0; sprite.y = 0;
    sprite.alpha = 1;
    // Add above door-light-pool (index 1) but below the main vignette/hotspot
    // overlayLayer children: [0]=doorLightPool, [1]=vignetteSprite — insert at 1
    overlayLayer.addChildAt(sprite, Math.min(1, overlayLayer.children.length));
  }

  // ── Door threshold breathing anchor ──
  // Door tile: col 7, row 10 (pixel center: x=240, y=336)
  // Two overlapping glow sprites: cool (outdoor moonlight) + warm (indoor amber)
  // A slow 8s sin cycle cross-fades between them — the threshold "breathes" between two worlds.
  function createDoorBreathAnchor() {
    var doorCX = 7 * TILE + TILE / 2;   // 240px
    var doorCY = 10 * TILE + TILE / 2;  // 336px

    // Cool sprite — moonlight blue, wide, represents "outside"
    var cool = createGlowSprite(72, 0x7EB8D4, 0.28);
    cool.x = doorCX;
    cool.y = doorCY;
    cool.blendMode = 'add';
    cool.alpha = 0.18; // start dim; animation drives it
    lightLayer.addChild(cool);
    doorBreath.cool = cool;

    // Warm sprite — amber indoor, tighter, represents "inside calling you in"
    var warm = createGlowSprite(44, 0xF0B060, 0.32);
    warm.x = doorCX;
    warm.y = doorCY;
    warm.blendMode = 'add';
    warm.alpha = 0.10;
    lightLayer.addChild(warm);
    doorBreath.warm = warm;
  }

  // ── Entry overlay (PixiJS graphics) ──
  var entryOverlay, entryText1, entryText2;
  function initEntryOverlay() {
    entryOverlay = new PIXI.Graphics();
    overlayLayer.addChild(entryOverlay);
  }

  function updateEntryOverlay() {
    if (!entryOverlay) return;
    entryOverlay.clear();
    if (entryState === 0 || entryState >= 4) return;
    var now = Date.now();
    var elapsed = now - entryStart;

    if (entryState === 1) {
      var blackHold = ENTRY_WAIT * 0.4;
      var fadeDur = ENTRY_WAIT * 0.5;
      var fadeAlpha;
      if (elapsed < blackHold) fadeAlpha = 1;
      else fadeAlpha = Math.max(0, 1 - (elapsed - blackHold) / fadeDur);
      entryOverlay.rect(0, 0, W, H);
      entryOverlay.fill({ color: 0x2A2A3D, alpha: fadeAlpha });

      // Bloom during entry
      var bloomStart = ENTRY_WAIT * 0.6;
      if (elapsed > bloomStart) {
        var bloomT = Math.min((elapsed - bloomStart) / (ENTRY_WAIT * 0.4), 1);
        var cruzCX = 4 * TILE + TILE / 2, cruzCY = 2 * TILE + TILE / 2;
        entryOverlay.circle(cruzCX, cruzCY, 40 + bloomT * 80);
        entryOverlay.fill({ color: 0xD4A057, alpha: bloomT * 0.08 });
      }
      if (elapsed >= ENTRY_WAIT) {
        entryState = 2;
        for (var i = 0; i < npcs.length; i++) {
          if (npcs[i].id === 'cruz') npcs[i].facing = 'down';
        }
        if (window.CafeAudio && window.CafeAudio.playInteract) window.CafeAudio.playInteract();
      }
    } else if (entryState === 2) {
      if (now - (entryStart + ENTRY_WAIT) >= ENTRY_GAZE) {
        entryState = 3;
        entryTextTimer = now;
        entryTextAlpha = 0;
      }
    } else if (entryState === 3) {
      var textElapsed = now - entryTextTimer;
      var fadeIn = ENTRY_TEXT_DUR * 0.2;
      var holdEnd = ENTRY_TEXT_DUR * 0.8;
      if (textElapsed < fadeIn) entryTextAlpha = textElapsed / fadeIn;
      else if (textElapsed < holdEnd) entryTextAlpha = 1;
      else if (textElapsed < ENTRY_TEXT_DUR) entryTextAlpha = 1 - (textElapsed - holdEnd) / (ENTRY_TEXT_DUR * 0.2);
      else {
        entryTextAlpha = 0;
        entryState = 4;
        for (var j = 0; j < npcs.length; j++) {
          if (npcs[j].id === 'cruz') npcs[j].facing = npcs[j].defaultFacing || 'down';
        }
      }
      if (entryTextAlpha > 0 && !entryText1) {
        // fontSize 11 → after ~3x mobile camera scale = ~33px CSS — clearly legible at arm's length.
        // 'monospace' keeps the pixel-cafe aesthetic without loading a custom font.
        var style = new PIXI.TextStyle({ fontFamily: 'monospace', fontSize: 11, fill: '#f5d6b0', dropShadow: { alpha: 0.6, angle: Math.PI / 4, blur: 2, color: '#1a0e06', distance: 1 } });
        entryText1 = new PIXI.Text({ text: '', style: style });
        entryText2 = new PIXI.Text({ text: '', style: style });
        entryText1.anchor.set(0.5, 0.5);
        entryText2.anchor.set(0.5, 0.5);
        overlayLayer.addChild(entryText1);
        overlayLayer.addChild(entryText2);
      }
      if (entryText1) {
        var line1, line2;
        if (window.CafeBehavior) {
          var opening = window.CafeBehavior.getOpening();
          line1 = opening.line1;
          line2 = opening.line2;
        } else {
          line1 = '外面雨很大吧？';
          line2 = '先過來坐，咖啡正在煮了。';
        }
        entryText1.text = line1;
        entryText2.text = line2;
        // ── Anchor text to Cruz's tile (col 4) so it reads as Cruz speaking ──
        // Previously anchored to col 7 center — that's behind/right of Cruz, reads as ambient not personal.
        // Now sits just right of Cruz's head, within the warm pendant glow zone.
        var cruzTextX = 4 * TILE + TILE;   // one tile right of Cruz — speech flows right
        var cruzTextY = 1 * TILE + 4;      // just below bar top edge — in the warm amber zone
        entryText1.x = cruzTextX;
        entryText1.y = cruzTextY;
        entryText2.x = cruzTextX;
        entryText2.y = cruzTextY + 11;
        entryText1.alpha = entryTextAlpha * 0.85;
        entryText2.alpha = entryTextAlpha * 0.85;
      }
    }
  }

  // ── Nightfall overlay ──
  var nightfallOverlay;
  function updateNightfall() {
    if (!window._cafeForceClose) return;
    if (!nightfallOverlay) {
      nightfallOverlay = new PIXI.Graphics();
      overlayLayer.addChild(nightfallOverlay);
    }
    if (!nightfallStart) nightfallStart = Date.now();
    var alpha = Math.min((Date.now() - nightfallStart) / NIGHTFALL_DUR, 1);
    alpha = alpha * alpha;
    nightfallOverlay.clear();
    nightfallOverlay.rect(0, 0, W, H);
    nightfallOverlay.fill({ color: 0x0A0806, alpha: alpha });
  }

  // ── Player movement ──
  function updatePlayer() {
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
      if (inputBuffer) { var d = inputBuffer; inputBuffer = null; movePlayer(d); }
    }
  }

  function movePlayer(dir) {
    if (player.moving) { inputBuffer = dir; return; }
    player.facing = dir;
    var d = DIR[dir], nx = player.tileX + d.dx, ny = player.tileY + d.dy;
    if (tileAt(nx, ny) || npcAt(nx, ny)) return;
    if (window.CafeAudio) window.CafeAudio.playWalk();
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
    if (map && map.interactions && interactCb) {
      for (var i = 0; i < map.interactions.length; i++) {
        var it = map.interactions[i];
        if (it.tileX === ft.x && it.tileY === ft.y) {
          interactCb(it.id, ft.x, ft.y); return;
        }
      }
    }
  }

  function handleKey(e) {
    if (window._cafeForceClose) return;
    var k = e.key;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') { e.preventDefault(); movePlayer('up'); }
    else if (k === 'ArrowDown' || k === 's' || k === 'S') { e.preventDefault(); movePlayer('down'); }
    else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { e.preventDefault(); movePlayer('left'); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); movePlayer('right'); }
    else if (k === ' ' || k === 'Enter') { e.preventDefault(); interact(); }
  }

  // ── Main tick ──
  function gameTick(ticker) {
    var dt = ticker.deltaTime / 60; // normalize to seconds-ish
    updatePlayer();
    updateCamera();
    updateEntities();
    updateBubble();

    // Animate bloom breathing
    var now = Date.now();
    if (!reducedMotion) {
      for (var i = 0; i < bloomSprites.length; i++) {
        var bs = bloomSprites[i];
        if (bs.breathe) {
          bs.sprite.scale.set(1 + Math.sin(now / 4000) * 0.08);
        }
      }

      // Door threshold: slow 8s cool↔warm cross-fade
      // sin oscillates -1..1; remap to 0..1 for a clean lerp
      if (doorBreath.cool && doorBreath.warm) {
        var doorT = (Math.sin(now / 8000) + 1) * 0.5; // 0=fully cool, 1=fully warm
        doorBreath.cool.alpha = 0.22 * (1 - doorT);   // cool dims as warm brightens
        doorBreath.warm.alpha = 0.18 * doorT;          // warm pulses in like a heartbeat
        // Also scale slightly so it "breathes" — expands on the warm phase
        doorBreath.cool.scale.set(1 + (1 - doorT) * 0.06);
        doorBreath.warm.scale.set(1 + doorT * 0.09);
      }
    }

    // Player warm pulse — follows player every frame
    if (playerGlow.core && playerGlow.halo) {
      // Center on player sprite midpoint (feet = bottom-center of tile)
      var pgx = player.pixelX + TILE * 0.5;
      var pgy = player.pixelY + TILE * 0.75; // slightly below center — floor contact
      playerGlow.core.x = pgx;
      playerGlow.core.y = pgy;
      playerGlow.halo.x = pgx;
      playerGlow.halo.y = pgy;
      if (!reducedMotion) {
        // Gentle heartbeat: 0.42..0.62 alpha cycle on core, 0.13..0.22 on halo
        var pgT = (Math.sin(now / 2200) + 1) * 0.5; // 0..1, ~2.2s period
        playerGlow.core.alpha = 0.42 + pgT * 0.20;
        playerGlow.halo.alpha = 0.13 + pgT * 0.09;
      }
    }

    // Film grain now handled by CSS overlay (no per-frame JS cost)

    // Particles + window displacement
    if (!reducedMotion) {
      updateParticles(dt);
      updateWindowDisplacement();
    }

    // Nova laptop flicker
    for (var li = 0; li < npcs.length; li++) {
      if (npcs[li].id === 'nova' && entityPixis['nova']) {
        // Subtle blue tint via entity alpha modulation isn't ideal
        // Instead we could add a small glow sprite, but skip for now
        break;
      }
    }

    // Idle effects
    if (now - lastIdleCheck > IDLE_CHECK_INTERVAL) {
      lastIdleCheck = now;
      if (window.CafeBehavior && window.CafeBehavior.getIdleMinutes) {
        cachedIdleMinutes = window.CafeBehavior.getIdleMinutes();
      }
    }
    if (cachedIdleMinutes >= 5 && entryState === 4) {
      var gazePhase = (now / 1000) % 30;
      if (gazePhase < 2) {
        if (!idleGazeActive) {
          idleGazeActive = true;
          for (var gi = 0; gi < npcs.length; gi++) {
            if (npcs[gi].id === 'cruz') npcs[gi].facing = 'down';
          }
        }
      } else if (idleGazeActive) {
        idleGazeActive = false;
        for (var gi2 = 0; gi2 < npcs.length; gi2++) {
          if (npcs[gi2].id === 'cruz') npcs[gi2].facing = npcs[gi2].defaultFacing || 'down';
        }
      }
      window._cafeIdleContemplative = cachedIdleMinutes >= 15;
    } else {
      if (idleGazeActive) {
        idleGazeActive = false;
        for (var gi3 = 0; gi3 < npcs.length; gi3++) {
          if (npcs[gi3].id === 'cruz') npcs[gi3].facing = npcs[gi3].defaultFacing || 'down';
        }
      }
      window._cafeIdleContemplative = false;
    }

    // Entry overlay
    if (entryState > 0 && entryState < 4) updateEntryOverlay();
    // Nightfall
    updateNightfall();

    // Legacy renderCb (for CafeAmbience)
    // Bridge: render to offscreen, composite as sprite
    if (renderCb) {
      var ambCanvas = document.createElement('canvas');
      ambCanvas.width = W; ambCanvas.height = H;
      var ambCtx = ambCanvas.getContext('2d');
      renderCb(ambCtx, now);
      // TODO: optimize — reuse canvas and texture
    }

    // ── Test Seam: expose state for agentic visual QA ──
    window.__CAFE_STATE__ = {
      player: { tileX: player.tileX, tileY: player.tileY, pixelX: player.pixelX, pixelY: player.pixelY },
      camera: { scale: camera.scale, offsetX: camera.offsetX, offsetY: camera.offsetY, isMobile: camera.isMobile, introActive: introCamera.active },
      npcs: npcs.map(function(n) { return { id: n.id, tileX: n.tileX, tileY: n.tileY, facing: n.facing }; }),
      tiles: { cacheKeys: window.CafeTiles ? Object.keys(window.CafeTiles.getCache()) : [] },
      fps: Math.round(app.ticker.FPS),
      entryState: entryState,
      idleMinutes: cachedIdleMinutes,
      timestamp: now
    };
  }

  // ── Camera system: zoom-to-fill + follow player on mobile ──
  var camera = { scale: 1, offsetX: 0, offsetY: 0, isMobile: false };
  var CAM_LERP = 0.08; // smooth camera follow speed
  // ── Intro pan: start on Cruz/counter, drift to player ──
  // cruzRow: 2.0 targets Cruz's face tile (not feet). Golden ratio vertical: vh*0.382
  var introCamera = { active: true, startTime: 0, holdMs: 2500, panMs: 2000, cruzRow: 2.0 };

  function scaleCanvas() {
    if (!app || !app.canvas) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    var isMobile = vw < 768 && vh > vw; // portrait mobile

    if (isMobile) {
      // Mobile: show ~9 tiles vertically so camera can scroll
      // This hides top wall/empty rows when player is in seating area
      var viewRows = 9;
      var mobileScale = vh / (viewRows * TILE);
      // Ensure map is at least as wide as viewport too
      if (W * mobileScale < vw) mobileScale = vw / W;
      camera.scale = mobileScale;
      camera.isMobile = true;

      // Canvas fills the full viewport
      app.canvas.style.width = vw + 'px';
      app.canvas.style.height = vh + 'px';
      app.renderer.resize(vw, vh);
    } else {
      // Desktop: fit entire map, reset camera
      camera.isMobile = false;
      camera.scale = 1;
      camera.offsetX = 0;
      camera.offsetY = 0;
      var r = Math.min(vw / W, vh / H);
      app.canvas.style.width = (W * r) + 'px';
      app.canvas.style.height = (H * r) + 'px';
      app.renderer.resize(W, H);
      if (stage) { stage.scale.set(1); stage.x = 0; stage.y = 0; }
    }
  }

  function updateCamera() {
    if (!camera.isMobile || !stage) return;

    var vw = window.innerWidth, vh = window.innerHeight;
    var s = camera.scale;

    // ── Intro pan: start on Cruz, hold, then drift to player ──
    var playerTargetX = -(player.pixelX + TILE / 2) * s + vw / 2;
    var playerTargetY = -(player.pixelY + TILE / 2) * s + vh / 2;

    // Cruz/counter focus point — center on Cruz (tile x=4) not map center
    // Cruz is the first face a visitor should see; pendant glow sits directly above him at x=4.5
    var cruzFocusX = -(4 * TILE + TILE / 2) * s + vw / 2;
    // Golden ratio vertical: Cruz's face sits at vh*0.382 from top (φ sweet spot)
    // This places bar counter just below visual midpoint — classic cinematic "look up at barista"
    var cruzFocusY = -(introCamera.cruzRow * TILE) * s + vh * 0.382;

    var targetX, targetY;
    var now = performance.now();

    if (introCamera.active) {
      // ── Wait for entry overlay to finish before the pan begins ──
      // entryState < 4 means the black screen / dialogue sequence is still running.
      // Starting the clock early meant the entire pan happened behind the black
      // overlay, so players never saw the cinematic Cruz→you sweep.
      if (entryState < 4) {
        // Lock camera on Cruz while overlay is playing; don't start clock yet.
        targetX = cruzFocusX;
        targetY = cruzFocusY;
        // ── Snap on first frame so Cruz is perfectly framed the instant fade clears ──
        // Without this, camera starts at (0,0) and takes dozens of lerp frames to reach
        // Cruz — meaning the black overlay lifts to a shot of the wrong corner of the cafe.
        if (!introCamera._snapped) {
          introCamera._snapped = true;
          var clampedX = Math.max(-(W * s - vw), Math.min(0, cruzFocusX));
          var clampedY = Math.max(-(H * s - vh), Math.min(0, cruzFocusY));
          camera.offsetX = clampedX;
          camera.offsetY = clampedY;
        }
      } else {
        if (!introCamera.startTime) introCamera.startTime = now;
        var elapsed = now - introCamera.startTime;

        // If player starts moving, skip intro immediately
        if (player.moving) {
          introCamera.active = false;
        } else if (elapsed < introCamera.holdMs) {
          // Phase 1: Hold on Cruz (the 凝視 moment — first thing player sees after fade)
          targetX = cruzFocusX;
          targetY = cruzFocusY;
        } else if (elapsed < introCamera.holdMs + introCamera.panMs) {
          // Phase 2: Smooth ease from Cruz to player (ease-in-out cubic)
          var t = (elapsed - introCamera.holdMs) / introCamera.panMs;
          t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // cubic ease
          targetX = cruzFocusX + (playerTargetX - cruzFocusX) * t;
          targetY = cruzFocusY + (playerTargetY - cruzFocusY) * t;
        } else {
          // Phase 3: Intro complete
          introCamera.active = false;
        }
      }
    }

    if (!introCamera.active) {
      // Normal camera: follow player
      targetX = playerTargetX;
      targetY = playerTargetY;
    }

    // Clamp so we don't show outside the map
    var scaledW = W * s, scaledH = H * s;
    var maxX = scaledW < vw ? (vw - scaledW) / 2 : 0;
    var minX = scaledW < vw ? maxX : -(scaledW - vw);
    var maxY = scaledH < vh ? (vh - scaledH) / 2 : 0;
    var minY = scaledH < vh ? maxY : -(scaledH - vh);

    targetX = Math.max(minX, Math.min(maxX, targetX));
    targetY = Math.max(minY, Math.min(maxY, targetY));

    // Smooth lerp (slower during intro for cinematic feel)
    var lerpSpeed = introCamera.active ? 0.04 : CAM_LERP;
    camera.offsetX += (targetX - camera.offsetX) * lerpSpeed;
    camera.offsetY += (targetY - camera.offsetY) * lerpSpeed;

    stage.scale.set(s);
    stage.x = camera.offsetX;
    stage.y = camera.offsetY;
  }

  // ── Public API (identical to Canvas 2D engine) ──
  window.CafeEngine = {
    init: async function (canvasId, mapData, spriteData, npcData) {
      console.log('☕ CafeEngine.init starting...');
      var canvas = document.getElementById(canvasId);
      if (!canvas) throw new Error('Canvas #' + canvasId + ' not found');
      // Entity canvases are created on demand via getEntityCanvas()

      app = new PIXI.Application();
      console.log('☕ Creating PixiJS app...');
      await app.init({
        canvas: canvas,
        width: W,
        height: H,
        backgroundColor: 0x0A0705,
        antialias: false,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      console.log('☕ PixiJS app initialized');
      stage = app.stage;
      stage.sortableChildren = true;

      map = mapData || {};
      npcs = npcData || [];
      for (var i = 0; i < npcs.length; i++) {
        npcs[i].defaultFacing = npcs[i].facing || 'down';
      }

      // Create layer hierarchy
      bgLayer = new PIXI.Container();
      entityLayer = new PIXI.Container();
      entityLayer.sortableChildren = true;
      lightLayer = new PIXI.Container();
      uiLayer = new PIXI.Container();
      overlayLayer = new PIXI.Container();
      particleLayer = new PIXI.Container();

      stage.addChild(bgLayer);
      stage.addChild(lightLayer);      // bloom lights below entities
      stage.addChild(entityLayer);
      stage.addChild(particleLayer);
      stage.addChild(uiLayer);
      stage.addChild(overlayLayer);

      // Bake tilemap
      console.log('☕ Baking tilemap...');
      var tilemapCanvas = bakeTilemap();
      bgSprite = new PIXI.Sprite(PIXI.Texture.from(tilemapCanvas, { scaleMode: 'nearest' }));
      bgLayer.addChild(bgSprite);

      // Init player
      player.tileX = 7; player.tileY = 10;
      player.pixelX = player.tileX * TILE;
      player.pixelY = player.tileY * TILE;
      player.facing = 'up'; player.moving = false;

      // Create bloom lights
      console.log('☕ Creating bloom lights...');
      createBloomLights();

      // Player warm pulse glow (follows player sprite)
      createPlayerGlow();

      // Apply blur to light layer for real gaussian bloom
      lightLayer.filters = [new PIXI.BlurFilter({ strength: 6, quality: 3 })];

      // Setup post-process filters
      console.log('☕ Setting up filters...');
      setupFilters();

      // Init particles
      console.log('☕ Initializing particles...');
      initParticles();

      // Init window displacement (rain glass refraction)
      console.log('☕ Initializing window displacement...');
      initWindowDisplacement();

      // Init entry overlay
      initEntryOverlay();

      // Ambient vignette: bar brightest → corners darkest
      createAmbientVignette();

      // Door light pool: warm daylight spilling in from entrance
      createDoorLightPool();

      // Door threshold breathing anchor: cool↔warm cross-fade (8s cycle)
      createDoorBreathAnchor();

      // Table area warm wash: static amber lift for seating zone visibility
      createTableWarmWash();

      // Corridor of light: shadow columns on left/right seating blocks, aisle stays bright
      createCorridorMask();

      // Reduced motion check
      var mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      reducedMotion = mql.matches;
      if (mql.addEventListener) mql.addEventListener('change', function (e) { reducedMotion = e.matches; });

      // Scale & input
      scaleCanvas();
      window.addEventListener('resize', scaleCanvas);
      window.addEventListener('keydown', handleKey);
      console.log('☕ CafeEngine.init complete');
    },

    start: function () {
      app.ticker.add(gameTick);
    },

    startCinematicEntry: function () {
      if (!window._cafeEntryDone) {
        window._cafeEntryDone = true;
        var tier = window.CafeBehavior ? window.CafeBehavior.getVisitTier() : 'first';
        var opening = window.CafeBehavior ? window.CafeBehavior.getOpening() : {};
        if (tier === 'family' || opening.skipIntro) { entryState = 4; return; }
        if (tier === 'returning') {
          ENTRY_WAIT = 1000; ENTRY_GAZE = 500; ENTRY_TEXT_DUR = 2500;
        } else if (tier === 'regular') {
          ENTRY_WAIT = 500; ENTRY_GAZE = 300; ENTRY_TEXT_DUR = 1200;
        }
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
    },
    // PixiJS-specific: expose for external access
    getApp: function () { return app; },
    getStage: function () { return stage; }
  };
})();
