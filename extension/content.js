// Counts vertical scroll distance (px) on this page that the user caused, and flushes it to the
// background script. Scroll events don't bubble, but they can be captured at the document, so
// this also counts sites that scroll inside inner panels and not just the window.
(() => {
  const INPUT_WINDOW_MS = 2000; // a scroll counts if the user did something (wheel, key, drag) this recently
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

  const lastPos = new WeakMap(); // scrolled element -> last scrollTop
  let lastWindowY = window.scrollY;
  let accumulated = 0;
  let lastInput = 0;
  let dragging = false; // mouse button held on a scrollbar
  let dead = false; // set when this script was orphaned by an extension reload

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

  // Only scrolling the user caused counts. Scripts that scroll by themselves (carousels, "scroll to
  // top" after navigating, pages that restore a position) don't produce any of these inputs.
  const markInput = () => {
    lastInput = Date.now();
  };
  const opts = { capture: true, passive: true };
  window.addEventListener("wheel", markInput, opts);
  window.addEventListener("touchmove", markInput, opts);
  window.addEventListener("touchend", markInput, opts); // momentum after a swipe
  window.addEventListener("keydown", (e) => { if (SCROLL_KEYS.has(e.key)) markInput(); }, opts);

  const onScrollbar = (e) => {
    const de = document.documentElement;
    if (e.clientX >= de.clientWidth) return true; // page scrollbar
    const t = e.target;
    return t instanceof Element && t.clientWidth > 0 && t.offsetWidth > t.clientWidth && e.offsetX >= t.clientWidth;
  };
  window.addEventListener("mousedown", (e) => {
    if (e.button === 1 || onScrollbar(e)) { // middle-click autoscroll or scrollbar drag
      dragging = true;
      markInput();
    }
  }, opts);
  const release = () => {
    if (dragging) markInput();
    dragging = false;
  };
  window.addEventListener("mouseup", release, opts);
  window.addEventListener("blur", release, opts);

  const counting = () => !disabled && (dragging || Date.now() - lastInput < INPUT_WINDOW_MS);

  const onScroll = (e) => {
    if (dead) return;
    const t = e.target;
    const count = counting();

    // Whole-page scroll: the event target is the document.
    if (t === document || t === document.documentElement || t === document.body) {
      const y = window.scrollY;
      if (count) accumulated += Math.abs(y - lastWindowY);
      lastWindowY = y;
      return;
    }

    // Inner scrollable element. The first event only records where it started.
    if (!(t instanceof Element)) return;
    const y = t.scrollTop;
    const prev = lastPos.get(t);
    lastPos.set(t, y);
    if (count && prev !== undefined) accumulated += Math.abs(y - prev);
  };

  document.addEventListener("scroll", onScroll, { capture: true, passive: true });

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
