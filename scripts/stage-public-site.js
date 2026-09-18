const fs = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "_site");
const directories = new Set(["assets", "admin", "community", "contact", "dashboard", "download", "guides", "help", "home", "incoming", "login", "privacy", "server", "servers", "sponsored", "sponsored-clients", "sponsored-hosts", "terms", "tools", "vote"]);
const rootFiles = new Set(["index.html", "404.html", "config.js", "ads.txt", "robots.txt", "sitemap.xml", "BingSiteAuth.xml", "CNAME", ".nojekyll", "logo.png"]);
const assetExtensions = new Set([".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".mp3", ".mp4", ".webm", ".jar", ".zip", ".pdf"]);

async function copyPublicDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyPublicDirectory(from, to);
    else if (assetExtensions.has(path.extname(entry.name).toLowerCase())) await fs.copyFile(from, to);
  }
}

async function main() {
  if (path.dirname(output) !== root || path.basename(output) !== "_site") throw new Error("Unexpected staging directory.");
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.join(output, "data"), { recursive: true });
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && directories.has(entry.name)) await copyPublicDirectory(path.join(root, entry.name), path.join(output, entry.name));
    else if (entry.isFile() && rootFiles.has(entry.name)) await fs.copyFile(path.join(root, entry.name), path.join(output, entry.name));
  }
  await fs.copyFile(path.join(root, "data", "public-state.json"), path.join(output, "data", "public-state.json"));
  await fs.writeFile(path.join(output, ".nojekyll"), "");
  console.log("Staged public site in _site. Private database, API source, and environment files excluded.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
