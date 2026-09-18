(() => {
  const config = window.ICON_LISTING_CONFIG?.adsense;
  const pathname = location.pathname.replace(/\/?$/, "/");
  // Only publisher-reviewed editorial pages may load Google ads.
  if (!config?.enabled || !config.reviewedPaths?.includes(pathname) || location.search) return;
  if (document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]')) return;
  const script = document.createElement("script");
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5157143725251440";
  document.head.appendChild(script);
})();
