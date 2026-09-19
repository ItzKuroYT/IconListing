const fs = require("fs/promises");
const path = require("path");

async function refreshShellAssets(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "data", "_site"].includes(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) { await refreshShellAssets(filePath); continue; }
    if (!entry.name.endsWith(".html")) continue;
    const original = await fs.readFile(filePath, "utf8");
    let html = original
      .replace(/^[ \t]*<script async src="https:\/\/pagead2\.googlesyndication\.com[^\n]*<\/script>\r?\n/gm, "")
      .replace(/(assets\/css\/styles\.css|assets\/js\/(?:app|ads|incoming)\.js|config\.js)\?v=[^"\s]+/g, "$1?v=20260918-billing2");
    if (!html.includes("assets/js/incoming.js")) html = html.replace(/(<script src="[^"]*config\.js[^>]*><\/script>)/, '$1\n    <script src="/assets/js/incoming.js?v=20260918-billing2" defer></script>');
    if (!html.includes("assets/js/ads.js")) html = html.replace(/(<script src="[^"]*config\.js[^>]*><\/script>)/, '$1\n    <script src="/assets/js/ads.js?v=20260918-billing2" defer></script>');
    if (/data-page="(?:admin|dashboard|login|vote)"/.test(html)) {
      if (/<meta name="robots" content="[^"]*">/.test(html)) html = html.replace(/<meta name="robots" content="[^"]*">/, '<meta name="robots" content="noindex, follow">');
      else html = html.replace(/(<meta name="viewport"[^>]*>)/, '$1\n    <meta name="robots" content="noindex, follow">');
    }
    html = html.replace(/[ \t]+$/gm, "");
    if (html !== original) await fs.writeFile(filePath, html);
  }
}

module.exports = { refreshShellAssets };
