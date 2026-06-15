const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const CONFIG = require("../config.js");

const TMP_DB = process.env.ICON_LISTING_DB_PATH || path.join(os.tmpdir(), "icon-listing-db.json");
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
    const action = req.query.action || "state";
    const body = req.method === "GET" ? {} : await readBody(req);
    const db = migrateDb(await loadDb());
    const user = await userFromRequest(req, db);

    const cleaned = await cleanupStaleServers(db);

    if (action === "state") {
      const refreshed = await refreshPings(db);
      if (cleaned || refreshed) await saveDb(db);
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
      await saveDb(db);
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
      await saveDb(db);
      return json(res, 200, { server: publicServer(next) });
    }

    if (action === "deleteServer") {
      requireLogin(user);
      const server = db.servers.find((item) => item.id === body.id);
      if (!server) throw httpError(404, "Listing not found.");
      if (server.ownerId !== user.id && !isAdmin(user)) throw httpError(403, "You cannot delete that listing.");
      db.servers = db.servers.filter((item) => item.id !== body.id);
      db.votes = db.votes.filter((vote) => vote.serverId !== body.id);
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (action === "vote") {
      const server = db.servers.find((item) => item.id === body.serverId);
      if (!server) throw httpError(404, "Listing not found.");
      const minecraftUsername = cleanText(body.minecraftUsername || "");
      if (!/^[A-Za-z0-9_]{3,16}$/.test(minecraftUsername)) throw httpError(400, "Enter a valid Minecraft username.");
      if (server.votifierEnabled) await sendVotifierVote(server, minecraftUsername);
      const vote = { id: createId(), serverId: server.id, minecraftUsername, createdAt: new Date().toISOString() };
      db.votes.push(vote);
      server.votes = votesForServer(db.votes, server.id).length;
      await saveDb(db);
      return json(res, 200, { ok: true, vote, server: publicServer(server) });
    }

    if (action === "trackCopy") {
      const server = db.servers.find((item) => item.id === body.serverId);
      if (!server) throw httpError(404, "Listing not found.");
      recordIpCopy(server, req);
      await saveDb(db);
      return json(res, 200, { ok: true, analytics: publicAnalytics(server) });
    }

    if (action === "accountUpdate") {
      requireLogin(user);
      if (body.username && hasBlockedText(body.username)) throw httpError(400, "That username is not allowed here.");
      if (body.username) user.username = cleanText(body.username);
      if (body.email) user.email = cleanText(body.email);
      if (body.password) user.passwordHash = hashPassword(body.password);
      await saveDb(db);
      return json(res, 200, { user: publicUser(user) });
    }

    if (action === "deleteAccount") {
      requireLogin(user);
      requireFields(body, ["username", "email", "password"]);
      if (body.username !== user.username || body.email !== user.email || !verifyPassword(body.password, user)) {
        throw httpError(400, "Those details do not match your account.");
      }
      db.users = db.users.filter((item) => item.id !== user.id);
      db.servers = db.servers.filter((item) => item.ownerId !== user.id);
      db.votes = db.votes.filter((vote) => db.servers.some((server) => server.id === vote.serverId));
      await saveDb(db);
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
      if (body.command === "toggleSponsor") {
        const server = db.servers.find((item) => item.id === id);
        if (server) server.sponsored = !server.sponsored;
      }
      if (body.command === "banUser") {
        const target = db.users.find((item) => item.id === id);
        if (target) target.banned = !target.banned;
      }
      if (body.command === "deleteUser") {
        db.users = db.users.filter((item) => item.id !== id);
        db.servers = db.servers.filter((item) => item.ownerId !== id);
        db.votes = db.votes.filter((vote) => db.servers.some((server) => server.id === vote.serverId));
      }
      if (body.command === "saveClient") {
        const client = sanitizeClient(body.value || {});
        const existing = db.clients.find((item) => item.id === client.id);
        const next = { ...existing, ...client, id: existing?.id || client.id || createId(), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
        db.clients = existing ? db.clients.map((item) => (item.id === existing.id ? next : item)) : [...db.clients, next];
      }
      if (body.command === "deleteClient") {
        db.clients = db.clients.filter((item) => item.id !== id);
      }
      await saveDb(db);
      return json(res, 200, { ...statePayload(db, user), users: db.users.map(publicUser) });
    }

    throw httpError(404, "Unknown action.");
  } catch (error) {
    return json(res, error.status || 500, { error: error.message || "Server error" });
  }
};

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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
    votes: Array.isArray(db.votes) ? db.votes : []
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
    return JSON.parse(await fs.readFile(TMP_DB, "utf8"));
  } catch {
    return freshDb();
  }
}

async function saveDb(db) {
  requireConfiguredProductionDb();
  if (hasGithubStorage()) {
    await writeGithubDb(db);
    return;
  }
  await fs.writeFile(TMP_DB, JSON.stringify(db, null, 2));
}

let githubDbCache = { data: null, sha: null, loadedAt: 0 };

function hasGithubStorage() {
  return !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

function requireConfiguredProductionDb() {
  if (process.env.VERCEL && !hasGithubStorage() && process.env.ICON_LISTING_ALLOW_TMP_DB !== "true") {
    throw httpError(500, "Database is not configured. Add the GitHub storage variables in Vercel so listings are shared publicly.");
  }
}

async function readGithubDb() {
  if (githubDbCache.data && Date.now() - githubDbCache.loadedAt < 1500) return cloneJson(githubDbCache.data);
  const response = await fetch(githubDbUrl(true), { headers: githubHeaders() });
  if (response.status === 404) {
    const db = migrateDb(freshDb());
    githubDbCache = { data: db, sha: null, loadedAt: Date.now() };
    return cloneJson(db);
  }
  if (!response.ok) throw new Error(`GitHub database read failed (${response.status}).`);
  const payload = await response.json();
  const content = Buffer.from(String(payload.content || "").replace(/\n/g, ""), "base64").toString("utf8");
  const db = migrateDb(JSON.parse(content || "{}"));
  githubDbCache = { data: db, sha: payload.sha, loadedAt: Date.now() };
  return cloneJson(db);
}

async function writeGithubDb(db, retry = true) {
  const normalized = migrateDb(db);
  if (!githubDbCache.sha) await readGithubDb();
  const body = {
    message: "Update Icon Listing database",
    content: Buffer.from(JSON.stringify(normalized, null, 2)).toString("base64"),
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
    return writeGithubDb(normalized, false);
  }
  if (!response.ok) throw new Error(`GitHub database write failed (${response.status}).`);
  const payload = await response.json();
  githubDbCache = { data: cloneJson(normalized), sha: payload.content?.sha || githubDbCache.sha, loadedAt: Date.now() };
}

function githubDbUrl(includeRef) {
  const filePath = process.env.GITHUB_DB_PATH || "data/icon-listing-db.json";
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

function statePayload(db, user) {
  return { servers: rankServers(db.servers, db.votes).map(publicServer), clients: db.clients, votes: db.votes, user: publicUser(user) };
}

async function cleanupStaleServers(db) {
  const cutoff = Date.now() - CONFIG.limits.staleServerDeleteDays * 24 * 60 * 60 * 1000;
  const before = db.servers.length;
  db.servers = db.servers.filter((server) => !server.lastSuccessfulPingAt || new Date(server.lastSuccessfulPingAt).getTime() >= cutoff);
  return db.servers.length !== before;
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
  return next;
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

function publicServer(server) {
  return { ...server, analytics: publicAnalytics(server) };
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
