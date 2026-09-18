const fs = require("fs/promises");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "icon-listing-db.json");
const outputRoot = path.join(__dirname, "..");
const { __iconListingStatic } = require("../api/index.js");
const { editorialEntries } = require("./editorial-pages.js");
const { refreshShellAssets } = require("./refresh-shell-assets.js");

async function main() {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const entries = __iconListingStatic.staticServerPageEntries(db);
  const tagEntries = __iconListingStatic.staticTagPageEntries(db);

  const serverRoot = path.join(outputRoot, "server");
  const publishedFiles = new Set(entries.map((entry) => path.resolve(outputRoot, entry.filePath)));
  for (const entry of await fs.readdir(serverRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const staleFile = path.resolve(serverRoot, entry.name, "index.html");
    if (!staleFile.startsWith(serverRoot + path.sep) || publishedFiles.has(staleFile)) continue;
    await fs.unlink(staleFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }

  for (const entry of [...entries, ...tagEntries, ...__iconListingStatic.staticDirectoryPageEntries(db), ...editorialEntries()]) {
    const filePath = path.join(outputRoot, entry.filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, entry.html);
  }

  await fs.writeFile(path.join(outputRoot, "404.html"), __iconListingStatic.fallback404Html());
  await fs.writeFile(path.join(outputRoot, "sitemap.xml"), __iconListingStatic.sitemapXml(db));
  await fs.writeFile(path.join(outputRoot, "data", "public-state.json"), JSON.stringify(__iconListingStatic.publicSnapshotPayload(db), null, 2));
  await refreshShellAssets(outputRoot);
  console.log(`Generated ${entries.length} server pages, ${tagEntries.length} category pages, 404.html, sitemap.xml, and data/public-state.json.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
