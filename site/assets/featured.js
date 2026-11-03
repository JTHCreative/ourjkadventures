/* j+k adventures: the featured carousel at the top of the shop. Up to eight pins and boards stand on a slowly
   turning ring, like a lazy susan in a shop window, each with a small shadow on the floor below it.

   Like the reel door (reel-door.js), everything is driven by one number, the ring angle in degrees. Every frame each
   item's spot (sideways, a little up the further back it is, smaller, fainter) is worked out from that number and
   written straight onto its style. Spin speed is a second number: it drifts back to a gentle cruise, so a hard
   drag spins the ring fast for a moment and then it settles, the way a pushed roundabout slows down.

   It rests (eases to a stop) while a mouse is over it or a link in it has focus, so a pin can be clicked. The
   pause button stops all motion. Someone who asks for less motion gets a still ring that moves only when dragged
   or stepped, with no coasting. Off screen, or in a hidden tab, nothing runs.

   With only one or two picks, they are repeated round the ring (six spots) so it still turns like a carousel. The
   repeats are skipped by the keyboard and screen readers, so each pick is met once.

   Use: Featured.mount(node, items), items = [{ href, img, srcset?, board?, name, price, label }]. app.js does this from /api/catalog. */
(function (root) {
  'use strict';

  var CRUISE = 9;           // degrees a second at rest: one turn in 40 seconds
  var SETTLE = 1.1;         // seconds for a fast spin to drift most of the way back to cruise
  var MAX_SPIN = 900;       // the fastest a flick can spin it, degrees a second
  var BOB = 5;              // px each item floats up and down
  var BOB_SECONDS = 3.4;

  function mod(a, n) { return ((a % n) + n) % n; }

  // where item i of N sits when the ring is at `angle`. f is 1 at the front, 0 at the very back
  function spot(i, N, angle, Rx, arc) {
    var th = (i * 360 / N + angle) * Math.PI / 180;
    var f = (Math.cos(th) + 1) / 2;
    return {
      x: Rx * Math.sin(th),
      y: -arc * (1 - f),
      scale: 0.56 + 0.44 * f,
      f: f,
      zIndex: Math.round(f * 1000)
    };
  }

  // the ring angle that brings item i to the front, picked so the ring takes the short way round
  function frontAngle(i, N, from) {
    var a = -i * 360 / N;
    return from + (mod(a - from + 180, 360) - 180);
  }

  // one step of spin: speed drifts toward `goal` (it never jumps), and the angle moves by it. dt in seconds
  function drift(omega, goal, dt) {
    return goal + (omega - goal) * Math.exp(-dt / SETTLE);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function icon(paths) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    paths.forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }
  var ICON = {
    left: ['M15 6l-6 6 6 6'],
    right: ['M9 6l6 6-6 6'],
    pause: ['M9 6v12', 'M15 6v12'],
    play: ['M8 5.5v13l11-6.5z']
  };

  var MIN_SPOTS = 6;        // fewer picks than this (one or two) are repeated round the ring

  // the ring's spots: the picks themselves, or with one or two, the picks over again until there are six
  function ringOf(items) {
    if (!items.length || items.length >= 3) return items.map(function (it) { return { it: it, copy: false }; });
    var out = [];
    for (var k = 0; out.length < MIN_SPOTS; k++) out.push({ it: items[k % items.length], copy: k >= items.length });
    return out;
  }

  function buildItem(it) {
    var a = el('a', 'feat-item' + (it.board ? ' feat-item--board' : ''));
    a.href = it.href;
    a.setAttribute('aria-label', it.label || it.name);
    a.draggable = false;
    var float = el('span', 'feat-float');
    var img = el('img');
    img.src = it.img;
    if (it.srcset) { img.srcset = it.srcset; img.sizes = '160px'; }
    img.alt = '';
    if (!it.board) { img.width = 300; img.height = 300; }
    img.draggable = false;
    img.decoding = 'async';
    float.appendChild(img);
    var shadow = el('span', 'feat-shadow');
    shadow.setAttribute('aria-hidden', 'true');
    var tag = el('span', 'feat-label');
    tag.setAttribute('aria-hidden', 'true');
    tag.appendChild(el('span', 'feat-name', it.name));
    if (it.price) tag.appendChild(el('span', 'feat-price', it.price));
    a.appendChild(shadow);
    a.appendChild(float);
    a.appendChild(tag);
    return { node: a, float: float, shadow: shadow, tag: tag };
  }

  function mount(node, items) {
    items = (items || []).filter(function (it) { return it && it.href && it.img; }).slice(0, 8);
    node.textContent = '';
    if (!items.length) return null;
    var spots = ringOf(items);
    var N = spots.length;

    var stage = el('div', 'feat-stage');
    var built = spots.map(function (sp) {
      var b = buildItem(sp.it);
      // a repeat is there for the look of the ring: a tap still opens it, but tabbing and screen readers skip it
      if (sp.copy) { b.node.tabIndex = -1; b.node.setAttribute('aria-hidden', 'true'); }
      return b;
    });
    built.forEach(function (b) { stage.appendChild(b.node); });
    node.appendChild(stage);

    var controls = el('div', 'feat-controls');
    function button(cls, label, paths, onClick) {
      var b = el('button', 'icon-btn ' + cls);
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.appendChild(icon(paths));
      b.addEventListener('click', onClick);
      return b;
    }
    var leftBtn = button('feat-left', 'turn the carousel left', ICON.left, function () { step(-1); });
    var pauseBtn = button('feat-pause', 'pause the carousel', ICON.pause, function () { setHeld(!held); });
    var rightBtn = button('feat-right', 'turn the carousel right', ICON.right, function () { step(1); });
    controls.appendChild(leftBtn);
    controls.appendChild(pauseBtn);
    controls.appendChild(rightBtn);
    node.appendChild(controls);

    var motion = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var calm = !!(motion && motion.matches);
    var held = calm;                // the pause button. less motion starts paused
    var hovering = false, focused = false, visible = true;
    var angle = 0, omega = calm ? 0 : CRUISE, dir = 1, aim = null;
    var raf = 0, last = 0;
    var drag = null, swallowClick = false;
    var Rx = 200, arc = 40;

    function measure() {
      var w = stage.clientWidth;
      var item = built[0].node.offsetWidth || 150;
      // as wide as the stage allows, keeping the side items inside it, but never so wide the ring looks flat
      // (the band trims anything past the screen edge, so on phones the ring may reach into the side margins)
      var room = Math.max(w, Math.min(root.innerWidth || w, w + 32));
      Rx = Math.max(60, Math.min(room / 2 - item * 0.3, item * 2.6));
      arc = Math.round(item * 0.42);
    }

    function render(now) {
      var bobbing = !held && !calm;
      var phase = (now || 0) / 1000 * 2 * Math.PI / BOB_SECONDS;
      built.forEach(function (b, i) {
        var p = spot(i, N, angle, Rx, arc);
        b.node.style.transform = 'translate(-50%, 0) translate(' + p.x.toFixed(1) + 'px, ' + p.y.toFixed(1) + 'px) scale(' + p.scale.toFixed(3) + ')';
        b.node.style.zIndex = String(p.zIndex);
        b.node.style.opacity = (0.4 + 0.6 * p.f).toFixed(3);
        b.tag.style.opacity = Math.max(0, (p.f - 0.72) / 0.28).toFixed(3);
        // each one floats on its own beat; its shadow shrinks and fades a little as it rises, and follows it round
        var lift = bobbing ? (1 + Math.sin(phase + i * 1.7)) / 2 : 0;
        b.float.style.transform = 'translateY(' + (-lift * BOB).toFixed(2) + 'px)';
        b.shadow.style.transform = 'translateX(-50%) scale(' + (1 - lift * 0.18).toFixed(3) + ')';
        b.shadow.style.opacity = (1 - lift * 0.35).toFixed(3);
      });
    }

    function resting() { return held || hovering || focused || calm; }
    function goal() { return resting() ? 0 : CRUISE * dir; }
    function busy() { return !!drag || aim !== null || Math.abs(omega - goal()) > 0.05 || (goal() !== 0) || (!held && !calm); }

    function kick() {
      if (raf || !visible || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(tick);
    }
    function tick(now) {
      raf = 0;
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      if (!drag) {
        if (aim !== null) {
          // glide to a chosen item: close a fixed share of the gap each moment, like a door closer
          var gap = aim - angle;
          if (Math.abs(gap) < 0.05) { angle = aim; aim = null; omega = 0; }
          else angle += gap * (1 - Math.exp(-dt * 7));
        } else {
          omega = drift(omega, goal(), dt);
          if (Math.abs(omega) < 0.02 && goal() === 0) omega = 0;
          angle += omega * dt;
        }
        // keep the number small after many turns (a whole turn is the same spot), but never mid-glide
        if (aim === null && Math.abs(angle) > 36000) angle = mod(angle, 360);
      }
      render(now);
      // carry on next frame, keeping the clock running; once still, the loop stops until something kicks it
      if (busy() && visible && !document.hidden) raf = requestAnimationFrame(tick);
    }

    function setHeld(on) {
      held = on;
      pauseBtn.setAttribute('aria-label', on ? 'play the carousel' : 'pause the carousel');
      pauseBtn.textContent = '';
      pauseBtn.appendChild(icon(on ? ICON.play : ICON.pause));
      pauseBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) { omega = 0; render(0); }
      kick();
    }

    // which item is nearest the front right now
    function frontIndex() {
      var best = 0, bestF = -1;
      for (var i = 0; i < N; i++) { var f = spot(i, N, angle, Rx, arc).f; if (f > bestF) { bestF = f; best = i; } }
      return best;
    }
    function goTo(i) {
      omega = 0;
      if (calm) { angle = frontAngle(i, N, angle); aim = null; render(0); return; }
      aim = frontAngle(i, N, angle);
      kick();
    }
    // the arrows turn the ring one item: "right" moves the items rightward, bringing the one on the left forward
    function step(d) {
      var i = aim !== null ? mod(Math.round(-aim / (360 / N)), N) : frontIndex();
      dir = d;
      goTo(mod(i - d, N));
    }

    /* ---------- dragging: the ring follows the finger, and a flick sets it spinning ---------- */
    stage.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, startAngle: angle, moving: false, samples: [] };
    });
    stage.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moving) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }   // a scroll, not a drag
        if (Math.abs(dx) <= 4) return;
        drag.moving = true;
        drag.x = e.clientX;
        drag.startAngle = angle;
        dx = 0;
        aim = null;
        omega = 0;
        try { stage.setPointerCapture(e.pointerId); } catch (err) {}
        stage.classList.add('is-dragging');
      }
      // dragging right moves the front item right
      angle = drag.startAngle + dx * (180 / Math.PI) / Rx;
      var now = performance.now();
      drag.samples.push({ t: now, a: angle });
      while (drag.samples.length > 2 && now - drag.samples[0].t > 100) drag.samples.shift();
      e.preventDefault();
      kick();
    });
    function release(e, cancelled) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag;
      drag = null;
      if (!d.moving) return;                     // a tap: the link does its job
      stage.classList.remove('is-dragging');
      try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
      swallowClick = true;
      setTimeout(function () { swallowClick = false; }, 0);
      // the pointer's speed over its last 100 ms, or none if it rested before letting go
      var v = 0, now = performance.now(), sm = d.samples;
      if (!cancelled && sm.length > 1 && now - sm[sm.length - 1].t <= 90) {
        var a = sm[0], b = sm[sm.length - 1];
        if (b.t > a.t) v = (b.a - a.a) / (b.t - a.t) * 1000;
      }
      v = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, v));
      if (Math.abs(v) > 20) dir = v > 0 ? 1 : -1;  // it carries on the way it was flicked
      omega = calm ? 0 : v;
      kick();
    }
    stage.addEventListener('pointerup', function (e) { release(e, false); });
    stage.addEventListener('pointercancel', function (e) { release(e, true); });
    stage.addEventListener('lostpointercapture', function (e) { if (e.target === stage && drag && drag.moving) release(e, true); });
    // a drag that ends over a pin must not also open it
    stage.addEventListener('click', function (e) {
      if (swallowClick) { e.preventDefault(); e.stopPropagation(); swallowClick = false; }
    }, true);
    stage.addEventListener('dragstart', function (e) { e.preventDefault(); });

    /* ---------- resting while someone is looking closely ---------- */
    stage.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') { hovering = true; kick(); } });
    stage.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') { hovering = false; kick(); } });
    // tabbing to an item brings it to the front and holds the ring there. a mouse click also focuses a link in
    // some browsers; that isn't someone tabbing, so only keyboard focus (the visible ring) counts
    built.forEach(function (b, i) {
      b.node.addEventListener('focus', function () {
        var byKeys = true;
        try { byKeys = b.node.matches(':focus-visible'); } catch (err) {}
        if (!byKeys) return;
        focused = true;
        if (!drag) goTo(i);
      });
      b.node.addEventListener('blur', function (e) {
        if (!stage.contains(e.relatedTarget)) { focused = false; kick(); }
      });
    });

    /* ---------- the world around it ---------- */
    function onMotionChange() {
      calm = !!(motion && motion.matches);
      if (calm) { omega = 0; aim = null; setHeld(true); } else kick();
    }
    if (motion) {
      if (motion.addEventListener) motion.addEventListener('change', onMotionChange);
      else if (motion.addListener) motion.addListener(onMotionChange);
    }
    if (root.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) kick(); else if (raf) { cancelAnimationFrame(raf); raf = 0; }
      }).observe(stage);
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) kick(); });
    var queued = false;
    root.addEventListener('resize', function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; measure(); render(0); });
    });

    setHeld(held);
    measure();
    render(0);
    stage.classList.add('is-ready');
    kick();
    return { N: N };
  }

  root.Featured = { mount: mount, ringOf: ringOf, spot: spot, frontAngle: frontAngle, drift: drift, CRUISE: CRUISE };
})(typeof window !== 'undefined' ? window : globalThis);
