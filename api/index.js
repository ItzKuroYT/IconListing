const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const CONFIG = require("../config.js");

const TMP_DB = process.env.ICON_LISTING_DB_PATH || path.join(os.tmpdir(), "icon-listing-db.json");
const TMP_DB_BACKUP = process.env.ICON_LISTING_DB_BACKUP_PATH || `${TMP_DB}.backup.json`;
const RECOVERY_DB_PATH = process.env.ICON_LISTING_RECOVERY_DB_PATH || path.join(__dirname, "..", "data", "icon-listing-db.json");
const SESSION_SECRET = process.env.SESSION_SECRET || "replace-this-secret-in-vercel";
const PING_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOGIN_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LIMIT_MAX_FAILURES = 8;
const VOTIFIER_TIMEOUT_MS = 3000;
const ANALYTICS_DAYS = 30;
const PLAYER_HISTORY_LIMIT = 48;
const COPY_HASHES_PER_DAY_LIMIT = 120;
const WRITE_ACTIONS = new Set(["register", "login", "saveServer", "deleteServer", "vote", "trackCopy", "accountUpdate", "deleteAccount", "testVote", "pluginPoll", "admin"]);
const READ_ACTIONS = new Set(["state", "sitemap"]);
const loginFailures = new Map();

module.exports = async function handler(req, res) {
  applySecurityHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const action = actionFromRequest(req);
    requireAllowedMethod(action, req.method);
    enforceBrowserOrigin(req, action);
    const body = req.method === "GET" ? {} : await readBody(req);
    const db = migrateDb(await loadDb({
      allowRecoveryOnly: ["state", "sitemap", "login"].includes(action),
      forceFresh: WRITE_ACTIONS.has(action) || action === "state"
    }));
    const user = await userFromRequest(req, db);

    if (action === "sitemap") {
      return xml(res, 200, sitemapXml(db));
    }

    if (action === "state") {
      const refreshed = await refreshPings(db);
      if (refreshed) await saveDb(db);
      return json(res, 200, statePayload(db, user, { detailServerId: stateDetailServerId(req) }));
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
      return json(res, 200, { user: publicUser(next), token: signToken(next) });
    }

    if (action === "login") {
      requireFields(body, ["login", "password"]);
      enforceLoginRateLimit(req, body.login);
      const next = db.users.find((item) => same(item.email, body.login) || same(item.username, body.login));
      if (!next || next.banned || !verifyPassword(body.password, next)) {
        recordLoginFailure(req, body.login);
        throw httpError(401, "That login did not match an account.");
      }
      clearLoginFailures(req, body.login);
      return json(res, 200, { user: publicUser(next), token: signToken(next) });
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
      if (next.iconListingPluginEnabled && !next.iconListingVoteKey) next.iconListingVoteKey = createUniqueVoteKey(db, next.id);
      ensureUniqueVoteKey(db, next, existing?.id || next.id);
      await updatePing(next);
      db.servers = existing ? db.servers.map((item) => (item.id === existing.id ? next : item)) : [...db.servers, next];
      await saveDb(db, { touchedServers: [next.id], uniqueServerId: next.id });
      return json(res, 200, { server: publicServer(next, user, { fullAnalytics: true }) });
    }

    if (action === "deleteServer") {
      requireLogin(user);
      const server = db.servers.find((item) => item.id === body.id);
      if (!server) throw httpError(404, "Listing not found.");
      if (server.ownerId !== user.id && !isAdmin(user)) throw httpError(403, "You cannot delete that listing.");
      db.servers = db.servers.filter((item) => item.id !== body.id);
      db.votes = db.votes.filter((vote) => vote.serverId !== body.id);
      if (db.voteIps) delete db.voteIps[body.id];
      markDeleted(db, "servers", [body.id]);
      await saveDb(db, { deletedServers: [body.id] });
      return json(res, 200, { ok: true });
    }

    if (action === "vote") {
      const server = db.servers.find((item) => item.id === body.serverId);
      if (!server) throw httpError(404, "Listing not found.");
      const minecraftUsername = cleanText(body.minecraftUsername || "");
      if (!/^[A-Za-z0-9_]{3,16}$/.test(minecraftUsername)) throw httpError(400, "Enter a valid Minecraft username.");
      enforceVoteCooldown(db, server.id, minecraftUsername, req);
      const previousVoteCount = displayedVoteCount(server, db.votes);
      const vote = { id: createId(), serverId: server.id, minecraftUsername, createdAt: new Date().toISOString() };
      db.votes.push(vote);
      queueIconListingPluginVote(server, vote);
      recordVoteCooldown(db, server.id, minecraftUsername, req);
      server.votes = Math.max(previousVoteCount + 1, votesForServer(db.votes, server.id).length);
      await saveDb(db, { touchedServers: [server.id], touchedVotes: [vote.id] });
      const deliveries = await deliverVoteRewards(server, minecraftUsername);
      return json(res, 200, { ok: true, vote, deliveries, server: publicServer(server, user, { fullAnalytics: true }) });
    }

    if (action === "pluginPoll") {
      requireFields(body, ["key"]);
      const key = cleanVoteKey(body.key);
      const server = db.servers.find((item) => item.iconListingPluginEnabled && sameVoteKey(item.iconListingVoteKey, key));
      if (!server) throw httpError(404, "Vote key not found.");
      const ackIds = Array.isArray(body.ackIds) ? body.ackIds.map(clean).filter(Boolean).slice(0, 100) : [];
      const changed = acknowledgeIconListingPluginVotes(server, ackIds);
      const limit = Math.max(1, Math.min(50, Number(body.limit || 20)));
      const pending = iconListingPluginPendingVotes(server).slice(0, limit);
      if (changed) await saveDb(db, { requireExistingServers: [server.id], touchedServers: [server.id] });
      return json(res, 200, {
        ok: true,
        server: { id: server.id, name: server.name },
        votes: pending.map(publicIconListingPluginVote)
      });
    }

    if (action === "trackCopy") {
      const server = db.servers.find((item) => item.id === body.serverId);
      if (!server) throw httpError(404, "Listing not found.");
      recordIpCopy(server, req);
      await saveDb(db, { requireExistingServers: [server.id], touchedServers: [server.id] });
      return json(res, 200, { ok: true, analytics: publicAnalytics(server, { full: true }) });
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
      markDeleted(db, "users", [user.id]);
      markDeleted(db, "servers", deletedServerIds);
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
        markDeleted(db, "users", [id]);
        markDeleted(db, "servers", deletedServerIds);
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
        markDeleted(db, "clients", [id]);
        saveOptions.deletedClients = [id];
      }
      if (body.command === "saveHost") {
        const host = sanitizeHost(body.value || {});
        const existing = db.hosts.find((item) => item.id === host.id);
        const next = { ...existing, ...host, id: existing?.id || host.id || createId(), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
        db.hosts = existing ? db.hosts.map((item) => (item.id === existing.id ? next : item)) : [...db.hosts, next];
        saveOptions.touchedHosts = [next.id];
      }
      if (body.command === "deleteHost") {
        db.hosts = db.hosts.filter((item) => item.id !== id);
        markDeleted(db, "hosts", [id]);
        saveOptions.deletedHosts = [id];
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
  if (typeof req.body === "string") {
    if (Buffer.byteLength(req.body, "utf8") > MAX_BODY_BYTES) throw httpError(413, "Request body is too large.");
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      throw httpError(400, "Request body must be valid JSON.");
    }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

function actionFromRequest(req) {
  const url = new URL(req.url || "/", "https://minecraft-listing.iconrealms.net");
  if (url.pathname.endsWith("/sitemap.xml")) return "sitemap";
  return req.query?.action || url.searchParams.get("action") || "state";
}

function applySecurityHeaders(req, res) {
  const origin = requestOrigin(req);
  const allowOrigin = allowedOrigins().has(origin) ? origin : CONFIG.site.url;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-IconListing-Token, X-Icon-Listing-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store");
}

function requireAllowedMethod(action, method = "GET") {
  const next = String(method || "GET").toUpperCase();
  if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action)) throw httpError(404, "Unknown action.");
  if (READ_ACTIONS.has(action) && next !== "GET") throw httpError(405, "Method not allowed.");
  if (WRITE_ACTIONS.has(action) && next !== "POST") throw httpError(405, "Method not allowed.");
}

function enforceBrowserOrigin(req, action) {
  if (!WRITE_ACTIONS.has(action)) return;
  const origin = requestOrigin(req);
  if (!origin) return;
  if (!allowedOrigins().has(origin)) throw httpError(403, "Request origin is not allowed.");
}

function requestOrigin(req) {
  return String(req.headers?.origin || req.headers?.Origin || "").replace(/\/$/, "");
}

function allowedOrigins() {
  const origins = [
    CONFIG.site.url,
    apiOrigin(CONFIG.api?.productionBasePath),
    apiOrigin(CONFIG.api?.basePath),
    process.env.ALLOWED_ORIGINS
  ]
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim().replace(/\/$/, ""))
    .filter((item) => item.startsWith("https://") || item.startsWith("http://localhost") || item.startsWith("http://127.0.0.1"));
  return new Set(origins);
}

function apiOrigin(value = "") {
  try {
    return new URL(value, CONFIG.site.url).origin;
  } catch {
    return "";
  }
}

function freshDb() {
  return { version: 2, users: [], servers: [], clients: [], hosts: [], votes: [], voteIps: {}, deleted: { users: {}, servers: {}, clients: {}, hosts: {} } };
}

function migrateDb(db = freshDb()) {
  return {
    ...freshDb(),
    ...db,
    version: 2,
    users: Array.isArray(db.users) ? db.users : [],
    servers: Array.isArray(db.servers) ? db.servers.filter((server) => !String(server.id || "").startsWith("seed-")).map(normalizeServer) : [],
    clients: Array.isArray(db.clients) ? db.clients.filter((client) => !String(client.id || "").startsWith("client-")).map(normalizeClient) : [],
    hosts: Array.isArray(db.hosts) ? db.hosts.filter((host) => !String(host.id || "").startsWith("host-")).map(normalizeHost) : [],
    votes: Array.isArray(db.votes) ? db.votes : [],
    voteIps: db.voteIps && !Array.isArray(db.voteIps) ? db.voteIps : {},
    deleted: normalizeDeleted(db.deleted)
  };
}

function normalizeServer(server) {
  const edition = ["java", "bedrock"].includes(server.edition) ? server.edition : "java";
  const bedrockType = ["server", "realm"].includes(server.bedrockType) ? server.bedrockType : "server";
  return {
    ...server,
    edition,
    bedrockType,
    crossPlay: edition === "java" && !!server.crossPlay,
    realmCode: server.realmCode || "",
    iconListingPluginEnabled: !!server.iconListingPluginEnabled,
    iconListingVoteKey: cleanVoteKey(server.iconListingVoteKey || ""),
    iconListingVoteQueue: normalizeIconListingVoteQueue(server.iconListingVoteQueue),
    analytics: normalizeAnalytics(server.analytics)
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

function normalizeHost(host) {
  const images = Array.isArray(host.images) ? host.images : [host.imageUrl1, host.imageUrl2, host.imageUrl3, host.logoUrl].filter(Boolean);
  return {
    ...host,
    url: host.url || host.websiteUrl || "",
    images: images.filter(Boolean).slice(0, 3),
    pricing: "paid"
  };
}

function normalizeDeleted(deleted = {}) {
  return {
    users: normalizeDeletedMap(deleted.users),
    servers: normalizeDeletedMap(deleted.servers),
    clients: normalizeDeletedMap(deleted.clients),
    hosts: normalizeDeletedMap(deleted.hosts)
  };
}

function normalizeDeletedMap(value = {}) {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.filter(Boolean).map((id) => [String(id), new Date().toISOString()]));
  }
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([id]) => id).map(([id, deletedAt]) => [String(id), String(deletedAt || new Date().toISOString())]));
}

async function loadDb(options = {}) {
  if (!options.allowRecoveryOnly) requireConfiguredProductionDb();
  if (hasGithubStorage()) return mergeDurableDb(await readGithubDb({ bypassCache: !!options.forceFresh }), await readGithubBackupDb({ bypassCache: !!options.forceFresh }), await readRecoveryDb());
  if (process.env.VERCEL && options.allowRecoveryOnly) return readRecoveryDb();
  try {
    return mergeDurableDb(parseDbFromStorage(await fs.readFile(TMP_DB, "utf8")), await readLocalBackupDb(), await readRecoveryDb());
  } catch {
    return mergeDurableDb(freshDb(), await readLocalBackupDb(), await readRecoveryDb());
  }
}

async function saveDb(db, options = {}) {
  requireConfiguredProductionDb();
  if (hasGithubStorage()) {
    await writeGithubDb(db, options);
    return;
  }
  await writeLocalBackup();
  const serialized = serializeDbForStorage(db);
  await fs.writeFile(TMP_DB, serialized);
  await fs.writeFile(TMP_DB_BACKUP, serialized);
}

async function readLocalBackupDb() {
  try {
    return parseDbFromStorage(await fs.readFile(TMP_DB_BACKUP, "utf8"));
  } catch {
    return freshDb();
  }
}

let recoveryDbCache = { data: null, loadedAt: 0 };

async function readRecoveryDb() {
  if (recoveryDbCache.data && Date.now() - recoveryDbCache.loadedAt < 2000) return cloneJson(recoveryDbCache.data);
  try {
    const db = parseDbFromStorage(await fs.readFile(RECOVERY_DB_PATH, "utf8"));
    recoveryDbCache = { data: db, loadedAt: Date.now() };
    return cloneJson(db);
  } catch {
    return freshDb();
  }
}

function mergeRecoveryDb(primaryDb, recoveryDb) {
  const primary = migrateDb(primaryDb);
  const recovery = migrateDb(recoveryDb);
  const deleted = mergeDeleted(primary.deleted, recovery.deleted);
  if (!hasAnyStoredData(recovery)) return migrateDb({ ...primary, deleted });
  const servers = mergeServersWithRecovery(primary.servers, recovery.servers, deleted.servers);
  return migrateDb({
    ...primary,
    deleted,
    users: mergeUsersWithRecovery(primary.users, recovery.users, deleted.users),
    servers,
    clients: mergeClientsWithRecovery(primary.clients, recovery.clients, deleted.clients),
    hosts: mergeHostsWithRecovery(primary.hosts, recovery.hosts, deleted.hosts),
    votes: mergeVotesWithRecovery(primary.votes, recovery.votes, servers, deleted.servers),
    voteIps: pruneDeletedVoteIps(mergeVoteIps(recovery.voteIps, primary.voteIps), deleted.servers)
  });
}

function mergeDurableDb(primaryDb, ...fallbackDbs) {
  return fallbackDbs.reduce((merged, fallback) => mergeRecoveryDb(merged, fallback), migrateDb(primaryDb));
}

function mergeDeleted(...deletedItems) {
  const merged = normalizeDeleted();
  for (const deleted of deletedItems) {
    const normalized = normalizeDeleted(deleted);
    for (const kind of ["users", "servers", "clients", "hosts"]) {
      merged[kind] = { ...merged[kind], ...normalized[kind] };
    }
  }
  return merged;
}

function markDeleted(db, kind, ids = []) {
  db.deleted = normalizeDeleted(db.deleted);
  const now = new Date().toISOString();
  for (const id of ids.filter(Boolean)) db.deleted[kind][id] = now;
}

function mergeUsersWithRecovery(primaryUsers = [], recoveryUsers = [], deletedUsers = {}) {
  const merged = [...primaryUsers];
  for (const user of recoveryUsers) {
    if (!user?.id) continue;
    if (deletedUsers[user.id]) continue;
    const exists = merged.some((item) => item.id === user.id || same(item.username, user.username) || same(item.email, user.email));
    if (!exists) merged.push(user);
  }
  return merged;
}

function mergeServersWithRecovery(primaryServers = [], recoveryServers = [], deletedServers = {}) {
  const merged = [...primaryServers];
  for (const server of recoveryServers) {
    if (!server?.id) continue;
    if (deletedServers[server.id]) continue;
    const recoveryKeys = new Set(serverAddressKeys(server));
    const recoveryDescription = comparableText(server.description);
    const exists = merged.some((item) => (
      item.id === server.id ||
      comparableText(item.name) === comparableText(server.name) ||
      (recoveryDescription && comparableText(item.description) === recoveryDescription) ||
      serverAddressKeys(item).some((key) => recoveryKeys.has(key))
    ));
    if (!exists) merged.push(server);
  }
  return merged;
}

function mergeClientsWithRecovery(primaryClients = [], recoveryClients = [], deletedClients = {}) {
  const merged = [...primaryClients];
  for (const client of recoveryClients) {
    if (!client?.id && !client?.name) continue;
    if (client.id && deletedClients[client.id]) continue;
    const exists = merged.some((item) => item.id === client.id || same(item.name, client.name) || same(item.url, client.url));
    if (!exists) merged.push(client);
  }
  return merged;
}

function mergeHostsWithRecovery(primaryHosts = [], recoveryHosts = [], deletedHosts = {}) {
  const merged = [...primaryHosts];
  for (const host of recoveryHosts) {
    if (!host?.id && !host?.name) continue;
    if (host.id && deletedHosts[host.id]) continue;
    const exists = merged.some((item) => item.id === host.id || same(item.name, host.name) || same(item.url, host.url));
    if (!exists) merged.push(host);
  }
  return merged;
}

function mergeVotesWithRecovery(primaryVotes = [], recoveryVotes = [], servers = [], deletedServers = {}) {
  const serverIds = new Set(servers.map((server) => server.id));
  const merged = new Map();
  for (const vote of recoveryVotes) {
    if (vote?.id && serverIds.has(vote.serverId) && !deletedServers[vote.serverId]) merged.set(vote.id, vote);
  }
  for (const vote of primaryVotes) {
    if (vote?.id && serverIds.has(vote.serverId) && !deletedServers[vote.serverId]) merged.set(vote.id, vote);
  }
  return [...merged.values()];
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
  const response = await fetch(githubDbUrl(true, options), { headers: githubReadHeaders() });
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
  const latest = mergeDurableDb(await readGithubDb({ bypassCache: true }), await readGithubBackupDb({ bypassCache: true }), await readRecoveryDb());
  ensureRequiredRecordsExist(latest, options);
  normalized = mergeDbForWrite(latest, normalized, options);
  ensureWriteDoesNotLoseData(latest, normalized, options);
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
  await writeGithubBackup(normalized);
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
    const backupPath = githubBackupPath();
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

async function readGithubBackupDb(options = {}) {
  try {
    const payload = await readGithubFile(githubBackupPath(), options);
    if (!payload.content) return freshDb();
    const content = Buffer.from(String(payload.content || "").replace(/\n/g, ""), "base64").toString("utf8");
    return parseDbFromStorage(content);
  } catch {
    return freshDb();
  }
}

async function readGithubFile(filePath, options = {}) {
  const response = await fetch(githubFileUrl(filePath, true, options), { headers: githubReadHeaders() });
  if (response.status === 404) return { sha: null, content: "" };
  if (!response.ok) throw new Error(`GitHub file read failed (${response.status}).`);
  return response.json();
}

function githubBackupPath() {
  return process.env.GITHUB_DB_BACKUP_PATH || backupPathFor(githubDbPath());
}

function mergeDbForWrite(remoteDb, nextDb, options = {}) {
  const remote = migrateDb(remoteDb);
  const next = migrateDb(nextDb);
  const ids = writeIdSets(options);
  const merged = {
    ...next,
    deleted: mergeDeleted(remote.deleted, next.deleted, deletedFromIdSets(ids)),
    users: mergeById(remote.users, next.users, ids.deletedUsers, ids.touchedUsers),
    servers: mergeById(remote.servers, next.servers, ids.deletedServers, ids.touchedServers),
    clients: mergeById(remote.clients, next.clients, ids.deletedClients, ids.touchedClients),
    hosts: mergeById(remote.hosts, next.hosts, ids.deletedHosts, ids.touchedHosts),
    votes: mergeVotes(remote.votes, next.votes, ids.deletedServers, ids.touchedVotes, ids.touchedServers),
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
  const missingHost = (options.requireExistingHosts || []).find((id) => !remote.hosts.some((item) => item.id === id));
  if (missingServer || missingUser || missingClient || missingHost) throw httpError(409, "Storage changed before this action finished. Please refresh and try again.");
}

function ensureWriteDoesNotLoseData(remoteDb, nextDb, options = {}) {
  const remote = migrateDb(remoteDb);
  const next = migrateDb(nextDb);
  const ids = writeIdSets(options);
  assertNoUnexpectedLoss("server", remote.servers, next.servers, ids.deletedServers);
  assertNoUnexpectedLoss("user", remote.users, next.users, ids.deletedUsers);
  assertNoUnexpectedLoss("client", remote.clients, next.clients, ids.deletedClients);
  assertNoUnexpectedLoss("host", remote.hosts, next.hosts, ids.deletedHosts);
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
  const deleted = normalizeDeleted(db.deleted);
  return !!(
    db.users.length ||
    db.servers.length ||
    db.clients.length ||
    db.hosts.length ||
    db.votes.length ||
    Object.keys(db.voteIps || {}).length ||
    Object.values(deleted).some((items) => Object.keys(items).length)
  );
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
    deletedHosts: new Set(options.deletedHosts || []),
    touchedUsers: new Set(options.touchedUsers || []),
    touchedServers: new Set(options.touchedServers || []),
    touchedClients: new Set(options.touchedClients || []),
    touchedHosts: new Set(options.touchedHosts || []),
    touchedVotes: new Set(options.touchedVotes || [])
  };
}

function deletedFromIdSets(ids) {
  const now = new Date().toISOString();
  return normalizeDeleted({
    users: Object.fromEntries([...ids.deletedUsers].map((id) => [id, now])),
    servers: Object.fromEntries([...ids.deletedServers].map((id) => [id, now])),
    clients: Object.fromEntries([...ids.deletedClients].map((id) => [id, now])),
    hosts: Object.fromEntries([...ids.deletedHosts].map((id) => [id, now]))
  });
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

function mergeVotes(remoteVotes = [], nextVotes = [], deletedServerIds = new Set(), touchedVoteIds = new Set(), touchedServerIds = new Set()) {
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
    if (remoteIds.has(vote?.id) || touchedVoteIds.has(vote?.id) || touchedServerIds.has(vote?.serverId)) add(vote);
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

function pruneDeletedVoteIps(voteIps = {}, deletedServers = {}) {
  const merged = cloneJson(voteIps || {});
  for (const serverId of Object.keys(deletedServers || {})) delete merged[serverId];
  return merged;
}

function githubDbUrl(includeRef, options = {}) {
  return githubFileUrl(githubDbPath(), includeRef, options);
}

function githubDbPath() {
  return process.env.GITHUB_DB_PATH || "data/icon-listing-db.json";
}

function backupPathFor(filePath) {
  const parsed = path.posix.parse(filePath.replace(/\\/g, "/"));
  return path.posix.join(parsed.dir, `${parsed.name}.backup${parsed.ext || ".json"}`);
}

function githubFileUrl(filePath, includeRef, options = {}) {
  const contentPath = encodeURIComponent(filePath).replace(/%2F/g, "/");
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${contentPath}`;
  if (!includeRef) return base;
  const params = new URLSearchParams({ ref: githubBranch() });
  if (options.bypassCache) params.set("_", String(Date.now()));
  return `${base}?${params.toString()}`;
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

function githubReadHeaders() {
  return {
    ...githubHeaders(),
    "cache-control": "no-cache"
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

function statePayload(db, user, options = {}) {
  const detailServerId = clean(options.detailServerId || "");
  return {
    servers: rankServers(db.servers, db.votes).map((server) => publicServer(server, user, { fullAnalytics: server.id === detailServerId })),
    clients: db.clients,
    hosts: db.hosts,
    votes: detailServerId ? publicVotesForServer(db.votes, detailServerId) : [],
    user: publicUser(user)
  };
}

function stateDetailServerId(req) {
  const url = new URL(req.url || "/", "https://minecraft-listing.iconrealms.net");
  return clean(req.query?.serverId || req.query?.server || url.searchParams.get("serverId") || url.searchParams.get("id") || url.searchParams.get("server") || "");
}

function siteUrl(pathname = "/") {
  const base = String(CONFIG.site.url || "https://minecraft-listing.iconrealms.net").replace(/\/$/, "");
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
    { loc: siteUrl("/sponsored-hosts/"), priority: "0.7", changefreq: "weekly" },
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
  const ping = server.edition === "bedrock" ? await pingBedrock(server) : await pingJava(server.javaHost, server.javaPort);
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
  server.analytics = normalizeAnalytics(server.analytics || {});
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
  server.analytics.playerHistory = compactPlayerHistory(server.analytics.playerHistory);
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

async function pingBedrock(server) {
  if (server.bedrockType === "realm") {
    return { online: false, playersOnline: 0, playersMax: 0, version: "Bedrock Realm" };
  }
  try {
    const target = `${server.bedrockHost}:${Number(server.bedrockPort || CONFIG.defaults.bedrockPort)}`;
    const response = await fetch(`https://api.mcstatus.io/v2/status/bedrock/${encodeURIComponent(target)}`);
    if (!response.ok) throw new Error("mcstatus bedrock request failed");
    const data = await response.json();
    return {
      online: !!data.online,
      playersOnline: Number(data.players?.online || 0),
      playersMax: Number(data.players?.max || 0),
      version: data.version?.name_clean || data.version?.name_raw || data.version?.name || "Bedrock"
    };
  } catch {
    return { online: false, playersOnline: 0, playersMax: 0, version: "Bedrock" };
  }
}

async function sendVotifierVote(server, minecraftUsername) {
  return sendVotifierPayload({
    host: server.votifierHost || server.javaHost || server.bedrockHost,
    port: Number(server.votifierPort || 8192),
    token: server.votifierToken,
    minecraftUsername,
    serviceName: CONFIG.site.name,
    serverId: server.id
  });
}

async function deliverVoteRewards(server, minecraftUsername) {
  const deliveries = { votifier: "skipped", iconListingPlugin: server.iconListingPluginEnabled && server.iconListingVoteKey ? "queued" : "skipped" };
  if (!server.votifierEnabled) return deliveries;
  try {
    await sendVotifierVote(server, minecraftUsername);
    deliveries.votifier = "sent";
  } catch (error) {
    deliveries.votifier = "failed";
    console.error("Icon Listing Votifier delivery failed", {
      serverId: server.id,
      serverName: server.name,
      message: error.message
    });
  }
  return deliveries;
}

async function sendVotifierPayload(payload) {
  if (!CONFIG.votifier.providerEndpoint) {
    throw httpError(400, "Set votifier.providerEndpoint in config.js before sending Votifier votes.");
  }
  requireFields(payload, ["host", "port", "token", "minecraftUsername"]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOTIFIER_TIMEOUT_MS);
  try {
    const response = await fetch(CONFIG.votifier.providerEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) throw httpError(502, "The Votifier provider rejected the vote.");
    return { ok: true, message: "Votifier vote sent." };
  } finally {
    clearTimeout(timeout);
  }
}

function validateServer(server) {
  const edition = server.edition === "bedrock" ? "bedrock" : "java";
  const bedrockType = server.bedrockType === "realm" ? "realm" : "server";
  const next = {
    id: clean(server.id),
    name: cleanText(server.name),
    edition,
    javaHost: edition === "java" ? cleanText(server.javaHost) : "",
    javaPort: Number(server.javaPort || CONFIG.defaults.javaPort),
    crossPlay: edition === "java" && !!server.crossPlay,
    bedrockType,
    bedrockHost: cleanText(server.bedrockHost),
    bedrockPort: Number(server.bedrockPort || CONFIG.defaults.bedrockPort),
    realmCode: cleanText(server.realmCode),
    votifierEnabled: !!server.votifierEnabled,
    votifierHost: cleanText(server.votifierHost),
    votifierPort: Number(server.votifierPort || 8192),
    votifierToken: cleanText(server.votifierToken),
    iconListingPluginEnabled: !!server.iconListingPluginEnabled,
    iconListingVoteKey: cleanVoteKey(server.iconListingVoteKey),
    websiteUrl: clean(server.websiteUrl),
    discordUrl: clean(server.discordUrl),
    youtubeUrl: clean(server.youtubeUrl),
    country: cleanText(server.country),
    bannerUrl: clean(server.bannerUrl),
    description: cleanText(server.description),
    tags: Array.isArray(server.tags) ? server.tags.filter((tag) => allTags().includes(tag)).slice(0, CONFIG.limits.tagsMax) : []
  };
  if (!next.name) throw httpError(400, "Server name is required.");
  if (next.edition === "java" && !next.javaHost) throw httpError(400, "Java host is required.");
  if (next.edition === "java" && next.crossPlay && !next.bedrockHost) throw httpError(400, "Bedrock host is required for cross-play listings.");
  if (next.edition === "bedrock" && next.bedrockType === "server" && !next.bedrockHost) throw httpError(400, "Bedrock server IP or host is required.");
  if (next.edition === "bedrock" && next.bedrockType === "realm" && !next.realmCode) throw httpError(400, "Realm code is required.");
  if (hasBlockedText(server.name) || hasBlockedText(server.description)) throw httpError(400, "Please remove blocked words from the listing.");
  if (next.iconListingVoteKey && !isValidVoteKey(next.iconListingVoteKey)) throw httpError(400, "IconListing vote key must be 12-96 characters using letters, numbers, dots, dashes, underscores, or colons.");
  if (next.description.length < CONFIG.limits.descriptionMinLength) throw httpError(400, `Description must be at least ${CONFIG.limits.descriptionMinLength} characters.`);
  if (next.tags.length < CONFIG.limits.tagsMin || next.tags.length > CONFIG.limits.tagsMax) throw httpError(400, `Select ${CONFIG.limits.tagsMin} to ${CONFIG.limits.tagsMax} tags.`);
  if (!CONFIG.countries.includes(next.country)) throw httpError(400, "Select a valid country.");
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

function ensureUniqueVoteKey(db, server, currentId = "") {
  const key = cleanVoteKey(server.iconListingVoteKey);
  if (!key) return;
  for (const existing of db.servers || []) {
    if (existing.id && existing.id === currentId) continue;
    if (sameVoteKey(existing.iconListingVoteKey, key)) {
      throw httpError(409, "That IconListing vote plugin key is already being used.");
    }
  }
}

function createUniqueVoteKey(db, currentId = "") {
  for (let tries = 0; tries < 20; tries += 1) {
    const key = `ilv_${crypto.randomBytes(18).toString("hex")}`;
    if (!(db.servers || []).some((server) => server.id !== currentId && sameVoteKey(server.iconListingVoteKey, key))) return key;
  }
  throw httpError(500, "Could not generate a unique vote plugin key.");
}

function cleanVoteKey(value = "") {
  return clean(value).replace(/\s+/g, "");
}

function sameVoteKey(a = "", b = "") {
  return cleanVoteKey(a).toLowerCase() === cleanVoteKey(b).toLowerCase();
}

function isValidVoteKey(value = "") {
  return /^[A-Za-z0-9._:-]{12,96}$/.test(cleanVoteKey(value));
}

function comparableText(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function serverAddressKeys(server) {
  return [
    server.edition !== "bedrock" ? hostPortKey(server.javaHost, server.javaPort, CONFIG.defaults.javaPort) : "",
    server.edition === "bedrock" || server.crossPlay || server.bedrockHost ? hostPortKey(server.bedrockHost, server.bedrockPort, CONFIG.defaults.bedrockPort) : "",
    server.edition === "bedrock" && server.bedrockType === "realm" ? `realm:${comparableText(server.realmCode)}` : ""
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

function sanitizeHost(host) {
  const images = Array.isArray(host.images)
    ? host.images
    : [host.imageUrl1, host.imageUrl2, host.imageUrl3, host.logoUrl].filter(Boolean);
  const next = {
    id: clean(host.id),
    name: cleanText(host.name),
    url: clean(host.url || host.websiteUrl),
    youtubeUrl: clean(host.youtubeUrl),
    description: cleanText(host.description),
    images: images.map(clean).filter(Boolean).slice(0, 3),
    pricing: "paid"
  };
  if (!next.name) throw httpError(400, "Host name is required.");
  if (!next.url) throw httpError(400, "Website link is required.");
  if (hasBlockedText(host.name) || hasBlockedText(host.description)) throw httpError(400, "Please remove blocked words from the host listing.");
  if (next.description.length < CONFIG.limits.descriptionMinLength) throw httpError(400, `Host description must be at least ${CONFIG.limits.descriptionMinLength} characters.`);
  return next;
}

function votesForServer(votes, serverId) {
  return votes.filter((vote) => vote.serverId === serverId);
}

function publicVotesForServer(votes = [], serverId = "") {
  const month = new Date().toISOString().slice(0, 7);
  return votesForServer(votes, serverId)
    .filter((vote) => String(vote.createdAt || "").startsWith(month))
    .map((vote) => ({
      serverId: vote.serverId,
      minecraftUsername: vote.minecraftUsername,
      createdAt: vote.createdAt
    }));
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

function publicServer(server, user = null, options = {}) {
  const canSeePrivate = !!user && (server.ownerId === user.id || isAdmin(user));
  const next = { ...server, analytics: publicAnalytics(server, { full: !!options.fullAnalytics }) };
  delete next.iconListingVoteQueue;
  if (!canSeePrivate) {
    delete next.votifierToken;
    delete next.iconListingVoteKey;
  }
  return next;
}

function normalizeIconListingVoteQueue(queue = []) {
  if (!Array.isArray(queue)) return [];
  return queue
    .filter((item) => item?.id && item?.minecraftUsername)
    .map((item) => ({
      id: clean(item.id),
      voteId: clean(item.voteId),
      serverId: clean(item.serverId),
      serverName: cleanText(item.serverName),
      minecraftUsername: cleanText(item.minecraftUsername),
      createdAt: cleanText(item.createdAt),
      deliveredAt: cleanText(item.deliveredAt)
    }))
    .slice(-500);
}

function queueIconListingPluginVote(server, vote) {
  if (!server.iconListingPluginEnabled || !server.iconListingVoteKey) return;
  server.iconListingVoteQueue = normalizeIconListingVoteQueue(server.iconListingVoteQueue);
  server.iconListingVoteQueue.push({
    id: createId(),
    voteId: vote.id,
    serverId: server.id,
    serverName: server.name,
    minecraftUsername: vote.minecraftUsername,
    createdAt: vote.createdAt,
    deliveredAt: ""
  });
  server.iconListingVoteQueue = server.iconListingVoteQueue.slice(-500);
}

function iconListingPluginPendingVotes(server) {
  return normalizeIconListingVoteQueue(server.iconListingVoteQueue).filter((vote) => !vote.deliveredAt);
}

function acknowledgeIconListingPluginVotes(server, ackIds = []) {
  if (!ackIds.length) return false;
  const ids = new Set(ackIds.map(clean).filter(Boolean));
  let changed = false;
  const now = new Date().toISOString();
  server.iconListingVoteQueue = normalizeIconListingVoteQueue(server.iconListingVoteQueue)
    .map((vote) => {
      if (ids.has(vote.id) && !vote.deliveredAt) {
        changed = true;
        return { ...vote, deliveredAt: now };
      }
      return vote;
    })
    .filter((vote) => !vote.deliveredAt || Date.now() - new Date(vote.deliveredAt).getTime() < 7 * 24 * 60 * 60 * 1000)
    .slice(-500);
  return changed;
}

function publicIconListingPluginVote(vote) {
  return {
    id: vote.id,
    voteId: vote.voteId,
    serverId: vote.serverId,
    serverName: vote.serverName,
    minecraftUsername: vote.minecraftUsername,
    createdAt: vote.createdAt
  };
}

function isBlockedServerHost(host = "") {
  const value = String(host || "").trim().toLowerCase();
  if (!value) return false;
  return (CONFIG.moderation?.blockedServerHosts || []).some((blocked) => {
    const next = String(blocked || "").trim().toLowerCase();
    return value === next || value.endsWith(`.${next}`) || value.includes(next);
  });
}

function publicAnalytics(server, options = {}) {
  const analytics = normalizeAnalytics(server.analytics || {});
  const result = {
    ipCopiesLast7: countDailyCopies(analytics.ipCopyDaily, 7),
    ipCopiesLast30: countDailyCopies(analytics.ipCopyDaily, ANALYTICS_DAYS)
  };
  if (options.full) {
    result.ipCopyDaily = denseDailyCopies(analytics.ipCopyDaily, ANALYTICS_DAYS);
    result.playerHistory = compactPlayerHistory(analytics.playerHistory);
  }
  return result;
}

function normalizeAnalytics(analytics = {}) {
  const daily = new Map();
  const visitorDays = normalizeIpCopyVisitorDays(analytics.ipCopyVisitorDays);
  for (const item of Array.isArray(analytics.ipCopyDaily) ? analytics.ipCopyDaily : []) {
    const date = dateKey(item.date);
    if (date) daily.set(date, Math.max(Number(daily.get(date) || 0), Number(item.count || 0)));
  }
  for (const copy of Array.isArray(analytics.ipCopies) ? analytics.ipCopies : []) {
    const date = dateKey(copy.createdAt);
    if (!date || !isRecentDateKey(date, ANALYTICS_DAYS)) continue;
    const hash = shortVisitorHash(copy.visitorHash || "");
    const visitors = visitorDays[date] || [];
    if (hash && !visitors.includes(hash)) {
      if (visitors.length < COPY_HASHES_PER_DAY_LIMIT) visitors.push(hash);
      visitorDays[date] = visitors;
      daily.set(date, Number(daily.get(date) || 0) + 1);
    }
  }
  pruneVisitorDays(visitorDays);
  return {
    ipCopyDaily: sparseDailyCopies(daily, ANALYTICS_DAYS),
    ipCopyVisitorDays: visitorDays,
    playerHistory: compactPlayerHistory(analytics.playerHistory)
  };
}

function normalizeIpCopyVisitorDays(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next = {};
  for (const [date, hashes] of Object.entries(value)) {
    const key = dateKey(date);
    if (!key || !isRecentDateKey(key, ANALYTICS_DAYS) || !Array.isArray(hashes)) continue;
    const unique = [...new Set(hashes.map(shortVisitorHash).filter(Boolean))].slice(0, COPY_HASHES_PER_DAY_LIMIT);
    if (unique.length) next[key] = unique;
  }
  return next;
}

function recordIpCopy(server, req) {
  const analytics = normalizeAnalytics(server.analytics || {});
  const date = new Date().toISOString().slice(0, 10);
  const visitorHash = shortVisitorHash(clientHash(req));
  const visitors = analytics.ipCopyVisitorDays[date] || [];
  const alreadyCounted = visitorHash && visitors.includes(visitorHash);
  if (!alreadyCounted) {
    if (visitorHash && visitors.length < COPY_HASHES_PER_DAY_LIMIT) visitors.push(visitorHash);
    analytics.ipCopyVisitorDays[date] = visitors;
    const daily = new Map(analytics.ipCopyDaily.map((item) => [item.date, Number(item.count || 0)]));
    daily.set(date, Number(daily.get(date) || 0) + 1);
    analytics.ipCopyDaily = sparseDailyCopies(daily, ANALYTICS_DAYS);
  }
  pruneVisitorDays(analytics.ipCopyVisitorDays);
  server.analytics = analytics;
}

function countDailyCopies(entries = [], days = ANALYTICS_DAYS) {
  return denseDailyCopies(entries, days).reduce((sum, item) => sum + Number(item.count || 0), 0);
}

function denseDailyCopies(entries = [], days = ANALYTICS_DAYS) {
  const counts = new Map((Array.isArray(entries) ? entries : []).map((item) => [dateKey(item.date), Number(item.count || 0)]).filter(([date]) => date));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.now() - (days - index - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return { date, count: Number(counts.get(date) || 0) };
  });
}

function sparseDailyCopies(counts, days = ANALYTICS_DAYS) {
  const map = counts instanceof Map ? counts : new Map((Array.isArray(counts) ? counts : []).map((item) => [dateKey(item.date), Number(item.count || 0)]).filter(([date]) => date));
  return [...map.entries()]
    .filter(([date, count]) => isRecentDateKey(date, days) && Number(count || 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count: Number(count || 0) }));
}

function compactPlayerHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => Number.isFinite(new Date(item.createdAt).getTime()))
    .map((item) => ({
      createdAt: new Date(item.createdAt).toISOString(),
      playersOnline: Number(item.playersOnline || 0),
      playersMax: Number(item.playersMax || 0),
      online: !!item.online
    }))
    .filter((item) => isRecentDateKey(item.createdAt.slice(0, 10), ANALYTICS_DAYS + 1))
    .slice(-PLAYER_HISTORY_LIMIT);
}

function pruneVisitorDays(visitorDays = {}) {
  for (const date of Object.keys(visitorDays)) {
    if (!isRecentDateKey(date, ANALYTICS_DAYS) || !visitorDays[date]?.length) delete visitorDays[date];
  }
}

function dateKey(value = "") {
  const date = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function isRecentDateKey(date, days) {
  const time = new Date(`${date}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(time)) return false;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return time >= cutoff;
}

function shortVisitorHash(hash = "") {
  return String(hash || "").replace(/[^a-f0-9]/gi, "").slice(0, 16);
}

function clientHash(req) {
  const forwarded = req.headers["x-forwarded-for"] || req.headers["X-Forwarded-For"] || "";
  const ip = String(forwarded).split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  const agent = req.headers["user-agent"] || req.headers["User-Agent"] || "";
  return crypto.createHmac("sha256", SESSION_SECRET).update(`${ip}|${agent}`).digest("hex");
}

function loginRateKey(req, login = "") {
  const account = clean(login).toLowerCase();
  return crypto.createHmac("sha256", SESSION_SECRET).update(`${clientHash(req)}|${account}`).digest("hex");
}

function enforceLoginRateLimit(req, login) {
  pruneLoginFailures();
  const entry = loginFailures.get(loginRateKey(req, login));
  if (entry && entry.count >= LOGIN_LIMIT_MAX_FAILURES) {
    throw httpError(429, "Too many login attempts. Please wait and try again.");
  }
}

function recordLoginFailure(req, login) {
  const key = loginRateKey(req, login);
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || now - entry.firstAt > LOGIN_LIMIT_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(req, login) {
  loginFailures.delete(loginRateKey(req, login));
}

function pruneLoginFailures() {
  const cutoff = Date.now() - LOGIN_LIMIT_WINDOW_MS;
  for (const [key, entry] of loginFailures.entries()) {
    if (!entry?.firstAt || entry.firstAt < cutoff) loginFailures.delete(key);
  }
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
    .map((server) => ({ ...server, votes: displayedVoteCount(server, votes) }))
    .sort((a, b) => scoreServer(b, votes) - scoreServer(a, votes))
    .map((server, index) => ({ ...server, rank: index + 1 }));
}

function scoreServer(server, votes) {
  const voteCount = displayedVoteCount(server, votes);
  return (server.playersOnline || 0) * CONFIG.ranking.playerWeight + voteCount * CONFIG.ranking.voteWeight + (server.sponsored ? CONFIG.ranking.sponsoredBoost : 0);
}

function displayedVoteCount(server, votes = []) {
  return Math.max(votesForServer(votes, server.id).length, Number(server.votes || 0));
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

function signToken(user) {
  const expires = Date.now() + 1000 * 60 * 60 * 24 * 14;
  const snapshot = typeof user === "object" && user ? user : { id: user };
  const payload = {
    v: 2,
    id: snapshot.id,
    username: snapshot.username || "",
    email: snapshot.email || "",
    expires
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", tokenSecrets()[0]).update(body).digest("hex");
  return `v2.${body}.${sig}`;
}

async function userFromRequest(req, db) {
  const token = tokenFromRequest(req);
  if (!token) return null;
  const session = verifyToken(token);
  if (!session) return null;
  const storedUser = db.users.find((item) => item.id === session.id && !item.banned);
  if (storedUser) return storedUser;
  if (!session.username && !session.email) return null;
  return {
    id: session.id,
    username: session.username,
    email: session.email,
    banned: false,
    fromTokenSnapshot: true
  };
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, email: user.email, admin: isAdmin(user), banned: !!user.banned };
}

function isAdmin(user) {
  return !!user && !user.fromTokenSnapshot && (CONFIG.admins.users.includes(user.username) || CONFIG.admins.emails.includes(user.email));
}

function tokenFromRequest(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  return clean(req.headers["x-iconlisting-token"] || req.headers["X-IconListing-Token"] || req.headers["x-icon-listing-token"] || req.headers["X-Icon-Listing-Token"] || bearer);
}

function verifyToken(token) {
  if (token.startsWith("v2.")) return verifySnapshotToken(token);
  return verifyLegacyToken(token);
}

function verifySnapshotToken(token) {
  const [, body, sig] = token.split(".");
  if (!body || !sig || !verifySignedBody(body, sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.id || !payload.expires || Date.now() > Number(payload.expires)) return null;
    return {
      id: String(payload.id),
      username: clean(payload.username || ""),
      email: clean(payload.email || ""),
      expires: Number(payload.expires)
    };
  } catch {
    return null;
  }
}

function verifyLegacyToken(token) {
  const [userId, expires, sig] = token.split(".");
  if (!userId || !expires || !sig || Date.now() > Number(expires)) return null;
  const body = `${userId}.${expires}`;
  if (!verifySignedBody(body, sig)) return null;
  return { id: userId, username: "", email: "", expires: Number(expires) };
}

function verifySignedBody(body, sig) {
  return tokenSecrets().some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
    return safeEqualHex(expected, sig);
  });
}

function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(String(left || ""), "hex");
    const b = Buffer.from(String(right || ""), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function tokenSecrets() {
  const secrets = [
    process.env.SESSION_SECRET,
    process.env.ICON_LISTING_SESSION_SECRET,
    process.env.DATABASE_ENCRYPTION_KEY,
    process.env.ICON_LISTING_DB_ENCRYPTION_KEY,
    process.env.GITHUB_TOKEN,
    SESSION_SECRET
  ].filter(Boolean);
  return [...new Set(secrets)];
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
