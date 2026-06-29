const fs = require("fs/promises");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "icon-listing-db.json");
const outputRoot = path.join(__dirname, "..");
const { __iconListingStatic } = require("../api/index.js");

async function main() {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const entries = __iconListingStatic.staticServerPageEntries(db);

  for (const entry of entries) {
    const filePath = path.join(outputRoot, entry.filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, entry.html);
  }

  await fs.writeFile(path.join(outputRoot, "404.html"), __iconListingStatic.fallback404Html());
  console.log(`Generated ${entries.length} server pages and 404.html.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
