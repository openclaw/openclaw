/**
 * touch.js — Mobile Virtual Joystick + A Button
 *
 * Per Sakurai: joystick center = where finger touches down (not fixed position).
 * Threshold: 16px drag = direction registered.
 * A button: fixed bottom-right, triggers interact.
 */
;(function() {
  'use strict';

  var joystick = null;   // {startX, startY, active}
  var deadzone = 16;     // px before direction triggers
  var moveInterval = null;
  var lastDir = null;
  var enabled = false;
  var aBtn = null;
  var joyVisual = null;  // visual feedback element

  function init(containerEl) {
    if (!('ontouchstart' in window)) return; // desktop: no touch controls

    enabled = true;

    // A button (interact) — fixed bottom-right
    aBtn = document.createElement('div');
    aBtn.textContent = 'A';
    aBtn.style.cssText = 'position:fixed;bottom:24px;right:24px;width:56px;height:56px;' +
      'border-radius:50%;background:rgba(245,166,35,0.85);color:#1a120b;' +
      'font-size:22px;font-weight:bold;display:flex;align-items:center;justify-content:center;' +
      'z-index:1000;user-select:none;-webkit-user-select:none;touch-action:none;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.5);border:2px solid #c78c19;';
    document.body.appendChild(aBtn);

    aBtn.addEventListener('touchstart', function(e) {
      e.preventDefault();
      aBtn.style.transform = 'scale(0.9)';
      if (window.CafeEngine) window.CafeEngine.interact();
    }, { passive: false });
    aBtn.addEventListener('touchend', function() {
      aBtn.style.transform = 'scale(1)';
    });

    // Joystick visual (hidden until touch)
    joyVisual = document.createElement('div');
    joyVisual.style.cssText = 'position:fixed;width:80px;height:80px;border-radius:50%;' +
      'border:2px solid rgba(245,166,35,0.4);background:rgba(245,166,35,0.08);' +
      'pointer-events:none;z-index:999;display:none;';
    var joyDot = document.createElement('div');
    joyDot.style.cssText = 'position:absolute;top:50%;left:50%;width:24px;height:24px;' +
      'border-radius:50%;background:rgba(245,166,35,0.6);transform:translate(-50%,-50%);';
    joyVisual.appendChild(joyDot);
    document.body.appendChild(joyVisual);

    // Touch events on left half of screen = joystick
    containerEl.addEventListener('touchstart', onTouchStart, { passive: false });
    containerEl.addEventListener('touchmove', onTouchMove, { passive: false });
    containerEl.addEventListener('touchend', onTouchEnd, { passive: false });
    containerEl.addEventListener('touchcancel', onTouchEnd, { passive: false });
  }

  function onTouchStart(e) {
    var t = e.changedTouches[0];
    // Only left 70% of screen is joystick (right side reserved for A button)
    if (t.clientX > window.innerWidth * 0.7) return;
    e.preventDefault();
    joystick = { startX: t.clientX, startY: t.clientY, id: t.identifier, active: true };
    joyVisual.style.display = 'block';
    joyVisual.style.left = (t.clientX - 40) + 'px';
    joyVisual.style.top = (t.clientY - 40) + 'px';
    lastDir = null;
  }

  function onTouchMove(e) {
    if (!joystick || !joystick.active) return;
    var t = null;
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === joystick.id) {
        t = e.changedTouches[i]; break;
      }
    }
    if (!t) return;
    e.preventDefault();

    var dx = t.clientX - joystick.startX;
    var dy = t.clientY - joystick.startY;
    var dist = Math.sqrt(dx * dx + dy * dy);

    // Update joystick dot visual
    var dot = joyVisual.firstChild;
    var clampDist = Math.min(dist, 30);
    var angle = Math.atan2(dy, dx);
    dot.style.transform = 'translate(calc(-50% + ' + (Math.cos(angle) * clampDist) + 'px), calc(-50% + ' + (Math.sin(angle) * clampDist) + 'px))';

    if (dist < deadzone) {
      stopMove();
      return;
    }

    // Determine direction (4-way, snap to axis)
    var dir;
    if (Math.abs(dx) > Math.abs(dy)) {
      dir = dx > 0 ? 'right' : 'left';
    } else {
      dir = dy > 0 ? 'down' : 'up';
    }

    if (dir !== lastDir) {
      stopMove();
      lastDir = dir;
      // Send move immediately, then repeat while held
      if (window.CafeEngine) window.CafeEngine.movePlayer(dir);
      moveInterval = setInterval(function() {
        if (window.CafeEngine) window.CafeEngine.movePlayer(dir);
      }, 150);
    }
  }

  function onTouchEnd(e) {
    if (!joystick) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === joystick.id) {
        stopMove();
        joystick = null;
        joyVisual.style.display = 'none';
        var dot = joyVisual.firstChild;
        dot.style.transform = 'translate(-50%, -50%)';
        return;
      }
    }
  }

  function stopMove() {
    if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
    lastDir = null;
  }

  window.CafeTouch = { init: init, isEnabled: function() { return enabled; } };
})();
