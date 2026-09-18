(() => {
  const viewRoutes = new Map([
    ["/", "home"],
    ["/home/", "home"],
    ["/servers/", "servers"],
    ["/community/", "community"],
    ["/sponsored/", "sponsored"],
    ["/sponsored-clients/", "sponsored-clients"],
    ["/sponsored-hosts/", "sponsored-hosts"],
    ["/sponsored/plans/", "plans"],
    ["/tools/votifier-tester/", "votifier-tester"],
    ["/tools/motd-builder/", "motd-builder"],
    ["/tools/rgb-text-generator/", "rgb-text-generator"],
    ["/tools/fonts-generator/", "fonts-generator"],
    ["/login/", "login"],
    ["/dashboard/", "dashboard"],
    ["/admin/", "admin"],
    ["/help/", "help"],
    ["/contact/", "contact"],
    ["/privacy/", "privacy"],
    ["/terms/", "terms"]
  ]);
  const requestedView = new URLSearchParams(location.search).get("view") || "home";
  const validViews = new Set(viewRoutes.values());
  document.body.dataset.page = validViews.has(requestedView) ? requestedView : "home";

  const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let navigating = false;

  function transitionMarkup() {
    const overlay = document.createElement("div");
    overlay.className = "incoming-transition";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `<div class="incoming-curtain incoming-curtain-left"></div>
      <div class="incoming-curtain incoming-curtain-right"></div>
      <div class="incoming-identity">
        <strong class="incoming-wordmark"><span>Icon</span><span>Listing</span></strong>
        <span class="incoming-copy">
          <span class="incoming-tagline">Built to help servers grow</span>
          <span class="incoming-credit">Brought to you by <strong>IconRealms</strong></span>
        </span>
      </div>`;
    return overlay;
  }

  function playIntroAudio() {
    const startedAt = Date.now();
    const audio = new Audio("/assets/audio/intro.mp3");
    audio.preload = "auto";
    audio.volume = 0.32;
    audio.playsInline = true;
    let playing = false;

    const start = () => {
      if (playing || Date.now() - startedAt >= 5000) return;
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      try {
        const duration = Number.isFinite(audio.duration) ? audio.duration : 30;
        audio.currentTime = Math.min(elapsedSeconds, Math.max(0, duration - .1));
      } catch {}
      let attempt;
      try { attempt = audio.play(); } catch { return; }
      if (attempt?.then) attempt.then(() => { playing = true; }).catch(() => {});
    };
    start();
    document.addEventListener("pointerdown", start, { once: true, capture: true });
    document.addEventListener("keydown", start, { once: true, capture: true });

    const fade = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 4200) return;
      audio.volume = Math.max(0, .32 * (5000 - elapsed) / 800);
    }, 50);
    window.setTimeout(() => {
      window.clearInterval(fade);
      audio.pause();
      audio.currentTime = 0;
    }, 5000);
  }

  function revealPage() {
    if (prefersReducedMotion) return;
    const overlay = transitionMarkup();
    overlay.classList.add("is-covered");
    document.body.appendChild(overlay);
    playIntroAudio();
    window.setTimeout(() => overlay.classList.add("is-revealing"), 5000);
    window.setTimeout(() => overlay.remove(), 5580);
  }

  function previewDestination(url) {
    let view = viewRoutes.get(url.pathname);
    if (!view && url.pathname.startsWith("/servers/")) view = "servers";
    if (!view) return url.href;
    const params = new URLSearchParams({ view });
    return `/incoming/?${params.toString()}`;
  }

  function coverAndNavigate(destination) {
    if (prefersReducedMotion) {
      location.href = destination;
      return;
    }
    navigating = true;
    const overlay = transitionMarkup();
    overlay.classList.add("is-offscreen");
    document.body.appendChild(overlay);
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("is-covering")));
    window.setTimeout(() => { location.href = destination; }, 370);
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link || navigating || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (link.target === "_blank" || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.hash && url.pathname === location.pathname && url.search === location.search) return;
    event.preventDefault();
    coverAndNavigate(previewDestination(url));
  });

  document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(revealPage));
})();
