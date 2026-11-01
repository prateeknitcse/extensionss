// Tracks scroll distance (px) on this page and flushes to background periodically.
(() => {
  let lastY = window.scrollY;
  let accumulated = 0;

  const onScroll = () => {
    const y = window.scrollY;
    accumulated += Math.abs(y - lastY);
    lastY = y;
  };

  window.addEventListener("scroll", onScroll, { passive: true });

  const flush = () => {
    if (accumulated > 0) {
      chrome.runtime.sendMessage({ type: "SCROLL_DELTA", px: accumulated });
      accumulated = 0;
    }
  };

  setInterval(flush, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("beforeunload", flush);
})();
