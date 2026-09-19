(() => {
  const isPreviewRoute = location.pathname.replace(/\/+$/, "/") === "/incoming/";
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
  document.body.classList.add("site-motion");
  if (isPreviewRoute) {
    const requestedView = new URLSearchParams(location.search).get("view") || "home";
    const validViews = new Set(viewRoutes.values());
    document.body.dataset.page = validViews.has(requestedView) ? requestedView : "home";
  }

  const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const introHoldMs = 3000;
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
      if (playing || Date.now() - startedAt >= introHoldMs) return;
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
      if (elapsed < 2400) return;
      audio.volume = Math.max(0, .32 * (introHoldMs - elapsed) / 600);
    }, 50);
    window.setTimeout(() => {
      window.clearInterval(fade);
      audio.pause();
      audio.currentTime = 0;
    }, introHoldMs);
  }

  function revealPage() {
    if (prefersReducedMotion) return;
    const overlay = transitionMarkup();
    overlay.classList.add("is-covered");
    document.body.appendChild(overlay);
    playIntroAudio();
    window.setTimeout(() => overlay.classList.add("is-revealing"), introHoldMs);
    window.setTimeout(() => overlay.remove(), introHoldMs + 580);
  }

  function previewDestination(url) {
    if (!isPreviewRoute) return url.href;
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

  function enhanceFooter() {
    const footer = document.querySelector(".footer, .site-footer");
    if (!footer || footer.classList.contains("incoming-footer")) return;
    const config = window.ICON_LISTING_CONFIG?.site || {};
    const reviewUrl = footer.querySelector(".footer-review-link")?.href || "https://www.trustpilot.com/review/minecraftlisting.org";
    const year = new Date().getFullYear();
    const footerWordmark = [..."ICONLISTING"].map((letter, index) => `<span style="--letter-index:${index}">${letter}</span>`).join("");
    footer.classList.add("incoming-footer");
    footer.innerHTML = `<div class="incoming-footer-inner">
      <div class="incoming-footer-main">
        <section class="incoming-footer-brand" aria-labelledby="incomingFooterBrand">
          <a id="incomingFooterBrand" class="incoming-footer-logo" href="/">
            <img src="${config.iconPath || "/assets/icon.png"}" alt="">
            <span>Icon Listing</span>
          </a>
          <p>A curated Minecraft server directory built to help communities get discovered and players find somewhere worth joining.</p>
          <p class="incoming-footer-note">Not affiliated with Mojang or Microsoft.</p>
        </section>
        <nav class="incoming-footer-column" aria-label="Discover">
          <h2>Discover</h2>
          <a href="/servers/">Minecraft servers</a>
          <a href="/community/">Community</a>
          <a href="/sponsored/">Featured servers</a>
          <a href="https://minestore.org" target="_blank" rel="noopener">Server resources</a>
        </nav>
        <nav class="incoming-footer-column" aria-label="For server owners">
          <h2>For owners</h2>
          <a href="/dashboard/">Add a server</a>
          <a href="/sponsored/plans/">Plans and pricing</a>
          <a href="/guides/advertise-your-minecraft-server/">Listing guide</a>
          <a href="${reviewUrl}" target="_blank" rel="noopener">Review Icon Listing</a>
        </nav>
        <nav class="incoming-footer-column" aria-label="Company and legal">
          <h2>Company</h2>
          <a href="/help/">Help center</a>
          <a href="${config.discordUrl || "https://discord.gg/HFyUfk458c"}" target="_blank" rel="noopener">Discord</a>
          <a href="/contact/">Contact</a>
          <a href="/privacy/">Privacy policy</a>
        </nav>
      </div>
      <div class="incoming-footer-bottom">
        <span>&copy; ${year} IconRealms. All rights reserved.</span>
        <div><a href="/terms/">Terms</a><a href="/privacy/">Privacy</a><a href="/contact/">Contact</a></div>
      </div>
      <div class="incoming-footer-wordmark" aria-hidden="true">${footerWordmark}</div>
    </div>`;
    const wordmark = footer.querySelector(".incoming-footer-wordmark");
    if (prefersReducedMotion || !("IntersectionObserver" in window)) {
      wordmark.classList.add("is-visible");
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      wordmark.classList.add("is-visible");
      observer.disconnect();
    }, { threshold: .18, rootMargin: "0px 0px -4% 0px" });
    observer.observe(wordmark);
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

  document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(() => {
    enhanceFooter();
    revealPage();
  }));
})();
