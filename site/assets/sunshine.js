/* j+k adventures: the "little sunshines" photo band on the home page (index.html, data-sunshine).
   Two things:
   - parallax: as the page scrolls, the photo drifts a little slower than everything else, like far-off hills out of a
     car window. Worked out once per screen frame, only while the band is on screen. Off under "reduce motion".
   - the arrows: slide to the previous or next photo (wrapping round), also by swiping on a phone. They only show
     once the band has two or more photos. */
(function () {
  var band = document.querySelector('[data-sunshine] .sun-band');
  if (!band) return;
  var slides = Array.prototype.slice.call(band.querySelectorAll('.sun-slide'));
  var prev = band.querySelector('[data-sun-prev]');
  var next = band.querySelector('[data-sun-next]');
  var said = band.querySelector('[data-sun-said]');
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- parallax ---------- */
  // the layer is 128% of the band's height, so it can move up to 14% of the band either way without an edge showing
  var RANGE = 0.12;
  var queued = false, showing = true;
  function paint() {
    queued = false;
    if (!showing) return;
    var r = band.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    // -1 when the band's middle is at the bottom of the window, 0 in the middle, 1 at the top
    var p = Math.max(-1, Math.min(1, ((vh / 2) - (r.top + r.height / 2)) / ((vh + r.height) / 2)));
    var shift = (p * RANGE * r.height).toFixed(1) + 'px';
    slides.forEach(function (s) { s.querySelector('.sun-layer').style.setProperty('--sun-shift', shift); });
  }
  function queue() { if (!queued) { queued = true; requestAnimationFrame(paint); } }
  if (!calm) {
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (es) { showing = es[0].isIntersecting; if (showing) queue(); }).observe(band);
    }
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    queue();
  }

  /* ---------- sliding between photos ---------- */
  if (slides.length < 2) return;
  // the hidden photos would only start loading once they slide in (a blank moment), so fetch them as soon as the
  // band comes near the screen, ready and waiting backstage
  function readyAll() { slides.forEach(function (s) { var img = s.querySelector('img'); if (img) img.loading = 'eager'; }); }
  if (window.IntersectionObserver) {
    var ready = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { readyAll(); ready.disconnect(); } }, { rootMargin: '400px 0px' });
    ready.observe(band);
  } else readyAll();
  prev.hidden = false;
  next.hidden = false;
  var at = 0, busy = false;
  slides.forEach(function (s, i) { s.setAttribute('aria-label', (i + 1) + ' of ' + slides.length); if (i) s.setAttribute('aria-hidden', 'true'); });
  function go(step) {
    if (busy) return;
    var from = slides[at];
    at = (at + step + slides.length) % slides.length;
    var to = slides[at];
    // the new photo starts just off the side it comes in from, then both slide across together
    to.classList.add('is-moving');
    to.style.transition = 'none';
    to.classList.toggle('is-before', step < 0);
    void to.offsetWidth;
    to.style.transition = '';
    from.classList.add('is-moving');
    from.classList.remove('is-on');
    from.classList.toggle('is-before', step > 0);
    to.classList.remove('is-before');
    to.classList.add('is-on');
    from.setAttribute('aria-hidden', 'true');
    to.removeAttribute('aria-hidden');
    said.textContent = 'photo ' + (at + 1) + ' of ' + slides.length + '.';
    queue();
    if (calm) { from.classList.remove('is-moving'); return; }
    busy = true;
    setTimeout(function () { busy = false; from.classList.remove('is-moving'); to.classList.remove('is-moving'); }, 720);
  }
  prev.addEventListener('click', function () { go(-1); });
  next.addEventListener('click', function () { go(1); });
  band.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  });
  // a sideways swipe on a phone; an up-and-down one still scrolls the page
  var sx = null, sy = 0;
  band.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  band.addEventListener('touchend', function (e) {
    if (sx === null) return;
    var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  }, { passive: true });
})();
