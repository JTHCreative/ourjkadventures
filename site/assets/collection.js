/* j+k adventures: the pin board on "my collection" (collection.html). Every pin someone has registered shows up
   here. New ones wait in a tray under the board; a tap puts one up, and from there it can be dragged around, turned
   with the little round handle (or the buttons, or the keyboard), and taken back down.

   Where a pin sits is kept as a share of the board, not in pixels: x and y are its middle, from 0 (left, top) to 1
   (right, bottom). Like saying "a third of the way across" instead of "four inches from the edge", so the board
   looks the same on a phone as on a desk. account.js signs the person in and hands this file their pins and a way
   to save; nothing here talks to the server by itself. */

const EDGE = 0.05;            // a pin's middle stays this far inside the board, so it can always be grabbed
const WIDTH = { standard: 17, large: 21 };   // a pin's width, as a percent of the board's
const TURN_STEP = 15;         // degrees per press of a turn button or key
const SAVE_AFTER = 700;       // a breath after the last move, then save
const RETRY_AFTER = 8000;
const Z_TIDY = 5000;

export function inside(v) { return Math.round(Math.min(1 - EDGE, Math.max(EDGE, v)) * 10000) / 10000; }
// a turn kept between -180 and 180, and settled dead straight when it's nearly straight
export function tidyTurn(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(d) < 4) d = 0;
  return Math.round(d * 10) / 10;
}
// where the nth pin from the tray lands: across in fours, then down
export function landing(n) { return { x: 0.2 + (n % 4) * 0.2, y: 0.2 + (Math.floor(n / 4) % 4) * 0.2 }; }

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function pinWords(p) { return (p.size && p.size !== 'standard' ? p.size + ' ' : '') + p.name + ' pin'; }
function picture(p) {
  const img = el('img');
  img.src = 'assets/img/pins/' + p.slug + '.webp';
  img.alt = '';
  img.draggable = false;
  return img;
}

// o: { board, tools, toolsName, trayWrap, tray, empty, status, pins, save(list) -> true when saved }
export function mountBoard(o) {
  const board = o.board;
  let pins = [];
  let picked = null;
  const buttons = new Map();
  const dirty = new Set();
  let timer = null;
  let saving = false;
  let failures = 0;

  const handle = el('span', 'cb-turn');
  handle.setAttribute('aria-hidden', 'true');
  handle.hidden = true;

  const onBoard = () => pins.filter((p) => p.on);
  const top = () => pins.reduce((m, p) => (p.on ? Math.max(m, p.z) : m), 0);
  const say = (text) => { o.status.textContent = text; };

  /* ---------- saving ---------- */
  function changed(p) {
    dirty.add(p.id);
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_AFTER);
  }
  async function flush() {
    clearTimeout(timer);
    if (saving || !dirty.size) return;
    saving = true;
    const ids = [...dirty];
    dirty.clear();
    say('saving.');
    const list = ids.map((id) => pins.find((p) => p.id === id)).filter(Boolean)
      .map((p) => (p.on ? { id: p.id, x: p.x, y: p.y, r: p.r, z: p.z } : { id: p.id, off: true }));
    let ok = false;
    try { ok = await o.save(list); } catch (e) {}
    saving = false;
    if (ok) {
      failures = 0;
      if (dirty.size) timer = setTimeout(flush, SAVE_AFTER); else say('saved.');
      return;
    }
    ids.forEach((id) => dirty.add(id));
    failures += 1;
    say('we couldn\'t save your board just now. ' + (failures < 4 ? 'we\'ll try again in a moment.' : 'move a pin to try again.'));
    if (failures < 4) timer = setTimeout(flush, RETRY_AFTER);
  }
  // leaving the page with a move not saved yet: send it now
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });

  /* ---------- drawing ---------- */
  function draw(p) {
    const b = buttons.get(p.id);
    if (!b) return;
    b.style.left = (p.x * 100) + '%';
    b.style.top = (p.y * 100) + '%';
    b.style.zIndex = String(p.z);
    b.style.transform = 'translate(-50%, -50%) rotate(' + p.r + 'deg)';
    if (picked === p) drawHandle();
  }
  // the handle floats just past the pin's top, wherever "top" points after turning
  function drawHandle() {
    if (!picked || !picked.on) { handle.hidden = true; return; }
    const b = buttons.get(picked.id);
    const reach = b.offsetWidth / 2 + 22;
    const turn = picked.r * Math.PI / 180;
    handle.style.left = (picked.x * board.clientWidth + Math.sin(turn) * reach) + 'px';
    handle.style.top = (picked.y * board.clientHeight - Math.cos(turn) * reach) + 'px';
    handle.hidden = false;
  }
  function pick(p) {
    if (picked === p) return;
    if (picked && buttons.get(picked.id)) buttons.get(picked.id).classList.remove('is-picked');
    picked = p && p.on ? p : null;
    o.tools.hidden = !picked;
    if (!picked) { handle.hidden = true; return; }
    buttons.get(picked.id).classList.add('is-picked');
    o.toolsName.textContent = pinWords(picked);
    drawHandle();
  }
  function toFront(p) {
    if (p.z === top() && onBoard().filter((q) => q.z === p.z).length === 1) return;
    p.z = top() + 1;
    // the numbers only ever go up, so now and then they're dealt out again from 1
    if (p.z > Z_TIDY) onBoard().sort((a, b) => a.z - b.z).forEach((q, i) => { q.z = i + 1; draw(q); changed(q); });
    draw(p);
    changed(p);
  }
  function move(p, x, y) { p.x = inside(x); p.y = inside(y); draw(p); }
  function turn(p, deg) { p.r = tidyTurn(deg); draw(p); }

  function boardPin(p) {
    const b = el('button', 'cb-pin');
    b.type = 'button';
    b.style.width = (WIDTH[p.size] || WIDTH.standard) + '%';
    b.setAttribute('aria-label', pinWords(p) + '. arrow keys move it, [ and ] turn it.');
    b.appendChild(picture(p));
    let drag = null;
    b.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      pick(p);
      toFront(p);
      const box = board.getBoundingClientRect();
      drag = { dx: e.clientX - (box.left + p.x * box.width), dy: e.clientY - (box.top + p.y * box.height), moved: false };
      try { b.setPointerCapture(e.pointerId); } catch (err) {}
    });
    b.addEventListener('pointermove', function (e) {
      if (!drag) return;
      const box = board.getBoundingClientRect();
      move(p, (e.clientX - drag.dx - box.left) / box.width, (e.clientY - drag.dy - box.top) / box.height);
      drag.moved = true;
    });
    const drop = function () { if (drag && drag.moved) changed(p); drag = null; };
    b.addEventListener('pointerup', drop);
    b.addEventListener('pointercancel', drop);
    b.addEventListener('focus', function () { pick(p); });
    b.addEventListener('keydown', function (e) {
      const step = e.shiftKey ? 0.05 : 0.01;
      if (e.key === 'ArrowLeft') move(p, p.x - step, p.y);
      else if (e.key === 'ArrowRight') move(p, p.x + step, p.y);
      else if (e.key === 'ArrowUp') move(p, p.x, p.y - step);
      else if (e.key === 'ArrowDown') move(p, p.x, p.y + step);
      else if (e.key === '[') turn(p, p.r - TURN_STEP);
      else if (e.key === ']') turn(p, p.r + TURN_STEP);
      else return;
      e.preventDefault();
      changed(p);
    });
    return b;
  }

  function trayPin(p) {
    const li = el('li');
    const b = el('button', 'cb-tray-pin');
    b.type = 'button';
    b.setAttribute('aria-label', 'put the ' + pinWords(p) + ' on the board');
    b.appendChild(picture(p));
    b.appendChild(el('span', null, pinWords(p)));
    b.addEventListener('click', function () {
      const spot = landing(onBoard().length);
      p.on = true;
      p.x = spot.x;
      p.y = spot.y;
      p.r = 0;
      p.z = top() + 1;
      changed(p);
      render();
      pick(p);
      buttons.get(p.id).focus();
    });
    li.appendChild(b);
    return li;
  }

  function render() {
    const was = picked;
    picked = null;
    board.textContent = '';
    buttons.clear();
    o.tray.textContent = '';
    pins.forEach(function (p) {
      if (p.on) { const b = boardPin(p); buttons.set(p.id, b); board.appendChild(b); draw(p); }
      else o.tray.appendChild(trayPin(p));
    });
    board.appendChild(handle);
    handle.hidden = true;
    o.tools.hidden = true;
    o.trayWrap.hidden = !pins.some((p) => !p.on);
    o.empty.hidden = pins.length > 0;
    if (was && was.on && pins.includes(was)) pick(was);
  }

  /* ---------- the turn handle ---------- */
  let turning = false;
  handle.addEventListener('pointerdown', function (e) {
    if (!picked) return;
    turning = true;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
  });
  handle.addEventListener('pointermove', function (e) {
    if (!turning || !picked) return;
    const box = board.getBoundingClientRect();
    const dx = e.clientX - (box.left + picked.x * box.width);
    const dy = e.clientY - (box.top + picked.y * box.height);
    turn(picked, Math.atan2(dx, -dy) * 180 / Math.PI);
  });
  const letGo = function () { if (turning && picked) changed(picked); turning = false; };
  handle.addEventListener('pointerup', letGo);
  handle.addEventListener('pointercancel', letGo);

  /* ---------- the buttons under the board ---------- */
  o.tools.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-board-do]');
    if (!btn || !picked) return;
    const p = picked;
    const what = btn.getAttribute('data-board-do');
    if (what === 'left') turn(p, p.r - TURN_STEP);
    else if (what === 'right') turn(p, p.r + TURN_STEP);
    else if (what === 'straight') turn(p, 0);
    else if (what === 'front') { toFront(p); return; }
    else if (what === 'off') {
      p.on = false;
      changed(p);
      render();
      const back = o.tray.querySelector('button');
      if (back) back.focus();
      return;
    }
    changed(p);
  });
  // a tap on the bare board lets go of the pin
  board.addEventListener('pointerdown', function (e) { if (e.target === board) pick(null); });
  if (window.ResizeObserver) new ResizeObserver(drawHandle).observe(board);

  function setPins(list) {
    // pins already here keep the place they have on screen (a move may not be saved yet); new ones are added
    const have = new Map(pins.map((p) => [p.id, p]));
    pins = list.map((p) => have.get(p.id) || Object.assign({}, p));
    render();
  }
  setPins(o.pins || []);
  return { setPins: setPins, flush: flush };
}
