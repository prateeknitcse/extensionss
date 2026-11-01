// Tracks vertical scroll distance (px) on this page and flushes to background.
// Scroll events don't bubble, but they can be captured at the document, so this also
// counts sites that scroll inside inner panels (feeds, chat lists, web apps) and not just the window.
(() => {
  const lastPos = new WeakMap(); // scrolled element -> last scrollTop
  let lastWindowY = window.scrollY;
  let accumulated = 0;

  const onScroll = (e) => {
    const t = e.target;

    // Whole-page scroll: the event target is the document.
    if (t === document || t === document.documentElement || t === document.body) {
      const y = window.scrollY;
      accumulated += Math.abs(y - lastWindowY);
      lastWindowY = y;
      return;
    }

    // Inner scrollable element.
    if (!(t instanceof Element)) return;
    const y = t.scrollTop;
    const prev = lastPos.get(t);
    lastPos.set(t, y);
    if (prev !== undefined) accumulated += Math.abs(y - prev);
  };

  document.addEventListener("scroll", onScroll, { capture: true, passive: true });

  const flush = () => {
    if (accumulated <= 0) return;
    const px = accumulated;
    accumulated = 0;
    try {
      chrome.runtime.sendMessage({ type: "SCROLL_DELTA", px });
    } catch (e) {
      // Extension was reloaded; this old content script is orphaned. Refresh the tab.
    }
  };

  setInterval(flush, 250);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("beforeunload", flush);
})();
