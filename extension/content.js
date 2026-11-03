// Counts vertical scroll distance (px) that the user caused, and flushes it to the background script.
//
// How it works: scroll events do not cross shadow-DOM boundaries and some apps replace their scroll
// containers, so listening for them misses apps like Gmail and AI chats. Instead, when the user
// does something that scrolls (wheel, touch, keys, scrollbar drag), we find the scrollable elements
// under the pointer or focus, then read their scroll position every animation frame for a short while.
(() => {
  const INPUT_WINDOW_MS = 2000; // movement counts if the user did something this recently
  const SCAN_EVERY_MS = 100; // how often a stream of wheel events re-scans for scrollers
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  const WINDOW = "window"; // key for the page's own scroll position
  const opts = { capture: true, passive: true };

  const watched = new Map(); // scrollable element (or WINDOW) -> last seen scrollTop
  let accumulated = 0;
  let lastInput = 0;
  let lastScan = 0;
  let dragging = false; // mouse button held (scrollbar drag, middle-click autoscroll)
  let touched = false; // a touch gesture actually moved
  let rafId = 0;
  let dead = false; // set when this script was orphaned by an extension reload
  let pointerTarget = null; // last element under the mouse, used for keyboard scrolling

  // Settings from the popup: pause everywhere, or skip chosen sites.
  let paused = false;
  let blocked = [];
  let disabled = false;

  // Embedded frames follow the rules of the page they are embedded in.
  const host = (() => {
    try {
      const o = location.ancestorOrigins;
      if (o && o.length) return new URL(o[o.length - 1]).hostname.replace(/^www\./, "");
    } catch (e) {}
    return location.hostname.replace(/^www\./, "");
  })();

  const recompute = () => {
    disabled = paused || blocked.some((b) => host === b || host.endsWith("." + b));
  };

  try {
    chrome.storage.sync.get(["paused", "blocked"]).then((s) => {
      paused = !!s.paused;
      blocked = Array.isArray(s.blocked) ? s.blocked : [];
      recompute();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.paused) paused = !!changes.paused.newValue;
      if (changes.blocked) blocked = Array.isArray(changes.blocked.newValue) ? changes.blocked.newValue : [];
      recompute();
    });
  } catch (e) {}

  // ---------- finding scrollable elements ----------
  // Walks from a node up to the root, crossing shadow-DOM boundaries and slots.
  function* chain(start) {
    let n = start;
    while (n) {
      if (n.nodeType === 1) yield n;
      n = n.assignedSlot || (n instanceof ShadowRoot ? n.host : n.parentNode);
    }
  }

  function isScroller(el) {
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll" || oy === "overlay";
  }

  const positionOf = (el) => (el === WINDOW ? window.scrollY : el.scrollTop);

  // Chrome can scroll before the input handler runs, so the position at input time may already
  // include the first movement. Scroll events keep a fresh record of where every container was,
  // whatever caused the move, so a count starts from the right place.
  const known = new WeakMap();
  let knownWindowY = window.scrollY;
  const hookedRoots = new WeakSet();

  const onAnyScroll = (e) => {
    const t = e.target;
    if (t === document || t === document.documentElement || t === document.body) {
      if (!watched.has(WINDOW)) knownWindowY = window.scrollY;
    } else if (t instanceof Element && !watched.has(t)) {
      known.set(t, t.scrollTop);
    }
  };
  document.addEventListener("scroll", onAnyScroll, opts);

  // When the pointer or a finger arrives on a scroller, note where it is before any scrolling starts.
  let lastPrescan = 0;
  function prescan(start) {
    const now = Date.now();
    if (!start || now - lastPrescan < SCAN_EVERY_MS) return;
    lastPrescan = now;
    for (const el of chain(start)) {
      if (el === document.documentElement || el === document.body) continue;
      if (!watched.has(el) && isScroller(el)) known.set(el, el.scrollTop);
    }
  }

  // Scroll events do not leave a shadow root, so listen inside the ones we meet on the way.
  function hookShadowRoots(path) {
    for (const n of path) {
      if (n instanceof ShadowRoot && !hookedRoots.has(n)) {
        hookedRoots.add(n);
        n.addEventListener("scroll", onAnyScroll, opts);
      }
    }
  }

  function watchFrom(start) {
    if (!watched.has(WINDOW)) watched.set(WINDOW, knownWindowY);
    if (!start) return;
    for (const el of chain(start)) {
      if (el === document.documentElement || el === document.body) continue; // covered by WINDOW
      if (!watched.has(el) && isScroller(el)) watched.set(el, known.has(el) ? known.get(el) : el.scrollTop);
    }
  }

  const pathStart = (e) => {
    const p = e.composedPath ? e.composedPath() : [];
    return p.length ? p[0] : e.target;
  };

  // Called for every user input that can scroll. Scans for scrollers at most every SCAN_EVERY_MS.
  function onInput(starts, path) {
    const now = Date.now();
    lastInput = now;
    if (path) hookShadowRoots(path);
    if (now - lastScan >= SCAN_EVERY_MS || watched.size === 0) {
      lastScan = now;
      for (const s of starts) watchFrom(s instanceof Node ? s : null);
    }
    kick();
  }

  // ---------- measuring movement ----------
  function frame() {
    rafId = 0;
    if (dead) return;
    const now = Date.now();
    const active = dragging || now - lastInput < INPUT_WINDOW_MS;
    for (const [el, last] of watched) {
      if (el !== WINDOW && !el.isConnected) { watched.delete(el); continue; }
      const y = positionOf(el);
      if (y !== last) {
        if (active && !disabled) accumulated += Math.abs(y - last);
        watched.set(el, y);
      }
    }
    if (!active && now - lastInput > INPUT_WINDOW_MS + 1000) { // idle: remember positions, stop polling
      for (const [el, y] of watched) {
        if (el === WINDOW) knownWindowY = y;
        else known.set(el, y);
      }
      watched.clear();
    }
    if (watched.size) rafId = requestAnimationFrame(frame);
  }

  function kick() {
    if (!rafId && !dead) rafId = requestAnimationFrame(frame);
  }

  // ---------- user input ----------
  const isEditable = (e) => {
    const t = pathStart(e);
    return t instanceof Element && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  };

  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };

  window.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) onInput([pathStart(e)], e.composedPath()); // ctrl+wheel is zoom
  }, opts);
  window.addEventListener("touchstart", (e) => prescan(pathStart(e)), opts);
  window.addEventListener("touchmove", (e) => { touched = true; onInput([pathStart(e)], e.composedPath()); }, opts);
  window.addEventListener("touchend", () => {
    if (touched) { touched = false; lastInput = Date.now(); } // momentum after a swipe
  }, opts);
  window.addEventListener("keydown", (e) => {
    if (!SCROLL_KEYS.has(e.key) || isEditable(e)) return; // typing a space in a chat box is not scrolling
    onInput([deepActive(), pointerTarget]);
  }, opts);
  window.addEventListener("mouseover", (e) => {
    pointerTarget = pathStart(e);
    hookShadowRoots(e.composedPath());
    prescan(pointerTarget);
  }, opts);

  // Holding a mouse button (scrollbar drag, middle-click autoscroll) counts as input until release.
  window.addEventListener("mousedown", (e) => {
    dragging = true;
    onInput([pathStart(e)], e.composedPath());
  }, opts);
  const release = () => { dragging = false; };
  window.addEventListener("mouseup", release, opts);
  window.addEventListener("blur", release, opts);

  // ---------- reporting ----------
  const flush = () => {
    if (dead || accumulated <= 0) return;
    const px = accumulated;
    accumulated = 0;
    try {
      chrome.runtime.sendMessage({ type: "SCROLL_DELTA", px });
    } catch (e) {
      // The extension was reloaded or updated, so this copy of the script is orphaned. Stop quietly.
      dead = true;
      clearInterval(interval);
    }
  };

  const interval = setInterval(flush, 250);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("beforeunload", flush);
})();
