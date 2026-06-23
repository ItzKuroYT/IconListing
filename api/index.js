const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const CONFIG = require("../config.js");

const TMP_DB = process.env.ICON_LISTING_DB_PATH || path.join(os.tmpdir(), "icon-listing-db.json");
const TMP_DB_BACKUP = process.env.ICON_LISTING_DB_BACKUP_PATH || `${TMP_DB}.backup.json`;
const SESSION_SECRET = process.env.SESSION_SECRET || "replace-this-secret-in-vercel";
const PING_TTL_MS = 5 * 60 * 1000;
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

module.exports = async function handler(req, res) {
  Object.entries(JSON_HEADERS).forEach(([key, value]) => res.setHeader(key, value));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const action = actionFromRequest(req);
    const body = req.method === "GET" ? {} : await readBody(req);
    const db = migrateDb(await loadDb());
    const user = await userFromRequest(req, db);

    if (action === "sitemap") {
      return xml(res, 200, sitemapXml(db));
    }

    if (action === "state") {
      const refreshed = await refreshPings(db);
      if (refreshed) await saveDb(db);
      return json(res, 200, statePayload(db, user));
    }

    if (action === "register") {
      requireFields(body, ["username", "email", "password"]);
      if (hasBlockedText(body.username)) throw httpError(400, "That username is not allowed here.");
      const exists = db.users.some((item) => same(item.email, body.email) || same(item.username, body.username));
      if (exists) throw httpError(409, "That username or email is already taken.");
      const next = {
        id: createId(),
        username: cleanText(body.username),
        email: cleanText(body.email),
        passwordHash: hashPassword(body.password),
        banned: false,
        createdAt: new Date().toISOString()
      };
      db.users.push(next);
      await saveDb(db, { touchedUsers: [next.id], uniqueUserId: next.id });
      return json(res, 200, { user: publicUser(next), token: signToken(next.id) });
    }

    if (action === "login") {
      requireFields(body, ["login", "password"]);
      const next = db.users.find((item) => same(item.email, body.login) || same(item.username, body.login));
      if (!next || next.banned || !verifyPassword(body.password, next)) throw httpError(401, "That login did not match an account.");
      return json(res, 200, { user: publicUser(next), token: signToken(next.id) });
    }

    if (action === "saveServer") {
      requireLogin(user);
      const server = validateServer(body.server || {});
      const existing = db.servers.find((item) => item.id === server.id);
      if (existing && existing.ownerId !== user.id && !isAdmin(user)) throw httpError(403, "You cannot edit that listing.");
      ensureUniqueServerListing(db, server, existing?.id || server.id);
      const next = {
        ...existing,
        ...server,
        id: server.id || createId(),
        ownerId: existing?.ownerId || user.id,
        ownerName: user.username,
        votes: existing?.votes || 0,
        playersOnline: existing?.playersOnline || 0,
        playersMax: existing?.playersMax || 0,
        version: existing?.version || "Unknown",
        online: existing?.online || false,
        uptimePercent: existing?.uptimePercent || 0,
        sponsored: existing?.sponsored || false,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await updatePing(next);
      db.servers = existing ? db.servers.map((item) => (item.id === existing.id ? next : item)) : [...db.servers, next];
      await saveDb(db, { touchedServers: [next.id], uniqueServerId: next.id });
      return json(res, 200, { server: publicServer(next) });
    }

    if (action === "deleteServer") {
      requireLogin(user);
      const server = db.servers.find((item) => item.id === body.id);
      if (!server) throw httpError(404, "Listing not found.");
      if (server.ownerId !== user.id && !isAdmin(user)) throw httpError(403, "You cannot delete that listing.");
      db.servers = db.servers.filter((item) => item.id !== body.id);
      db.votes = db.votes.filter((vote) => vote.serverId !== body.id);
      if (db.voteIps) delete db.voteIps[body.id];
      await saveDb(db, { deletedServers: [body.id] });
      return json(res, 200, { ok: true });
    }

    if (action === "vote") {
      const server = db.servers.find((item) => item.id === body.serverId);
      if (!server) throw httpError(404, "Listing not found.");
      const minecraftUsername = cleanText(body.minecraftUsername || "");
      if (!/^[A-Za-z0-9_]{3,16}$/.test(minecraftUsername)) throw httpError(400, "Enter a valid Minecraft username.");
      enforceVoteCooldown(db, server.id, minecraftUsername, req);
      if (server.votifierEnabled) await sendVotifierVote(server, minecraftUsername);
      const vote = { id: createId(), serverId: server.id, minecraftUsername, createdAt: new Date().toISOString() };
      db.votes.push(vote);
      recordVoteCooldown(db, server.id, minecraftUsername, req);
      server.votes = votesForServer(db.votes, server.id).length;
      await saveDb(db, { requireExistingServers: [server.id], touchedVotes: [vote.id] });
      return json(res, 200, { ok: true, vote, server: publicServer(server) });
    }

    if (action === "trackCopy") {
      const server = db.servers.find((item) => item.id === body.serverId);
      if (!server) throw httpError(404, "Listing not found.");
      recordIpCopy(server, req);
      await saveDb(db, { requireExistingServers: [server.id], touchedServers: [server.id] });
      return json(res, 200, { ok: true, analytics: publicAnalytics(server) });
    }

    if (action === "accountUpdate") {
      requireLogin(user);
      if (body.username && hasBlockedText(body.username)) throw httpError(400, "That username is not allowed here.");
      if (body.username) user.username = cleanText(body.username);
      if (body.email) user.email = cleanText(body.email);
      if (body.password) user.passwordHash = hashPassword(body.password);
      ensureUniqueUser(db, user, user.id);
      await saveDb(db, { requireExistingUsers: [user.id], touchedUsers: [user.id], uniqueUserId: user.id });
      return json(res, 200, { user: publicUser(user) });
    }

    if (action === "deleteAccount") {
      requireLogin(user);
      requireFields(body, ["username", "email", "password"]);
      if (body.username !== user.username || body.email !== user.email || !verifyPassword(body.password, user)) {
        throw httpError(400, "Those details do not match your account.");
      }
      const deletedServerIds = db.servers.filter((item) => item.ownerId === user.id).map((item) => item.id);
      db.users = db.users.filter((item) => item.id !== user.id);
      db.servers = db.servers.filter((item) => item.ownerId !== user.id);
      db.votes = db.votes.filter((vote) => db.servers.some((server) => server.id === vote.serverId));
      pruneVoteCooldowns(db);
      await saveDb(db, { deletedUsers: [user.id], deletedServers: deletedServerIds });
      return json(res, 200, { ok: true });
    }

    if (action === "testVote") {
      requireLogin(user);
      const result = await sendVotifierPayload({
        host: clean(body.host),
        port: Number(body.port || 8192),
        token: clean(body.token),
        minecraftUsername: CONFIG.votifier.testUsername,
        serviceName: CONFIG.site.name
      });
      return json(res, 200, result);
    }

    if (action === "admin") {
      requireAdmin(user);
      const id = body.value?.id;
      const saveOptions = {};
      if (body.command === "toggleSponsor") {
        const server = db.servers.find((item) => item.id === id);
        if (server) {
          server.sponsored = !server.sponsored;
          saveOptions.touchedServers = [server.id];
        }
      }
      if (body.command === "banUser") {
        const target = db.users.find((item) => item.id === id);
        if (target) {
          target.banned = !target.banned;
          saveOptions.touchedUsers = [target.id];
        }
      }
      if (body.command === "deleteUser") {
        const deletedServerIds = db.servers.filter((item) => item.ownerId === id).map((item) => item.id);
        db.users = db.users.filter((item) => item.id !== id);
        db.servers = db.servers.filter((item) => item.ownerId !== id);
        db.votes = db.votes.filter((vote) => db.servers.some((server) => server.id === vote.serverId));
        pruneVoteCooldowns(db);
        saveOptions.deletedUsers = [id];
        saveOptions.deletedServers = deletedServerIds;
      }
      if (body.command === "saveClient") {
        const client = sanitizeClient(body.value || {});
        const existing = db.clients.find((item) => item.id === client.id);
        const next = { ...existing, ...client, id: existing?.id || client.id || createId(), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
        db.clients = existing ? db.clients.map((item) => (item.id === existing.id ? next : item)) : [...db.clients, next];
        saveOptions.touchedClients = [next.id];
      }
      if (body.command === "deleteClient") {
        db.clients = db.clients.filter((item) => item.id !== id);
        saveOptions.deletedClients = [id];
      }
      await saveDb(db, saveOptions);
      return json(res, 200, { ...statePayload(db, user), users: db.users.map(publicUser) });
    }

    throw httpError(404, "Unknown action.");
  } catch (error) {
    const status = error.status || 500;
    const message = status >= 500 ? "This action is temporarily unavailable. Error: 67." : error.message || "Request failed.";
    return json(res, status, { error: message });
  }
};

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function actionFromRequest(req) {
  const url = new URL(req.url || "/", "https://listing.iconrealms.net");
  if (url.pathname.endsWith("/sitemap.xml")) return "sitemap";
  return req.query?.action || url.searchParams.get("action") || "state";
}

function freshDb() {
  return { version: 2, users: [], servers: [], clients: [], votes: [], voteIps: {} };
}

function migrateDb(db = freshDb()) {
  return {
    ...freshDb(),
    ...db,
    version: 2,
    users: Array.isArray(db.users) ? db.users : [],
    servers: Array.isArray(db.servers) ? db.servers.filter((server) => !String(server.id || "").startsWith("seed-")).map(normalizeServer) : [],
    clients: Array.isArray(db.clients) ? db.clients.filter((client) => !String(client.id || "").startsWith("client-")).map(normalizeClient) : [],
    votes: Array.isArray(db.votes) ? db.votes : [],
    voteIps: db.voteIps && !Array.isArray(db.voteIps) ? db.voteIps : {}
  };
}

function normalizeServer(server) {
  return {
    ...server,
    analytics: {
      ipCopies: Array.isArray(server.analytics?.ipCopies) ? server.analytics.ipCopies : [],
      playerHistory: Array.isArray(server.analytics?.playerHistory) ? server.analytics.playerHistory : []
    }
  };
}

function normalizeClient(client) {
  const images = Array.isArray(client.images) ? client.images : [client.imageUrl1, client.imageUrl2, client.logoUrl].filter(Boolean);
  return {
    ...client,
    url: client.url || client.websiteUrl || "",
    youtubeUrl: client.youtubeUrl || "",
    images: images.filter(Boolean).slice(0, 2),
    version: ["java", "bedrock", "both"].includes(client.version) ? client.version : "both",
    pricing: ["free", "paid"].includes(client.pricing) ? client.pricing : "free"
  };
}

async function loadDb() {
  requireConfiguredProductionDb();
  if (hasGithubStorage()) return readGithubDb();
  try {
    return parseDbFromStorage(await fs.readFile(TMP_DB, "utf8"));
  } catch {
    return freshDb();
  }
}

async function saveDb(db, options = {}) {
  requireConfiguredProductionDb();
  if (hasGithubStorage()) {
    await writeGithubDb(db, options);
    return;
  }
  await writeLocalBackup();
  await fs.writeFile(TMP_DB, serializeDbForStorage(db));
}

let githubDbCache = { data: null, sha: null, loadedAt: 0 };

function hasGithubStorage() {
  return !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

function requireConfiguredProductionDb() {
  if (process.env.VERCEL && !hasGithubStorage()) {
    throw httpError(500, "This action is temporarily unavailable. Error: 67.");
  }
}

async function readGithubDb(options = {}) {
  if (!options.bypassCache && githubDbCache.data && Date.now() - githubDbCache.loadedAt < 1500) return cloneJson(githubDbCache.data);
  const response = await fetch(githubDbUrl(true), { headers: githubHeaders() });
  if (response.status === 404) {
    const db = migrateDb(freshDb());
    githubDbCache = { data: db, sha: null, loadedAt: Date.now() };
    return cloneJson(db);
  }
  if (!response.ok) throw new Error(`GitHub database read failed (${response.status}).`);
  const payload = await response.json();
  const content = Buffer.from(String(payload.content || "").replace(/\n/g, ""), "base64").toString("utf8");
  const db = parseDbFromStorage(content);
  githubDbCache = { data: db, sha: payload.sha, loadedAt: Date.now() };
  return cloneJson(db);
}

async function writeGithubDb(db, options = {}, retry = true) {
  let normalized = migrateDb(db);
  const latest = await readGithubDb({ bypassCache: true });
  ensureRequiredRecordsExist(latest, options);
  normalized = mergeDbForWrite(latest, normalized, options);
  ensureWriteDoesNotLoseData(latest, normalized, options);
  await writeGithubBackup(latest);
  const body = {
    message: "Update Icon Listing database",
    content: Buffer.from(serializeDbForStorage(normalized)).toString("base64"),
    branch: githubBranch()
  };
  if (githubDbCache.sha) body.sha = githubDbCache.sha;
  const response = await fetch(githubDbUrl(false), {
    method: "PUT",
    headers: githubHeaders(),
    body: JSON.stringify(body)
  });
  if (response.status === 409 && retry) {
    githubDbCache = { data: null, sha: null, loadedAt: 0 };
    return writeGithubDb(normalized, options, false);
  }
  if (!response.ok) throw new Error(`GitHub database write failed (${response.status}).`);
  const payload = await response.json();
  githubDbCache = { data: cloneJson(normalized), sha: payload.content?.sha || githubDbCache.sha, loadedAt: Date.now() };
}

async function writeLocalBackup() {
  try {
    const current = await fs.readFile(TMP_DB, "utf8");
    await fs.writeFile(TMP_DB_BACKUP, current);
  } catch {
    // A missing local DB is normal before the first local save.
  }
}

async function writeGithubBackup(db) {
  const latest = migrateDb(db);
  if (!hasAnyStoredData(latest)) return;
  try {
    const backupPath = process.env.GITHUB_DB_BACKUP_PATH || backupPathFor(githubDbPath());
    const existing = await readGithubFile(backupPath);
    const body = {
      message: "Backup Icon Listing database",
      content: Buffer.from(serializeDbForStorage(latest)).toString("base64"),
      branch: githubBranch()
    };
    if (existing.sha) body.sha = existing.sha;
    await fetch(githubFileUrl(backupPath, false), {
      method: "PUT",
      headers: githubHeaders(),
      body: JSON.stringify(body)
    });
  } catch (error) {
    console.error("Icon Listing backup write failed", error.message);
  }
}

async function readGithubFile(filePath) {
  const response = await fetch(githubFileUrl(filePath, true), { headers: githubHeaders() });
  if (response.status === 404) return { sha: null, content: "" };
  if (!response.ok) throw new Error(`GitHub file read failed (${response.status}).`);
  return response.json();
}

function mergeDbForWrite(remoteDb, nextDb, options = {}) {
  const remote = migrateDb(remoteDb);
  const next = migrateDb(nextDb);
  const ids = writeIdSets(options);
  const merged = {
    ...next,
    users: mergeById(remote.users, next.users, ids.deletedUsers, ids.touchedUsers),
    servers: mergeById(remote.servers, next.servers, ids.deletedServers, ids.touchedServers),
    clients: mergeById(remote.clients, next.clients, ids.deletedClients, ids.touchedClients),
    votes: mergeVotes(remote.votes, next.votes, ids.deletedServers, ids.touchedVotes),
    voteIps: mergeVoteIps(remote.voteIps, next.voteIps, ids.deletedServers)
  };
  pruneVoteCooldowns(merged);
  ensureMergedWriteIsValid(merged, options);
  return migrateDb(merged);
}

function ensureRequiredRecordsExist(remoteDb, options = {}) {
  const remote = migrateDb(remoteDb);
  const missingServer = (options.requireExistingServers || []).find((id) => !remote.servers.some((item) => item.id === id));
  const missingUser = (options.requireExistingUsers || []).find((id) => !remote.users.some((item) => item.id === id));
  const missingClient = (options.requireExistingClients || []).find((id) => !remote.clients.some((item) => item.id === id));
  if (missingServer || missingUser || missingClient) throw httpError(409, "Storage changed before this action finished. Please refresh and try again.");
}

function ensureWriteDoesNotLoseData(remoteDb, nextDb, options = {}) {
  const remote = migrateDb(remoteDb);
  const next = migrateDb(nextDb);
  const ids = writeIdSets(options);
  assertNoUnexpectedLoss("server", remote.servers, next.servers, ids.deletedServers);
  assertNoUnexpectedLoss("user", remote.users, next.users, ids.deletedUsers);
  assertNoUnexpectedLoss("client", remote.clients, next.clients, ids.deletedClients);
  assertNoUnexpectedVoteLoss(remote.votes, next.votes, ids.deletedServers);
}

function assertNoUnexpectedLoss(label, remoteItems = [], nextItems = [], deletedIds = new Set()) {
  const allowedLoss = [...deletedIds].length;
  if (nextItems.length + allowedLoss < remoteItems.length) {
    throw httpError(409, `Storage protection blocked an unexpected ${label} data change. Please refresh and try again.`);
  }
}

function assertNoUnexpectedVoteLoss(remoteVotes = [], nextVotes = [], deletedServerIds = new Set()) {
  const allowedLoss = remoteVotes.filter((vote) => deletedServerIds.has(vote.serverId)).length;
  if (nextVotes.length + allowedLoss < remoteVotes.length) {
    throw httpError(409, "Storage protection blocked an unexpected vote data change. Please refresh and try again.");
  }
}

function hasAnyStoredData(db) {
  return !!(db.users.length || db.servers.length || db.clients.length || db.votes.length || Object.keys(db.voteIps || {}).length);
}

function ensureMergedWriteIsValid(db, options = {}) {
  if (options.uniqueUserId) {
    const user = db.users.find((item) => item.id === options.uniqueUserId);
    if (user) ensureUniqueUser(db, user, user.id);
  }
  if (options.uniqueServerId) {
    const server = db.servers.find((item) => item.id === options.uniqueServerId);
    if (server) ensureUniqueServerListing(db, server, server.id);
  }
}

function writeIdSets(options = {}) {
  return {
    deletedUsers: new Set(options.deletedUsers || []),
    deletedServers: new Set(options.deletedServers || []),
    deletedClients: new Set(options.deletedClients || []),
    touchedUsers: new Set(options.touchedUsers || []),
    touchedServers: new Set(options.touchedServers || []),
    touchedClients: new Set(options.touchedClients || []),
    touchedVotes: new Set(options.touchedVotes || [])
  };
}

function mergeById(remoteItems = [], nextItems = [], deletedIds = new Set(), touchedIds = new Set()) {
  const merged = new Map();
  const remoteIds = new Set();
  for (const item of remoteItems) {
    if (item?.id && !deletedIds.has(item.id)) {
      remoteIds.add(item.id);
      merged.set(item.id, item);
    }
  }
  for (const item of nextItems) {
    if (item?.id && !deletedIds.has(item.id) && (remoteIds.has(item.id) || touchedIds.has(item.id))) merged.set(item.id, item);
  }
  return [...merged.values()];
}

function mergeVotes(remoteVotes = [], nextVotes = [], deletedServerIds = new Set(), touchedVoteIds = new Set()) {
  const merged = new Map();
  const remoteIds = new Set();
  const add = (vote) => {
    if (!vote?.id || deletedServerIds.has(vote.serverId)) return;
    merged.set(vote.id, vote);
  };
  remoteVotes.forEach((vote) => {
    if (vote?.id && !deletedServerIds.has(vote.serverId)) remoteIds.add(vote.id);
    add(vote);
  });
  nextVotes.forEach((vote) => {
    if (remoteIds.has(vote?.id) || touchedVoteIds.has(vote?.id)) add(vote);
  });
  return [...merged.values()];
}

function mergeVoteIps(remoteVoteIps = {}, nextVoteIps = {}, deletedServerIds = new Set()) {
  const merged = cloneJson(remoteVoteIps || {});
  for (const [serverId, entries] of Object.entries(nextVoteIps || {})) {
    if (deletedServerIds.has(serverId)) continue;
    merged[serverId] = { ...(merged[serverId] || {}), ...(entries || {}) };
  }
  for (const serverId of deletedServerIds) delete merged[serverId];
  return merged;
}

function githubDbUrl(includeRef) {
  return githubFileUrl(githubDbPath(), includeRef);
}

function githubDbPath() {
  return process.env.GITHUB_DB_PATH || "data/icon-listing-db.json";
}

function backupPathFor(filePath) {
  const parsed = path.posix.parse(filePath.replace(/\\/g, "/"));
  return path.posix.join(parsed.dir, `${parsed.name}.backup${parsed.ext || ".json"}`);
}

function githubFileUrl(filePath, includeRef) {
  const contentPath = encodeURIComponent(filePath).replace(/%2F/g, "/");
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${contentPath}`;
  return includeRef ? `${base}?ref=${encodeURIComponent(githubBranch())}` : base;
}

function githubBranch() {
  return process.env.GITHUB_BRANCH || "main";
}

function githubHeaders() {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "content-type": "application/json",
    "user-agent": "IconListing"
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseDbFromStorage(content = "") {
  const parsed = JSON.parse(content || "{}");
  if (!parsed?.encrypted) return migrateDb(parsed);
  if (parsed.algorithm !== "aes-256-gcm") throw new Error("Unsupported database encryption.");
  const secret = storageEncryptionSecret();
  if (!secret) throw new Error("Database encryption key is missing.");
  const key = crypto.createHash("sha256").update(secret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
  return migrateDb(JSON.parse(decrypted || "{}"));
}

function serializeDbForStorage(db) {
  const normalized = migrateDb(db);
  const jsonBody = JSON.stringify(normalized, null, 2);
  const secret = storageEncryptionSecret();
  if (!secret) return jsonBody;
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(jsonBody, "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    encrypted: true,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  }, null, 2);
}

function storageEncryptionSecret() {
  return process.env.DATABASE_ENCRYPTION_KEY || process.env.ICON_LISTING_DB_ENCRYPTION_KEY || "";
}

function statePayload(db, user) {
  return { servers: rankServers(db.servers, db.votes).map(publicServer), clients: db.clients, votes: db.votes, user: publicUser(user) };
}

function siteUrl(pathname = "/") {
  const base = String(CONFIG.site.url || "https://listing.iconrealms.net").replace(/\/$/, "");
  const path = String(pathname || "/");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function sitemapXml(db) {
  const now = new Date().toISOString();
  const staticUrls = [
    { loc: siteUrl("/"), priority: "1.0", changefreq: "daily" },
    { loc: siteUrl("/servers/"), priority: "0.9", changefreq: "daily" },
    { loc: siteUrl("/sponsored/"), priority: "0.7", changefreq: "weekly" },
    { loc: siteUrl("/sponsored-clients/"), priority: "0.7", changefreq: "weekly" },
    { loc: siteUrl("/help/"), priority: "0.4", changefreq: "monthly" },
    { loc: siteUrl("/contact/"), priority: "0.4", changefreq: "monthly" }
  ];
  const serverUrls = rankServers(db.servers, db.votes).map((server) => ({
    loc: siteUrl(`/server/?id=${encodeURIComponent(server.id)}`),
    priority: server.sponsored ? "0.8" : "0.6",
    changefreq: "daily",
    lastmod: server.updatedAt || server.createdAt || server.lastPingAt || now
  }));
  const urls = [...staticUrls, ...serverUrls];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(sitemapUrlEntry).join("\n")}\n</urlset>`;
}

function sitemapUrlEntry(item) {
  return `  <url>\n    <loc>${escapeXml(item.loc)}</loc>\n    <lastmod>${escapeXml(item.lastmod || new Date().toISOString())}</lastmod>\n    <changefreq>${escapeXml(item.changefreq || "weekly")}</changefreq>\n    <priority>${escapeXml(item.priority || "0.5")}</priority>\n  </url>`;
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function cleanupStaleServers(db) {
  return false;
}

async function refreshPings(db) {
  let changed = false;
  for (const server of db.servers) {
    if (!server.lastPingAt || Date.now() - new Date(server.lastPingAt).getTime() > PING_TTL_MS) {
      await updatePing(server);
      changed = true;
    }
  }
  return changed;
}

async function updatePing(server) {
  const ping = await pingJava(server.javaHost, server.javaPort);
  const now = new Date().toISOString();
  server.lastPingAt = now;
  server.online = ping.online;
  server.playersOnline = ping.playersOnline;
  server.playersMax = ping.playersMax;
  server.version = ping.version || server.version || "Unknown";
  recordPlayerSnapshot(server, now);
  if (ping.online) {
    server.lastSuccessfulPingAt = now;
    server.uptimeChecks = Number(server.uptimeChecks || 0) + 1;
    server.uptimeSuccesses = Number(server.uptimeSuccesses || 0) + 1;
  } else {
    server.uptimeChecks = Number(server.uptimeChecks || 0) + 1;
  }
  server.uptimePercent = server.uptimeChecks ? (Number(server.uptimeSuccesses || 0) / server.uptimeChecks) * 100 : 0;
}

function recordPlayerSnapshot(server, createdAt) {
  if (!server.analytics) server.analytics = { ipCopies: [], playerHistory: [] };
  if (!server.analytics.playerHistory) server.analytics.playerHistory = [];
  const last = server.analytics.playerHistory[server.analytics.playerHistory.length - 1];
  if (last && new Date(createdAt).getTime() - new Date(last.createdAt).getTime() < 60 * 60 * 1000) {
    server.analytics.playerHistory[server.analytics.playerHistory.length - 1] = {
      createdAt,
      playersOnline: Number(server.playersOnline || 0),
      playersMax: Number(server.playersMax || 0),
      online: !!server.online
    };
  } else {
    server.analytics.playerHistory.push({
      createdAt,
      playersOnline: Number(server.playersOnline || 0),
      playersMax: Number(server.playersMax || 0),
      online: !!server.online
    });
  }
  const cutoff = Date.now() - 31 * 24 * 60 * 60 * 1000;
  server.analytics.playerHistory = server.analytics.playerHistory.filter((item) => new Date(item.createdAt).getTime() >= cutoff).slice(-120);
}

async function pingJava(host, port) {
  try {
    const target = `${host}:${Number(port || CONFIG.defaults.javaPort)}`;
    const response = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(target)}`);
    if (!response.ok) throw new Error("mcstatus request failed");
    const data = await response.json();
    return {
      online: !!data.online,
      playersOnline: Number(data.players?.online || 0),
      playersMax: Number(data.players?.max || 0),
      version: data.version?.name_clean || data.version?.name_raw || "Unknown"
    };
  } catch {
    return { online: false, playersOnline: 0, playersMax: 0, version: "Unknown" };
  }
}

async function sendVotifierVote(server, minecraftUsername) {
  return sendVotifierPayload({
    host: server.votifierHost || server.javaHost,
    port: Number(server.votifierPort || 8192),
    token: server.votifierToken,
    minecraftUsername,
    serviceName: CONFIG.site.name,
    serverId: server.id
  });
}

async function sendVotifierPayload(payload) {
  if (!CONFIG.votifier.providerEndpoint) {
    throw httpError(400, "Set votifier.providerEndpoint in config.js before sending Votifier votes.");
  }
  requireFields(payload, ["host", "port", "token", "minecraftUsername"]);
  const response = await fetch(CONFIG.votifier.providerEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw httpError(502, "The Votifier provider rejected the vote.");
  return { ok: true, message: "Votifier vote sent." };
}

function validateServer(server) {
  const next = {
    id: clean(server.id),
    name: cleanText(server.name),
    javaHost: cleanText(server.javaHost),
    javaPort: Number(server.javaPort || CONFIG.defaults.javaPort),
    crossPlay: !!server.crossPlay,
    bedrockHost: cleanText(server.bedrockHost),
    bedrockPort: Number(server.bedrockPort || CONFIG.defaults.bedrockPort),
    votifierEnabled: !!server.votifierEnabled,
    votifierHost: cleanText(server.votifierHost),
    votifierPort: Number(server.votifierPort || 8192),
    votifierToken: cleanText(server.votifierToken),
    websiteUrl: clean(server.websiteUrl),
    discordUrl: clean(server.discordUrl),
    youtubeUrl: clean(server.youtubeUrl),
    country: cleanText(server.country),
    bannerUrl: clean(server.bannerUrl),
    description: cleanText(server.description),
    tags: Array.isArray(server.tags) ? server.tags.filter((tag) => allTags().includes(tag)).slice(0, CONFIG.limits.tagsMax) : []
  };
  if (!next.name || !next.javaHost) throw httpError(400, "Server name and Java host are required.");
  if (hasBlockedText(server.name) || hasBlockedText(server.description)) throw httpError(400, "Please remove blocked words from the listing.");
  if (next.description.length < CONFIG.limits.descriptionMinLength) throw httpError(400, `Description must be at least ${CONFIG.limits.descriptionMinLength} characters.`);
  if (next.tags.length < CONFIG.limits.tagsMin || next.tags.length > CONFIG.limits.tagsMax) throw httpError(400, `Select ${CONFIG.limits.tagsMin} to ${CONFIG.limits.tagsMax} tags.`);
  if (!CONFIG.countries.includes(next.country)) throw httpError(400, "Select a valid country.");
  if (next.crossPlay && !next.bedrockHost) throw httpError(400, "Bedrock host is required for cross-play listings.");
  if (isBlockedServerHost(next.javaHost) || isBlockedServerHost(next.bedrockHost)) throw httpError(400, "FalixSrv and Aternos servers are not allowed on this listing site.");
  return next;
}

function ensureUniqueUser(db, user, currentId = "") {
  for (const existing of db.users || []) {
    if (existing.id && existing.id === currentId) continue;
    if (same(existing.username, user.username) || same(existing.email, user.email)) {
      throw httpError(409, "That username or email is already taken.");
    }
  }
}

function ensureUniqueServerListing(db, server, currentId = "") {
  const name = comparableText(server.name);
  const description = comparableText(server.description);
  const addresses = new Set(serverAddressKeys(server));
  for (const existing of db.servers || []) {
    if (existing.id && existing.id === currentId) continue;
    if (name && comparableText(existing.name) === name) {
      throw httpError(409, "A listing with that server name already exists.");
    }
    if (description && comparableText(existing.description) === description) {
      throw httpError(409, "A listing with that description already exists.");
    }
    if (serverAddressKeys(existing).some((key) => addresses.has(key))) {
      throw httpError(409, "A listing with that server IP already exists.");
    }
  }
}

function comparableText(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function serverAddressKeys(server) {
  return [
    hostPortKey(server.javaHost, server.javaPort, CONFIG.defaults.javaPort),
    server.crossPlay || server.bedrockHost ? hostPortKey(server.bedrockHost, server.bedrockPort, CONFIG.defaults.bedrockPort) : ""
  ].filter(Boolean);
}

function hostPortKey(host = "", port, defaultPort) {
  let value = String(host || "").trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
  const match = value.match(/^(.+):(\d+)$/);
  if (match) {
    value = match[1];
    port = Number(match[2]);
  }
  return `${value}:${Number(port || defaultPort)}`;
}

function sanitizeClient(client) {
  const images = Array.isArray(client.images)
    ? client.images
    : [client.imageUrl1, client.imageUrl2, client.logoUrl].filter(Boolean);
  const next = {
    id: clean(client.id),
    name: cleanText(client.name),
    url: clean(client.url || client.websiteUrl),
    youtubeUrl: clean(client.youtubeUrl),
    description: cleanText(client.description),
    images: images.map(clean).filter(Boolean).slice(0, 2),
    version: ["java", "bedrock", "both"].includes(client.version) ? client.version : "both",
    pricing: ["free", "paid"].includes(client.pricing) ? client.pricing : "free"
  };
  if (!next.name) throw httpError(400, "Client name is required.");
  if (!next.url) throw httpError(400, "Website/download link is required.");
  if (hasBlockedText(client.name) || hasBlockedText(client.description)) throw httpError(400, "Please remove blocked words from the client listing.");
  if (next.description.length < CONFIG.limits.descriptionMinLength) throw httpError(400, `Client description must be at least ${CONFIG.limits.descriptionMinLength} characters.`);
  return next;
}

function votesForServer(votes, serverId) {
  return votes.filter((vote) => vote.serverId === serverId);
}

function voteCooldownMs() {
  return Number(CONFIG.limits?.voteCooldownHours || 24) * 60 * 60 * 1000;
}

function enforceVoteCooldown(db, serverId, minecraftUsername, req) {
  if (!db.voteIps) db.voteIps = {};
  const entries = db.voteIps[serverId] || {};
  const now = Date.now();
  const cooldown = voteCooldownMs();
  const keys = voteCooldownKeys(minecraftUsername, req);
  const lastVoteAt = keys
    .map((key) => entries[key])
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  if (lastVoteAt && now - lastVoteAt < cooldown) {
    throw httpError(429, "You can only vote once every 24 hours.");
  }
}

function recordVoteCooldown(db, serverId, minecraftUsername, req) {
  if (!db.voteIps) db.voteIps = {};
  const entries = db.voteIps[serverId] || {};
  const now = new Date().toISOString();
  for (const key of voteCooldownKeys(minecraftUsername, req)) entries[key] = now;
  db.voteIps[serverId] = pruneVoteCooldownEntries(entries);
}

function voteCooldownKeys(minecraftUsername, req) {
  return [
    `visitor:${clientHash(req)}`,
    `name:${String(minecraftUsername || "").trim().toLowerCase()}`
  ];
}

function pruneVoteCooldownEntries(entries) {
  const cutoff = Date.now() - voteCooldownMs();
  return Object.fromEntries(Object.entries(entries || {}).filter(([, value]) => new Date(value).getTime() >= cutoff));
}

function pruneVoteCooldowns(db) {
  if (!db.voteIps) db.voteIps = {};
  const serverIds = new Set(db.servers.map((server) => server.id));
  db.voteIps = Object.fromEntries(
    Object.entries(db.voteIps)
      .filter(([serverId]) => serverIds.has(serverId))
      .map(([serverId, entries]) => [serverId, pruneVoteCooldownEntries(entries)])
      .filter(([, entries]) => Object.keys(entries).length)
  );
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours && remainingMinutes) return `${hours}h ${remainingMinutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

function publicServer(server) {
  return { ...server, analytics: publicAnalytics(server) };
}

function isBlockedServerHost(host = "") {
  const value = String(host || "").trim().toLowerCase();
  if (!value) return false;
  return (CONFIG.moderation?.blockedServerHosts || []).some((blocked) => {
    const next = String(blocked || "").trim().toLowerCase();
    return value === next || value.endsWith(`.${next}`) || value.includes(next);
  });
}

function publicAnalytics(server) {
  const analytics = server.analytics || {};
  return {
    ipCopiesLast7: uniqueIpCopies(analytics.ipCopies, 7),
    ipCopiesLast30: uniqueIpCopies(analytics.ipCopies, 30),
    ipCopyDaily: dailyIpCopies(analytics.ipCopies, 30),
    playerHistory: Array.isArray(analytics.playerHistory) ? analytics.playerHistory.slice(-120) : []
  };
}

function uniqueIpCopies(copies = [], days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Set(copies.filter((copy) => new Date(copy.createdAt).getTime() >= cutoff).map((copy) => copy.visitorHash)).size;
}

function dailyIpCopies(copies = [], days) {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.now() - (days - index - 1) * 24 * 60 * 60 * 1000);
    const key = date.toISOString().slice(0, 10);
    const visitors = new Set(copies.filter((copy) => String(copy.createdAt || "").startsWith(key)).map((copy) => copy.visitorHash));
    return { date: key, count: visitors.size };
  });
}

function recordIpCopy(server, req) {
  if (!server.analytics) server.analytics = { ipCopies: [], playerHistory: [] };
  if (!server.analytics.ipCopies) server.analytics.ipCopies = [];
  const visitorHash = clientHash(req);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  server.analytics.ipCopies = server.analytics.ipCopies.filter((copy) => new Date(copy.createdAt).getTime() >= cutoff);
  if (!server.analytics.ipCopies.some((copy) => copy.visitorHash === visitorHash)) {
    server.analytics.ipCopies.push({ visitorHash, createdAt: new Date().toISOString() });
  }
}

function clientHash(req) {
  const forwarded = req.headers["x-forwarded-for"] || req.headers["X-Forwarded-For"] || "";
  const ip = String(forwarded).split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  const agent = req.headers["user-agent"] || req.headers["User-Agent"] || "";
  return crypto.createHmac("sha256", SESSION_SECRET).update(`${ip}|${agent}`).digest("hex");
}

function createId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return [
    crypto.randomBytes(4).toString("hex"),
    crypto.randomBytes(2).toString("hex"),
    crypto.randomBytes(2).toString("hex"),
    crypto.randomBytes(2).toString("hex"),
    crypto.randomBytes(6).toString("hex")
  ].join("-");
}

function rankServers(servers, votes = []) {
  return [...servers]
    .map((server) => ({ ...server, votes: votesForServer(votes, server.id).length || server.votes || 0 }))
    .sort((a, b) => scoreServer(b, votes) - scoreServer(a, votes))
    .map((server, index) => ({ ...server, rank: index + 1 }));
}

function scoreServer(server, votes) {
  const voteCount = votesForServer(votes, server.id).length || server.votes || 0;
  return (server.playersOnline || 0) * CONFIG.ranking.playerWeight + voteCount * CONFIG.ranking.voteWeight + (server.sponsored ? CONFIG.ranking.sponsoredBoost : 0);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, user) {
  if (user.password && user.password === password) return true;
  const saved = user.passwordHash || "";
  const [salt, hash] = saved.split(":");
  if (!salt || !hash) return false;
  const check = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

function signToken(userId) {
  const expires = Date.now() + 1000 * 60 * 60 * 24 * 14;
  const body = `${userId}.${expires}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("hex");
  return `${body}.${sig}`;
}

async function userFromRequest(req, db) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const [userId, expires, sig] = token.split(".");
  if (!userId || !expires || !sig || Date.now() > Number(expires)) return null;
  const body = `${userId}.${expires}`;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("hex");
  if (expected !== sig) return null;
  return db.users.find((item) => item.id === userId && !item.banned) || null;
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, email: user.email, admin: isAdmin(user), banned: !!user.banned };
}

function isAdmin(user) {
  return !!user && (CONFIG.admins.users.includes(user.username) || CONFIG.admins.emails.includes(user.email));
}

function requireLogin(user) {
  if (!user) throw httpError(401, "Log in before doing that.");
}

function requireAdmin(user) {
  requireLogin(user);
  if (!isAdmin(user)) throw httpError(403, "Admin access required.");
}

function requireFields(body, fields) {
  fields.forEach((field) => {
    if (!body[field]) throw httpError(400, `${field} is required.`);
  });
}

function clean(value = "") {
  return String(value || "").trim();
}

function cleanText(value = "") {
  let next = clean(value);
  for (const regex of blockedRegexes()) next = next.replace(regex, CONFIG.moderation.replacement || "***");
  return next;
}

function hasBlockedText(value = "") {
  return blockedRegexes().some((regex) => {
    regex.lastIndex = 0;
    return regex.test(clean(value));
  });
}

function blockedRegexes() {
  const words = CONFIG.moderation?.blockedWords || [];
  const patterns = CONFIG.moderation?.blockedPatterns || [];
  const escapedWords = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return [
    ...escapedWords.map((word) => new RegExp(`\\b${word}\\b`, "gi")),
    ...patterns.map((pattern) => new RegExp(pattern, "gi"))
  ];
}

function same(a = "", b = "") {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

function allTags() {
  return [...CONFIG.gamemodes, ...CONFIG.generalTags];
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(res, status, payload) {
  return res.status(status).end(JSON.stringify(payload));
}

function xml(res, status, body) {
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  return res.status(status).end(body);
}
