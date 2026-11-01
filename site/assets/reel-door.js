/* j+k adventures: the reel door. A ring of upright reels; dragging, an arrow, a key, a dot or a tap pulls the next
   reel forward and pushes the current one back. Spec: docs/reel-door-spec.md.

   The whole thing is driven by one number, the ring angle in degrees. Every frame, each reel's spot (x, a small
   lift, size, stacking) is worked out from that number and written straight onto the reel's style, so nothing
   else on the page is rebuilt while it moves. The animation loop only runs while something is moving.

   Use: <div data-reel-door></div> on a page that loads this file. Optional attributes, all from the spec:
   data-count, data-spread, data-depth, data-lift, data-arc, data-perspective, data-pop, data-clearance,
   data-swing, data-auto-advance, and data-reels-src (a JSON list of reels, for example /api/reels).
   Without data-reels-src it shows the placeholder reels below. */
(function (root) {
  'use strict';

  var PROFILE = 'https://www.instagram.com/ourjkadventures/';
  var HANDLE = 'ourjkadventures';

  // the tuning values, their defaults and allowed ranges (spec: geometry and maths)
  var DEFAULTS = {
    count: 8, spread: 1, depth: 260, lift: 90, arc: 36, perspective: 1500, pop: 40, clearance: 56, swing: 14,
    autoAdvance: false
  };
  var RANGES = {
    count: [4, 12], spread: [0.6, 1.6], depth: [100, 600], lift: [0, 220], arc: [0, 120],
    perspective: [600, 3000], pop: [0, 160], clearance: [0, 140], swing: [0, 35]
  };
  var PHONE_WIDTH = 480;      // below this the stage spreads reels closer and the arrows hide
  var PHONE_SPREAD = 0.72;

  // eight stand-ins until the real reels come from instagram. one is our own hero video, so playback can be tested
  var PLACEHOLDER_REELS = [
    { id: 'p1', thumbnailUrl: 'assets/video/reel-v4-poster.jpg', videoUrl: 'assets/video/reel-v4-phone.mp4', permalink: PROFILE, caption: 'the pack on felt, ready for a walk.' },
    { id: 'p2', thumbnailUrl: 'assets/img/pins/aussie.webp', permalink: PROFILE, caption: 'the aussie, one ear up.', placeholder: true },
    { id: 'p3', thumbnailUrl: 'assets/img/pins/corgi.webp', permalink: PROFILE, caption: 'a corgi with big plans.', placeholder: true },
    { id: 'p4', thumbnailUrl: 'assets/img/pins/shiba.webp', permalink: PROFILE, caption: 'the shiba, unimpressed as ever.', placeholder: true },
    { id: 'p5', thumbnailUrl: 'assets/img/pins/golden.webp', permalink: PROFILE, caption: 'goldie, a friend to everyone.', placeholder: true },
    { id: 'p6', thumbnailUrl: 'assets/img/pins/pomeranian.webp', permalink: PROFILE, caption: 'a pomeranian, mostly fluff.', placeholder: true },
    { id: 'p7', thumbnailUrl: 'assets/img/pins/husky.webp', permalink: PROFILE, caption: 'the husky has opinions.', placeholder: true },
    { id: 'p8', thumbnailUrl: 'assets/img/pins/beagle.webp', permalink: PROFILE, caption: 'beagle, nose first.', placeholder: true }
  ];

  /* ---------- the maths (pure, tested in tests/reel-door.test.mjs) ---------- */

  function mod(a, n) { return ((a % n) + n) % n; }

  // sideways reach of the ring. W is the reel width
  function reach(N, W, spread) {
    return (0.8 * W / Math.max(0.35, Math.sin(2 * Math.PI / N))) * spread;
  }

  // where reel i sits when the ring is at `angle`. o holds depth, lift, arc, perspective, pop, clearance, swing
  function place(i, N, angle, Rx, o) {
    var s = 360 / N;
    var d = mod(i * s - angle + 180, 360) - 180;        // signed offset from the front, -180..180
    var ad = Math.abs(d), rad = d * Math.PI / 180;
    var w = Math.max(0, 1 - ad / s);
    var ease = w * w * (3 - 2 * w);                     // 1 at the front, 0 at a neighbour's spot
    var t = Math.min(1, ad / s);
    var bump = Math.sin(Math.PI * t);                   // 0 at rest, 1 halfway through a swap
    var side = d > 0 ? 1 : d < 0 ? -1 : 0;
    var back = (1 - Math.cos(rad)) / 2;                 // 0 at the front, 1 directly behind
    var z = -2 * o.depth * back + o.lift * ease + o.pop * bump;
    var scale = o.perspective / Math.max(1, o.perspective - z);
    return {
      d: d,
      x: (Rx * Math.sin(rad) + side * o.clearance * bump) * scale,
      y: -o.arc * back * scale,
      scale: scale,
      rotY: side * o.swing * bump,
      zIndex: 1000 - Math.round(ad * 10),
      haze: Math.min(0.78, (ad / s) * 0.22)
    };
  }

  // where a released drag comes to rest: coast on the pointer's speed for 0.22 s, snap to a reel,
  // and never more than 3 reels from where it was let go
  function settleAngle(angle, velocity, s) {
    var base = Math.round(angle / s) * s;
    var snapped = Math.round((angle + velocity * 0.22) / s) * s;
    return Math.max(base - 3 * s, Math.min(base + 3 * s, snapped));
  }

  function clampProp(name, v) {
    var r = RANGES[name];
    v = Number(v);
    if (!isFinite(v)) return DEFAULTS[name];
    return r ? Math.max(r[0], Math.min(r[1], v)) : v;
  }

  // only https links leave the page; anything else points at our profile
  function safeUrl(u, fallback) {
    return typeof u === 'string' && /^https:\/\//i.test(u) ? u : fallback;
  }
  function assetUrl(u) {
    return typeof u === 'string' && (/^https:\/\//i.test(u) || /^assets\//.test(u)) ? u : '';
  }

  /* ---------- the component ---------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function icon(paths) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
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
    prev: ['M15 5l-7 7 7 7'],
    next: ['M9 5l7 7-7 7'],
    play: ['M8 5.5v13l10.5-6.5z'],
    pause: ['M9 5.5v13', 'M15 5.5v13'],
    soundOff: ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z', 'M16 9.5l5 5', 'M21 9.5l-5 5'],
    soundOn: ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z', 'M16 9a4 4 0 0 1 0 6', 'M18.5 6.5a7.5 7.5 0 0 1 0 11']
  };

  function mount(rootEl, options) {
    options = options || {};
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      o[k] = k === 'autoAdvance' ? options[k] === true : clampProp(k, options[k] === undefined ? DEFAULTS[k] : options[k]);
    });
    var reels = (options.reels || []).filter(function (r) { return r && assetUrl(r.thumbnailUrl); }).slice(0, Math.round(o.count));
    var N = reels.length;
    if (!N) { rootEl.hidden = true; return null; }
    var s = 360 / N;

    var motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var calm = !!(motion && motion.matches);

    // motion state. plain variables, never framework state: nothing re-renders per frame
    var angle = 0, target = 0, velocity = 0, raf = 0, last = 0;
    var drag = null;            // { id, x, y, startAngle, moving, samples }
    var swallowClick = false;
    var W = 208, Rx = 0, spread = o.spread;
    var front = -1, announced = -1, settled = true, inView = true;
    var muted = true, held = false;   // held: the viewer pressed pause, so nothing plays until they press play

    rootEl.classList.add('reel-door');
    rootEl.textContent = '';

    var stage = el('div', 'reel-door__stage');
    stage.setAttribute('role', 'group');
    stage.setAttribute('aria-roledescription', 'carousel');
    stage.setAttribute('aria-label', options.label || 'reels from our instagram');
    stage.tabIndex = 0;

    var items = reels.map(function (r, i) { return buildReel(r, i); });
    items.forEach(function (it) { stage.appendChild(it.node); });

    var controls = el('div', 'reel-door__controls');
    var prevBtn = arrowButton('previous reel', ICON.prev, function () { step(-1); });
    var nextBtn = arrowButton('next reel', ICON.next, function () { step(1); });
    var dotsBox = el('div', 'reel-door__dots');
    var dots = reels.map(function (r, i) {
      var b = el('button', 'reel-door__dot');
      b.type = 'button';
      b.setAttribute('aria-label', 'reel ' + (i + 1));
      b.addEventListener('click', function () { goTo(i); });
      dotsBox.appendChild(b);
      return b;
    });
    controls.appendChild(prevBtn);
    controls.appendChild(dotsBox);
    controls.appendChild(nextBtn);

    // the counter doubles as the polite announcement: "reel 3 of 8"
    var counter = el('p', 'reel-door__count');
    counter.setAttribute('aria-live', 'polite');
    counter.setAttribute('aria-atomic', 'true');

    rootEl.appendChild(stage);
    rootEl.appendChild(controls);
    rootEl.appendChild(counter);

    function arrowButton(label, paths, onClick) {
      var b = el('button', 'reel-door__arrow');
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.appendChild(icon(paths));
      b.addEventListener('click', onClick);
      return b;
    }

    function buildReel(r, i) {
      var node = el('div', 'reel-door__reel' + (r.placeholder ? ' reel-door__reel--placeholder' : ''));
      node.setAttribute('role', 'group');
      node.setAttribute('aria-roledescription', 'slide');
      node.setAttribute('aria-label', (i + 1) + ' of ' + N);
      node.setAttribute('data-index', String(i));
      var card = el('div', 'reel-door__card');
      var media = el('div', 'reel-door__media');
      var permalink = safeUrl(r.permalink, PROFILE);
      var thumb = assetUrl(r.thumbnailUrl);
      var video = null, link = null;
      var videoUrl = assetUrl(r.videoUrl);
      if (videoUrl) {
        video = document.createElement('video');
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.loop = !o.autoAdvance;
        video.preload = 'none';
        video.poster = thumb;
        video.src = videoUrl;
        video.setAttribute('aria-hidden', 'true');
        media.appendChild(video);
      } else {
        var img = el('img');
        img.src = thumb;
        img.alt = '';
        img.draggable = false;
        img.loading = i < 3 || i > N - 3 ? 'eager' : 'lazy';
        if (r.placeholder) {
          media.appendChild(img);
        } else {
          // instagram left out the video file (licensed music, usually): the front reel opens the post instead
          link = el('a', 'reel-door__open');
          link.href = permalink;
          link.target = '_blank';
          link.rel = 'noopener';
          link.setAttribute('aria-label', 'watch this reel on instagram');
          link.appendChild(img);
          var badge = el('span', 'reel-door__open-badge');
          badge.appendChild(icon(ICON.play));
          link.appendChild(badge);
          media.appendChild(link);
        }
      }
      card.appendChild(media);

      var num = el('span', 'reel-door__num', String(i + 1));
      num.setAttribute('aria-hidden', 'true');
      card.appendChild(num);

      var tools = null, playBtn = null, soundBtn = null;
      if (video) {
        tools = el('div', 'reel-door__tools');
        playBtn = el('button', 'reel-door__tool');
        playBtn.type = 'button';
        playBtn.addEventListener('click', function () {
          if (video.paused) { held = false; playFront(true); } else { held = true; video.pause(); }
        });
        soundBtn = el('button', 'reel-door__tool');
        soundBtn.type = 'button';
        soundBtn.addEventListener('click', function () {
          muted = !muted;
          video.muted = muted;
          paintTools(it);
          if (!muted && video.paused) { held = false; playFront(true); }
        });
        tools.appendChild(playBtn);
        tools.appendChild(soundBtn);
        card.appendChild(tools);
      }

      var panel = el('div', 'reel-door__panel');
      var who = el('div', 'reel-door__who');
      var avatar = el('img', 'reel-door__avatar');
      avatar.src = 'assets/img/logo.svg';
      avatar.alt = '';
      avatar.draggable = false;
      var handle = el('a', 'reel-door__handle', '@' + (typeof r.username === 'string' && r.username ? r.username : HANDLE));
      handle.href = permalink;
      handle.target = '_blank';
      handle.rel = 'noopener';
      handle.setAttribute('aria-label', 'see this reel on instagram');
      handle.draggable = false;
      who.appendChild(avatar);
      who.appendChild(handle);
      panel.appendChild(who);
      if (typeof r.caption === 'string' && r.caption.trim()) {
        panel.appendChild(el('p', 'reel-door__caption', r.caption.trim()));
      }
      var track = el('div', 'reel-door__progress');
      track.setAttribute('aria-hidden', 'true');
      var bar = el('div', 'reel-door__bar');
      track.appendChild(bar);
      panel.appendChild(track);
      card.appendChild(panel);

      var haze = el('div', 'reel-door__haze');
      card.appendChild(haze);
      node.appendChild(card);

      var it = { node: node, haze: haze, bar: bar, video: video, playBtn: playBtn, soundBtn: soundBtn,
        focusables: [handle, link, playBtn, soundBtn].filter(Boolean) };

      if (video) {
        video.addEventListener('timeupdate', function () {
          if (front !== i || !video.duration) return;
          bar.style.transform = 'scaleX(' + Math.min(1, video.currentTime / video.duration) + ')';
        });
        video.addEventListener('play', function () { paintTools(it); });
        video.addEventListener('pause', function () { paintTools(it); });
        video.addEventListener('ended', function () {
          if (front === i && o.autoAdvance) step(1);
        });
        // a broken file: keep the poster, drop the buttons that would do nothing
        video.addEventListener('error', function () { if (tools) tools.hidden = true; });
        paintTools(it);
      } else {
        bar.addEventListener('animationend', function () {
          if (front === i && o.autoAdvance && !calm) step(1);
        });
      }
      return it;
    }

    function paintTools(it) {
      if (!it.video) return;
      var playing = !it.video.paused;
      it.playBtn.setAttribute('aria-label', playing ? 'pause this reel' : 'play this reel');
      it.playBtn.textContent = '';
      it.playBtn.appendChild(icon(playing ? ICON.pause : ICON.play));
      it.soundBtn.setAttribute('aria-label', muted ? 'turn the sound on' : 'turn the sound off');
      it.soundBtn.textContent = '';
      it.soundBtn.appendChild(icon(muted ? ICON.soundOff : ICON.soundOn));
    }

    /* ---------- sizing ---------- */

    function measure() {
      var sw = stage.clientWidth || rootEl.clientWidth || 360;
      W = Math.round(Math.max(160, Math.min(260, sw * 0.25)));
      spread = o.spread * (sw < PHONE_WIDTH ? PHONE_SPREAD : 1);
      Rx = reach(N, W, spread);
      rootEl.style.setProperty('--reel-door-w', W + 'px');
      render();
    }

    /* ---------- drawing one frame ---------- */

    var shape = {};
    function render() {
      shape.depth = o.depth; shape.lift = o.lift; shape.arc = o.arc; shape.perspective = o.perspective;
      // reduced motion: no swing, pop or outward slide while passing
      shape.pop = calm ? 0 : o.pop; shape.clearance = calm ? 0 : o.clearance; shape.swing = calm ? 0 : o.swing;
      for (var i = 0; i < N; i++) {
        var p = place(i, N, angle, Rx, shape);
        var st = items[i].node.style;
        st.transform = 'translate(' + p.x.toFixed(2) + 'px,' + p.y.toFixed(2) + 'px) scale(' + p.scale.toFixed(4) +
          ') perspective(900px) rotateY(' + p.rotY.toFixed(2) + 'deg)';
        st.zIndex = p.zIndex;
        items[i].haze.style.opacity = p.haze.toFixed(3);
      }
      var f = mod(Math.round(angle / s), N);
      if (f !== front) setFront(f);
    }

    // who is at the front changed: only they are heard by screen readers, reachable by tab, and shown a bar
    function setFront(f) {
      var old = front;
      front = f;
      items.forEach(function (it, i) {
        var isFront = i === f;
        it.node.classList.toggle('is-front', isFront);
        if (isFront) it.node.removeAttribute('aria-hidden'); else it.node.setAttribute('aria-hidden', 'true');
        it.focusables.forEach(function (n) { n.tabIndex = isFront ? 0 : -1; });
        if (it.video) {
          var near = Math.abs(mod(i - f + N / 2, N) - N / 2) === 1;
          it.video.preload = isFront || near ? 'metadata' : 'none';
        }
      });
      dots.forEach(function (b, i) {
        if (i === f) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      });
      if (old >= 0) leaveFront(items[old]);
    }

    function leaveFront(it) {
      it.node.classList.remove('is-running');
      it.bar.style.transform = '';
      if (it.video) {
        it.video.pause();
        try { it.video.currentTime = 0; } catch (e) {}
      }
    }

    // the ring came to rest: the front reel starts its video, or its bar for a still
    function onSettle() {
      var it = items[front];
      if (!it || !inView) return;
      if (it.video) { playFront(false); return; }
      if (calm) return;
      if (!it.node.classList.contains('is-running')) {
        it.node.classList.remove('is-running');
        void it.bar.offsetWidth;       // restart the bar's animation from empty
        it.node.classList.add('is-running');
      }
    }

    function playFront(byHand) {
      var it = items[front];
      if (!it || !it.video) return;
      if (!byHand && (calm || held)) return;     // reduced motion: nothing starts on its own
      it.video.muted = muted;
      var p = it.video.play();
      if (p && p.catch) p.catch(function () { paintTools(it); });
    }

    /* ---------- the loop: runs only while moving ---------- */

    function kick() {
      settled = false;
      if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
    }

    var K = 120, C = 2 * 0.92 * Math.sqrt(K);   // a slightly under-damped spring
    function tick(now) {
      raf = 0;
      var dt = last ? Math.min(0.034, (now - last) / 1000) : 1 / 60;
      last = now;
      if (!drag || !drag.moving) {
        var steps = 4, h = dt / steps;
        for (var k = 0; k < steps; k++) {
          velocity += (-K * (angle - target) - C * velocity) * h;
          angle += velocity * h;
        }
        if (Math.abs(angle - target) < 0.03 && Math.abs(velocity) < 0.4) {
          angle = target;
          velocity = 0;
          settled = true;
        }
      }
      render();
      if (drag && drag.moving) return;          // the pointer drives each frame while dragging
      if (!settled) raf = requestAnimationFrame(tick);
      else onSettle();
    }

    function setTarget(t) {
      target = t;
      var f = mod(Math.round(target / s), N);
      if (f !== announced) {
        announced = f;
        counter.textContent = 'reel ' + (f + 1) + ' of ' + N;
      }
      if (calm) {
        // reduced motion: jump straight there
        angle = target;
        velocity = 0;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        render();
        settled = true;
        onSettle();
        return;
      }
      kick();
    }

    // arrows and keys move the target, not the current angle, so quick presses queue up
    function step(dir) { setTarget(Math.round(target / s) * s + dir * s); }

    // bring reel i to the front the short way round
    function goTo(i) {
      var base = Math.round(target / s) * s;
      setTarget(base + (mod(i * s - base + 180, 360) - 180));
    }

    /* ---------- dragging ---------- */

    stage.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || (drag && drag.moving)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, startAngle: angle, moving: false, samples: [] };
    });

    stage.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moving) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }   // a scroll, not a drag
        if (Math.abs(dx) <= 4) return;
        drag.moving = true;
        drag.x = e.clientX;                      // start tracking from here, so the reel doesn't jump 4 px
        drag.startAngle = angle;
        dx = 0;
        velocity = 0;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        try { stage.setPointerCapture(e.pointerId); } catch (err) {}
        stage.classList.add('is-dragging');
      }
      angle = drag.startAngle - dx * (180 / Math.PI) / Rx * 1.1;
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
      if (!d.moving) return;                     // a tap: the click handler below deals with it
      stage.classList.remove('is-dragging');
      try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
      swallowClick = true;
      setTimeout(function () { swallowClick = false; }, 0);
      // the pointer's speed over its last 100 ms, or none if it rested more than 90 ms before letting go
      var v = 0, now = performance.now(), sm = d.samples;
      if (!cancelled && sm.length > 1 && now - sm[sm.length - 1].t <= 90) {
        var a = sm[0], b = sm[sm.length - 1];
        if (b.t > a.t) v = (b.a - a.a) / (b.t - a.t) * 1000;
      }
      velocity = calm ? 0 : v;
      setTarget(settleAngle(angle, v, s));
    }
    stage.addEventListener('pointerup', function (e) { release(e, false); });
    stage.addEventListener('pointercancel', function (e) { release(e, true); });
    stage.addEventListener('lostpointercapture', function (e) { if (drag && drag.moving) release(e, true); });

    // a drag that ends over a link or button must not also click it. a tap on a reel that isn't at the front
    // (even on its link) brings it forward; on the front reel, its own links and buttons work as usual
    stage.addEventListener('click', function (e) {
      if (swallowClick) { e.preventDefault(); e.stopPropagation(); swallowClick = false; return; }
      var reel = e.target && e.target.closest ? e.target.closest('.reel-door__reel') : null;
      if (!reel) return;
      var i = Number(reel.getAttribute('data-index'));
      if (i === front && mod(Math.round(target / s), N) === i) return;
      e.preventDefault();
      e.stopPropagation();
      goTo(i);
    }, true);
    stage.addEventListener('dragstart', function (e) { e.preventDefault(); });

    // keys: bound on the stage only, never on the window
    stage.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    });

    /* ---------- the world around it ---------- */

    function onMotionChange() {
      calm = !!(motion && motion.matches);
      if (calm) {
        velocity = 0;
        angle = target;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        items.forEach(function (it) { it.node.classList.remove('is-running'); if (it.video) it.video.pause(); });
        render();
      }
    }
    if (motion) {
      if (motion.addEventListener) motion.addEventListener('change', onMotionChange);
      else if (motion.addListener) motion.addListener(onMotionChange);
    }

    var ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(measure); ro.observe(stage); }
    else window.addEventListener('resize', measure);

    // scrolled out of sight: pause, and pick up again on the way back
    var io = null;
    if (window.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        inView = entries[entries.length - 1].isIntersecting;
        rootEl.classList.toggle('is-away', !inView);
        var it = items[front];
        if (!it) return;
        if (!inView) { if (it.video) it.video.pause(); }
        else if (settled) onSettle();
      }, { threshold: 0.25 });
      io.observe(stage);
    }

    measure();
    setTarget(0);

    return {
      next: function () { step(1); },
      prev: function () { step(-1); },
      goTo: goTo,
      destroy: function () {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (ro) ro.disconnect(); else window.removeEventListener('resize', measure);
        if (io) io.disconnect();
        if (motion) {
          if (motion.removeEventListener) motion.removeEventListener('change', onMotionChange);
          else if (motion.removeListener) motion.removeListener(onMotionChange);
        }
        items.forEach(function (it) { if (it.video) { it.video.pause(); it.video.removeAttribute('src'); it.video.load(); } });
        rootEl.textContent = '';
      }
    };
  }

  /* ---------- start every [data-reel-door] on the page ---------- */

  function optionsFrom(node) {
    var opts = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var attr = 'data-' + k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
      var v = node.getAttribute(attr);
      if (v === null) return;
      opts[k] = k === 'autoAdvance' ? v !== 'false' : Number(v);
    });
    return opts;
  }

  function start() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-reel-door]'), function (node) {
      var opts = optionsFrom(node);
      var src = node.getAttribute('data-reels-src');
      if (!src) { opts.reels = PLACEHOLDER_REELS; mount(node, opts); return; }
      // real reels: if they can't be had, hide the whole section rather than show stand-ins
      var section = node.closest('section') || node;
      fetch(src).then(function (r) {
        if (!r.ok) throw new Error('reels ' + r.status);
        return r.json();
      }).then(function (j) {
        opts.reels = Array.isArray(j) ? j : (j && j.reels) || [];
        if (!mount(node, opts)) section.hidden = true;
      }).catch(function () { section.hidden = true; });
    });
  }

  root.ReelDoor = { mount: mount, place: place, reach: reach, settleAngle: settleAngle, DEFAULTS: DEFAULTS, PLACEHOLDER_REELS: PLACEHOLDER_REELS };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
