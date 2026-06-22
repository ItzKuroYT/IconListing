const CONFIG = window.ICON_LISTING_CONFIG;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const ALL_TAGS = [...CONFIG.gamemodes, ...CONFIG.generalTags];

function copy(path, fallback = "") {
  return path.split(".").reduce((value, key) => value?.[key], CONFIG.copy) ?? fallback;
}

const store = {
  get session() {
    try {
      return JSON.parse(localStorage.getItem("iconListingSession") || "null");
    } catch {
      return null;
    }
  },
  set session(value) {
    if (value) localStorage.setItem("iconListingSession", JSON.stringify(value));
    else localStorage.removeItem("iconListingSession");
  },
  get fallbackDb() {
    const saved = localStorage.getItem("iconListingDb");
    if (saved) return migrateDb(JSON.parse(saved));
    return freshDb();
  },
  set fallbackDb(value) {
    localStorage.setItem("iconListingDb", JSON.stringify(value));
  }
};

function freshDb() {
  return { version: 2, users: [], servers: [], clients: [], votes: [], voteIps: {} };
}

function migrateDb(db) {
  const next = {
    ...freshDb(),
    ...db,
    version: 2,
    users: Array.isArray(db.users) ? db.users : [],
    servers: Array.isArray(db.servers) ? db.servers.filter((server) => !String(server.id || "").startsWith("seed-")).map(normalizeServer) : [],
    clients: Array.isArray(db.clients) ? db.clients.filter((client) => !String(client.id || "").startsWith("client-")).map(normalizeClient) : [],
    votes: Array.isArray(db.votes) ? db.votes : [],
    voteIps: db.voteIps && !Array.isArray(db.voteIps) ? db.voteIps : {}
  };
  store.fallbackDb = next;
  return next;
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

function route(path) {
  return `${CONFIG.site.basePath || ""}${path}`;
}

function asset(path) {
  if (!path) return "";
  if (path.startsWith("data:") || path.startsWith("http://") || path.startsWith("https://")) return path;
  return route(path);
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function toast(message) {
  $(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  window.setTimeout(() => node.remove(), 3600);
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

function cleanText(value = "") {
  let next = String(value || "").trim();
  for (const regex of blockedRegexes()) {
    next = next.replace(regex, CONFIG.moderation?.replacement || "***");
  }
  return next;
}

function hasBlockedText(value = "") {
  return blockedRegexes().some((regex) => {
    regex.lastIndex = 0;
    return regex.test(String(value || ""));
  });
}

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isAdmin(user) {
  return !!user && (CONFIG.admins.users.includes(user.username) || CONFIG.admins.emails.includes(user.email));
}

function authHeaders() {
  return store.session?.token ? { Authorization: `Bearer ${store.session.token}` } : {};
}

function isLocalFallbackAllowed() {
  return !!CONFIG.api.useLocalFallback && (location.protocol === "file:" || (CONFIG.api.localFallbackHosts || []).includes(location.hostname));
}

function apiBasePaths() {
  return [...new Set([CONFIG.api.productionBasePath, CONFIG.api.basePath].filter(Boolean))];
}

function productionApiMessage() {
  return "Public listings are not connected yet. Set the production API URL and GitHub storage variables in Vercel so listings can be shared.";
}

async function request(action, payload = {}, method = "POST") {
  if (location.protocol !== "file:") {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), CONFIG.api.requestTimeoutMs);
    try {
      const options = {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        signal: controller.signal
      };
      if (method !== "GET") options.body = JSON.stringify(payload);
      let lastError = null;
      for (const basePath of apiBasePaths()) {
        try {
          const url = `${basePath}?action=${encodeURIComponent(action)}`;
          const response = await fetch(url, options);
          let json = null;
          try {
            json = await response.json();
          } catch {
            const body = await response.text().catch(() => "");
            throw new Error(response.ok ? `The API at ${url} returned an unreadable response.` : `${productionApiMessage()} (${response.status} from ${url})${body ? ` ${body.slice(0, 80)}` : ""}`);
          }
          if (!response.ok || json.error) throw new Error(json.error || `${productionApiMessage()} (${response.status} from ${url})`);
          return json;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error(productionApiMessage());
    } catch (error) {
      if (!isLocalFallbackAllowed()) throw error.message ? error : new Error(productionApiMessage());
    } finally {
      window.clearTimeout(timeout);
    }
  }
  return fallbackRequest(action, payload);
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, email: user.email, admin: isAdmin(user), banned: !!user.banned };
}

function fallbackUserFromSession() {
  const session = store.session;
  if (!session) return null;
  return store.fallbackDb.users.find((user) => user.id === session.user?.id && !user.banned) || null;
}

function fallbackRequest(action, payload) {
  const db = store.fallbackDb;
  const user = fallbackUserFromSession();
  const save = () => {
    store.fallbackDb = db;
  };

  if (action === "state") {
    return Promise.resolve({ servers: rankServers(db.servers, db.votes), clients: db.clients, user: publicUser(user), votes: db.votes });
  }
  if (action === "register") {
    if (!payload.username || !payload.email || !payload.password) return Promise.reject(new Error("Fill out every signup field."));
    if (hasBlockedText(payload.username)) return Promise.reject(new Error("That username is not allowed here."));
    const exists = db.users.some((item) => same(item.email, payload.email) || same(item.username, payload.username));
    if (exists) return Promise.reject(new Error("That username or email is already taken."));
    const next = { id: createId(), username: cleanText(payload.username), email: cleanText(payload.email), password: payload.password, banned: false };
    db.users.push(next);
    save();
    store.session = { token: `local-${next.id}`, user: publicUser(next) };
    return Promise.resolve({ user: publicUser(next), token: store.session.token });
  }
  if (action === "login") {
    const next = db.users.find((item) => (same(item.email, payload.login) || same(item.username, payload.login)) && item.password === payload.password && !item.banned);
    if (!next) return Promise.reject(new Error("That login did not match an account."));
    store.session = { token: `local-${next.id}`, user: publicUser(next) };
    return Promise.resolve({ user: publicUser(next), token: store.session.token });
  }
  if (action === "saveServer") {
    if (!user) return Promise.reject(new Error("Log in before adding a server."));
    const server = sanitizeServer(payload.server || {});
    const existing = db.servers.find((item) => item.id === server.id);
    if (existing && existing.ownerId !== user.id && !isAdmin(user)) return Promise.reject(new Error("You cannot edit that listing."));
    try {
      ensureUniqueServerListing(db, server, existing?.id || server.id);
    } catch (error) {
      return Promise.reject(error);
    }
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
      updatedAt: new Date().toISOString(),
      lastSuccessfulPingAt: existing?.lastSuccessfulPingAt || null,
      lastPingAt: existing?.lastPingAt || null
    };
    db.servers = existing ? db.servers.map((item) => (item.id === existing.id ? next : item)) : [...db.servers, next];
    save();
    return Promise.resolve({ server: { ...next, analytics: publicAnalytics(next) } });
  }
  if (action === "deleteServer") {
    if (!user) return Promise.reject(new Error("Log in before deleting a listing."));
    const server = db.servers.find((item) => item.id === payload.id);
    if (!server) return Promise.reject(new Error("Listing not found."));
    if (server.ownerId !== user.id && !isAdmin(user)) return Promise.reject(new Error("You cannot delete that listing."));
    db.servers = db.servers.filter((item) => item.id !== payload.id);
    db.votes = db.votes.filter((vote) => vote.serverId !== payload.id);
    if (db.voteIps) delete db.voteIps[payload.id];
    save();
    return Promise.resolve({ ok: true });
  }
  if (action === "vote") {
    const server = db.servers.find((item) => item.id === payload.serverId);
    const username = cleanText(payload.minecraftUsername || "");
    if (!server) return Promise.reject(new Error("Listing not found."));
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return Promise.reject(new Error("Enter a valid Minecraft username."));
    try {
      enforceVoteCooldown(db, server.id, username);
    } catch (error) {
      return Promise.reject(error);
    }
    const vote = { id: createId(), serverId: server.id, minecraftUsername: username, createdAt: new Date().toISOString() };
    db.votes.push(vote);
    recordVoteCooldown(db, server.id, username);
    server.votes = db.votes.filter((item) => item.serverId === server.id).length;
    save();
    return Promise.resolve({ ok: true, vote, server: { ...server, analytics: publicAnalytics(server) } });
  }
  if (action === "trackCopy") {
    const server = db.servers.find((item) => item.id === payload.serverId);
    if (!server) return Promise.reject(new Error("Listing not found."));
    if (!server.analytics) server.analytics = { ipCopies: [], playerHistory: [] };
    if (!server.analytics.ipCopies) server.analytics.ipCopies = [];
    const visitorHash = store.session?.user?.id || "local";
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    server.analytics.ipCopies = server.analytics.ipCopies.filter((copy) => new Date(copy.createdAt).getTime() >= cutoff);
    if (!server.analytics.ipCopies.some((copy) => copy.visitorHash === visitorHash)) {
      server.analytics.ipCopies.push({ visitorHash, createdAt: new Date().toISOString() });
    }
    save();
    return Promise.resolve({ ok: true, analytics: publicAnalytics(server) });
  }
  if (action === "accountUpdate") {
    if (!user) return Promise.reject(new Error("Log in before editing your account."));
    if (hasBlockedText(payload.username)) return Promise.reject(new Error("That username is not allowed here."));
    if (payload.username) user.username = cleanText(payload.username);
    if (payload.email) user.email = cleanText(payload.email);
    if (payload.password) user.password = payload.password;
    try {
      ensureUniqueUser(db, user, user.id);
    } catch (error) {
      return Promise.reject(error);
    }
    save();
    store.session = { ...store.session, user: publicUser(user) };
    return Promise.resolve({ user: publicUser(user) });
  }
  if (action === "deleteAccount") {
    if (!user) return Promise.reject(new Error("Log in before deleting your account."));
    if (payload.username !== user.username || payload.email !== user.email || payload.password !== user.password) {
      return Promise.reject(new Error("Those details do not match your account."));
    }
    db.users = db.users.filter((item) => item.id !== user.id);
    db.servers = db.servers.filter((item) => item.ownerId !== user.id);
    pruneVoteCooldowns(db);
    save();
    store.session = null;
    return Promise.resolve({ ok: true });
  }
  if (action === "testVote") {
    if (!CONFIG.votifier.providerEndpoint) {
      return Promise.reject(new Error("Set votifier.providerEndpoint in config.js before sending real test votes."));
    }
    return Promise.resolve({ ok: true, message: "Votifier is configured. The production API will send this test vote." });
  }
  if (action === "admin") {
    if (!isAdmin(user)) return Promise.reject(new Error("Admin access required."));
    const id = payload.value?.id;
    if (payload.command === "toggleSponsor") {
      const server = db.servers.find((item) => item.id === id);
      if (server) server.sponsored = !server.sponsored;
    }
    if (payload.command === "banUser") {
      const target = db.users.find((item) => item.id === id);
      if (target) target.banned = !target.banned;
    }
    if (payload.command === "deleteUser") {
      db.users = db.users.filter((item) => item.id !== id);
      db.servers = db.servers.filter((item) => item.ownerId !== id);
      pruneVoteCooldowns(db);
    }
    if (payload.command === "saveClient") {
      const client = sanitizeClient(payload.value || {});
      const existing = db.clients.find((item) => item.id === client.id);
      const next = { ...existing, ...client, id: existing?.id || client.id || createId(), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      db.clients = existing ? db.clients.map((item) => (item.id === existing.id ? next : item)) : [...db.clients, next];
    }
    if (payload.command === "deleteClient") {
      db.clients = db.clients.filter((item) => item.id !== id);
    }
    save();
    return Promise.resolve({ users: db.users.map(publicUser), servers: rankServers(db.servers, db.votes), clients: db.clients });
  }
  return Promise.reject(new Error("Unknown action."));
}

function sanitizeServer(server) {
  const tags = Array.isArray(server.tags) ? server.tags.filter((tag) => ALL_TAGS.includes(tag)).slice(0, CONFIG.limits.tagsMax) : [];
  const next = {
    id: cleanText(server.id),
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
    websiteUrl: cleanText(server.websiteUrl),
    discordUrl: cleanText(server.discordUrl),
    youtubeUrl: cleanText(server.youtubeUrl),
    country: cleanText(server.country),
    bannerUrl: String(server.bannerUrl || "").trim(),
    description: cleanText(server.description),
    tags
  };
  if (!next.name || !next.javaHost) throw new Error("Server name and Java host are required.");
  if (next.description.length < CONFIG.limits.descriptionMinLength) throw new Error(`Description must be at least ${CONFIG.limits.descriptionMinLength} characters.`);
  if (tags.length < CONFIG.limits.tagsMin || tags.length > CONFIG.limits.tagsMax) throw new Error(`Select ${CONFIG.limits.tagsMin} to ${CONFIG.limits.tagsMax} tags.`);
  if (isBlockedServerHost(next.javaHost) || isBlockedServerHost(next.bedrockHost)) throw new Error("FalixSrv and Aternos servers are not allowed on this listing site.");
  return next;
}

function ensureUniqueUser(db, user, currentId = "") {
  for (const existing of db.users || []) {
    if (existing.id && existing.id === currentId) continue;
    if (same(existing.username, user.username) || same(existing.email, user.email)) {
      throw new Error("That username or email is already taken.");
    }
  }
}

function isBlockedServerHost(host = "") {
  const value = String(host || "").trim().toLowerCase();
  if (!value) return false;
  return (CONFIG.moderation?.blockedServerHosts || []).some((blocked) => {
    const next = String(blocked || "").trim().toLowerCase();
    return value === next || value.endsWith(`.${next}`) || value.includes(next);
  });
}

function ensureUniqueServerListing(db, server, currentId = "") {
  const name = comparableText(server.name);
  const description = comparableText(server.description);
  const addresses = new Set(serverAddressKeys(server));
  for (const existing of db.servers || []) {
    if (existing.id && existing.id === currentId) continue;
    if (name && comparableText(existing.name) === name) throw new Error("A listing with that server name already exists.");
    if (description && comparableText(existing.description) === description) throw new Error("A listing with that description already exists.");
    if (serverAddressKeys(existing).some((key) => addresses.has(key))) throw new Error("A listing with that server IP already exists.");
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
  const images = Array.isArray(client.images) ? client.images : [client.imageUrl1, client.imageUrl2, client.logoUrl].filter(Boolean);
  const next = {
    id: cleanText(client.id),
    name: cleanText(client.name),
    description: cleanText(client.description),
    url: String(client.url || client.websiteUrl || "").trim(),
    youtubeUrl: String(client.youtubeUrl || "").trim(),
    images: images.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 2),
    version: ["java", "bedrock", "both"].includes(client.version) ? client.version : "both",
    pricing: ["free", "paid"].includes(client.pricing) ? client.pricing : "free"
  };
  if (!next.name) throw new Error("Client name is required.");
  if (!next.url) throw new Error("Website/download link is required.");
  if (hasBlockedText(client.name) || hasBlockedText(client.description)) throw new Error("Please remove blocked words from the client listing.");
  if (next.description.length < CONFIG.limits.descriptionMinLength) throw new Error(`Client description must be at least ${CONFIG.limits.descriptionMinLength} characters.`);
  return next;
}

function same(a = "", b = "") {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function votesForServer(votes, serverId) {
  return votes.filter((vote) => vote.serverId === serverId);
}

function voteCooldownMs() {
  return Number(CONFIG.limits?.voteCooldownHours || 24) * 60 * 60 * 1000;
}

function enforceVoteCooldown(db, serverId, minecraftUsername) {
  if (!db.voteIps) db.voteIps = {};
  const entries = db.voteIps[serverId] || {};
  const now = Date.now();
  const cooldown = voteCooldownMs();
  const lastVoteAt = voteCooldownKeys(minecraftUsername)
    .map((key) => entries[key])
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  if (lastVoteAt && now - lastVoteAt < cooldown) {
    throw new Error(`You can vote for this server again in ${formatDuration(cooldown - (now - lastVoteAt))}.`);
  }
}

function recordVoteCooldown(db, serverId, minecraftUsername) {
  if (!db.voteIps) db.voteIps = {};
  const entries = db.voteIps[serverId] || {};
  const now = new Date().toISOString();
  for (const key of voteCooldownKeys(minecraftUsername)) entries[key] = now;
  db.voteIps[serverId] = pruneVoteCooldownEntries(entries);
}

function voteCooldownKeys(minecraftUsername) {
  return [
    `visitor:${store.session?.user?.id || "local"}`,
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

function monthlyVotes(votes, serverId) {
  const key = monthKey();
  return votesForServer(votes, serverId).filter((vote) => String(vote.createdAt || "").startsWith(key));
}

function voteLeaderboard(votes, serverId) {
  const counts = new Map();
  monthlyVotes(votes, serverId).forEach((vote) => {
    const name = vote.minecraftUsername;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([minecraftUsername, votes]) => ({ minecraftUsername, votes }))
    .sort((a, b) => b.votes - a.votes || a.minecraftUsername.localeCompare(b.minecraftUsername))
    .slice(0, 10);
}

function scoreServer(server, votes = []) {
  const voteCount = votesForServer(votes, server.id).length || server.votes || 0;
  return (server.playersOnline || 0) * CONFIG.ranking.playerWeight + voteCount * CONFIG.ranking.voteWeight + (server.sponsored ? CONFIG.ranking.sponsoredBoost : 0);
}

function rankServers(servers, votes = []) {
  return [...servers]
    .map((server) => ({ ...server, votes: votesForServer(votes, server.id).length || server.votes || 0, analytics: publicAnalytics(server) }))
    .sort((a, b) => scoreServer(b, votes) - scoreServer(a, votes))
    .map((server, index) => ({ ...server, rank: index + 1 }));
}

async function getState() {
  const state = await request("state", {}, "GET");
  if (state.user && store.session) store.session = { ...store.session, user: state.user };
  return { ...state, votes: state.votes || [] };
}

function pageTitle(page) {
  return page.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function trimSeo(value = "", max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function absoluteUrl(path = "/") {
  const base = String(CONFIG.site.url || (location.origin && location.origin !== "null" ? location.origin : "")).replace(/\/$/, "");
  const next = String(path || "/");
  if (/^https?:\/\//i.test(next)) return next;
  if (!base) return route(next.startsWith("/") ? next : `/${next}`);
  return new URL(route(next.startsWith("/") ? next : `/${next}`), `${base}/`).href;
}

function upsertMeta(attribute, key, content) {
  if (!content) return;
  let node = document.head.querySelector(`meta[${attribute}="${key}"]`);
  if (!node) {
    node = document.createElement("meta");
    node.setAttribute(attribute, key);
    document.head.append(node);
  }
  node.setAttribute("content", content);
}

function upsertLink(rel, href) {
  if (!href) return;
  let node = document.head.querySelector(`link[rel="${rel}"]`);
  if (!node) {
    node = document.createElement("link");
    node.setAttribute("rel", rel);
    document.head.append(node);
  }
  node.setAttribute("href", href);
}

function upsertJsonLd(data) {
  if (!data) return;
  let node = document.head.querySelector("#seo-jsonld");
  if (!node) {
    node = document.createElement("script");
    node.id = "seo-jsonld";
    node.type = "application/ld+json";
    document.head.append(node);
  }
  node.textContent = JSON.stringify(data);
}

function setSeoMeta(options = {}) {
  const seo = CONFIG.seo || {};
  const title = trimSeo(options.title || seo.defaultTitle || `${CONFIG.site.name} | ${pageTitle(document.body.dataset.page || "home")}`, 59);
  const description = trimSeo(options.description || seo.defaultDescription || copy("home.body", ""), 158);
  const canonical = absoluteUrl(options.path || location.pathname || "/");
  const image = absoluteUrl(options.image || CONFIG.site.iconPath || "/assets/icon.png");
  const keywords = [...new Set([...(seo.keywords || []), ...(options.keywords || [])].filter(Boolean))].join(", ");
  document.title = title;
  upsertMeta("name", "description", description);
  upsertMeta("name", "robots", "index, follow, max-image-preview:large");
  upsertMeta("name", "keywords", keywords);
  upsertMeta("name", "application-name", CONFIG.site.name);
  upsertMeta("name", "theme-color", CONFIG.theme?.colors?.purple || "#8b5cf6");
  upsertLink("canonical", canonical);
  upsertMeta("property", "og:site_name", CONFIG.site.name);
  upsertMeta("property", "og:type", options.type || "website");
  upsertMeta("property", "og:title", title);
  upsertMeta("property", "og:description", description);
  upsertMeta("property", "og:url", canonical);
  upsertMeta("property", "og:image", image);
  upsertMeta("name", "twitter:card", "summary_large_image");
  upsertMeta("name", "twitter:title", title);
  upsertMeta("name", "twitter:description", description);
  upsertMeta("name", "twitter:image", image);
  upsertJsonLd(options.jsonLd || {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: CONFIG.site.name,
    url: absoluteUrl("/"),
    description,
    potentialAction: {
      "@type": "SearchAction",
      target: `${absoluteUrl("/servers/")}?q={search_term_string}`,
      "query-input": "required name=search_term_string"
    }
  });
}

function defaultPageSeo(page) {
  const seo = CONFIG.seo || {};
  const key = page === "sponsored-clients" ? "sponsoredClients" : page;
  const pageSeo = seo.pages?.[key] || {};
  const path = page === "home" ? "/" : `/${page}/`;
  return {
    title: pageSeo.title || `${CONFIG.site.name} | ${pageTitle(page)}`,
    description: pageSeo.description || seo.defaultDescription || copy("home.body", ""),
    path
  };
}

function renderLayout() {
  const page = document.body.dataset.page || "home";
  setSeoMeta(defaultPageSeo(page));
  document.body.innerHTML = `<div class="site-shell">
    <header class="topbar">
      <nav class="nav" aria-label="Main navigation">
        <a class="brand" href="${route("/")}" aria-label="${CONFIG.site.name} home">
          <img class="brand-icon" src="${asset(CONFIG.site.iconPath)}" alt="">
          <span>${CONFIG.site.name}</span>
        </a>
        <button class="mobile-toggle" type="button" aria-label="Toggle menu">Menu</button>
        <div class="nav-links">
          <a class="nav-link" data-route="home" href="${route("/")}">${escapeHtml(copy("nav.home", "Home"))}</a>
          <div class="dropdown">
            <button class="drop-button" type="button">${escapeHtml(copy("nav.servers", "Servers"))} <span aria-hidden="true">v</span></button>
            <div class="dropdown-menu">
              <div class="dropdown-section-title">Gamemodes</div>
              <div class="tag-grid">${CONFIG.gamemodes.map((tag) => `<a class="tag-link" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${tag}</a>`).join("")}</div>
              <div class="dropdown-section-title" style="margin-top:14px">General Tags</div>
              <div class="tag-grid">${CONFIG.generalTags.map((tag) => `<a class="tag-link" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${tag}</a>`).join("")}</div>
            </div>
          </div>
          <a class="nav-link" data-route="sponsored" href="${route("/sponsored/")}">${escapeHtml(copy("nav.sponsoredServers", "Sponsored"))}</a>
          <a class="nav-link" data-route="sponsored-clients" href="${route("/sponsored-clients/")}">${escapeHtml(copy("nav.sponsoredClients", "Sponsored Clients"))}</a>
          <a class="nav-link hidden" data-auth="dashboard" data-route="dashboard" href="${route("/dashboard/")}">${escapeHtml(copy("nav.dashboard", "Dashboard"))}</a>
          <a class="nav-link hidden" data-auth="admin" data-route="admin" href="${route("/admin/")}">${escapeHtml(copy("nav.admin", "Admin"))}</a>
          <a class="nav-link" data-auth="login" data-route="login" href="${route("/login/")}">${escapeHtml(copy("nav.login", "Login"))}</a>
        </div>
      </nav>
    </header>
    <main id="app"></main>
    <footer class="footer">
      <div class="footer-inner">
        <div><strong>${CONFIG.site.owner}</strong> | ${CONFIG.site.footerNotice}</div>
        <div class="footer-links">
          <a href="${route("/terms/")}">Terms</a>
          <a href="${route("/privacy/")}">Privacy</a>
          <a href="${route("/help/")}">Help</a>
          <a href="${route("/contact/")}">Contact</a>
        </div>
      </div>
    </footer>
  </div>`;
  $(".mobile-toggle").addEventListener("click", () => $(".nav").classList.toggle("open"));
  $$(`[data-route="${page}"]`).forEach((link) => link.classList.add("active"));
}

function syncAuthUi(user) {
  $$("[data-auth='dashboard']").forEach((node) => node.classList.toggle("hidden", !user));
  $$("[data-auth='admin']").forEach((node) => node.classList.toggle("hidden", !isAdmin(user)));
  $$("[data-auth='login']").forEach((node) => node.classList.toggle("hidden", !!user));
}

function emptyNotice() {
  return `<div class="empty-state">
    <h2>${escapeHtml(copy("empty.title", "No servers listed yet"))}</h2>
    <p>${escapeHtml(copy("empty.body", "Listings will show here after they are submitted and saved."))}</p>
    <a class="button primary" href="${store.session ? route("/dashboard/") : route("/login/")}">${escapeHtml(copy("empty.action", "Add a Server"))}</a>
  </div>`;
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

function descriptionSnippet(value = "", max = 150) {
  return trimSeo(value, max);
}

function popularTagLinks(limit = 12) {
  return [...CONFIG.gamemodes.slice(0, limit - 3), "Bedrock", "Cross-Play", "New"].slice(0, limit).map((tag) => (
    `<a class="pill" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${escapeHtml(tag)} servers</a>`
  )).join("");
}

function serverCard(server) {
  const banner = server.bannerUrl ? `background-image:url('${escapeHtml(asset(server.bannerUrl))}')` : "";
  return `<article class="server-card ${server.sponsored ? "sponsored" : ""}" data-server-id="${escapeHtml(server.id)}">
    <a class="server-card-link" href="${route(`/server/?id=${encodeURIComponent(server.id)}`)}" aria-label="Open ${escapeHtml(server.name)} listing"></a>
    <div class="rank">${server.sponsored ? `<span class="star">*</span>` : ""}#${server.rank || "-"}</div>
    <div class="banner" style="${banner}" role="img" aria-label="${escapeHtml(server.name)} banner"></div>
    <div class="server-main">
      <h3 class="server-title">${escapeHtml(server.name)} ${server.sponsored ? `<span class="pill">Sponsored</span>` : ""}</h3>
      <p class="server-ip">${escapeHtml(server.javaHost)}:${Number(server.javaPort || CONFIG.defaults.javaPort)}</p>
      <p class="server-summary">${escapeHtml(descriptionSnippet(server.description || `${server.name} is a Minecraft server listed with tags, votes, player counts, and status.`))}</p>
      <div class="server-tags">${(server.tags || []).map((tag) => `<a class="pill above-link" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${escapeHtml(tag)}</a>`).join("")}</div>
    </div>
    <div class="stats">
      <span class="status"><span class="dot ${server.online ? "online" : ""}"></span>${server.online ? "Online" : "Offline"}</span>
      <span><strong class="stat-value">${Number(server.playersOnline || 0).toLocaleString()}</strong> <span class="muted">players</span></span>
      <a class="button blue above-link" href="${route(`/vote/?server=${encodeURIComponent(server.id)}`)}">Vote (${Number(server.votes || 0).toLocaleString()})</a>
    </div>
  </article>`;
}

function renderServerList(servers, selector = "#serverList") {
  const root = $(selector);
  if (!root) return;
  root.innerHTML = servers.length ? servers.map(serverCard).join("") : emptyNotice();
}

function toolbarMarkup(selectedTag = "") {
  return `<div class="toolbar">
    <input id="searchInput" class="input" type="search" placeholder="${escapeHtml(copy("servers.searchPlaceholder", "Search by name, IP, or tag"))}" autocomplete="off">
    <select id="tagFilter" class="select">
      <option value="">All tags</option>
      ${ALL_TAGS.map((tag) => `<option ${tag === selectedTag ? "selected" : ""}>${tag}</option>`).join("")}
    </select>
    <select id="sortMode" class="select">
      <option value="rank">Best ranked</option>
      <option value="players">Most players</option>
      <option value="votes">Most votes</option>
      <option value="new">Newest first</option>
    </select>
  </div>`;
}

function setupFilters(servers) {
  const params = new URLSearchParams(location.search);
  const initialTag = params.get("tag") || $("#tagFilter")?.value || "";
  if ($("#tagFilter")) $("#tagFilter").value = initialTag;
  const apply = () => {
    const search = ($("#searchInput")?.value || "").toLowerCase();
    const tag = $("#tagFilter")?.value || "";
    const sort = $("#sortMode")?.value || "rank";
    let result = servers.filter((server) => {
      const text = `${server.name} ${server.javaHost} ${(server.tags || []).join(" ")}`.toLowerCase();
      return (!search || text.includes(search)) && (!tag || (server.tags || []).includes(tag));
    });
    if (sort === "players") result = [...result].sort((a, b) => (b.playersOnline || 0) - (a.playersOnline || 0));
    if (sort === "votes") result = [...result].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    if (sort === "new") result = [...result].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    renderServerList(result);
  };
  ["searchInput", "tagFilter", "sortMode"].forEach((id) => $(`#${id}`)?.addEventListener("input", apply));
  apply();
}

function serverSeoTitle(server) {
  const base = `${server.name} Minecraft Server`;
  return base.length <= 43 ? `${base} | ${CONFIG.site.name}` : base;
}

function serverSeoDescription(server) {
  const tags = (server.tags || []).slice(0, 4).join(", ");
  const status = server.online ? `${Number(server.playersOnline || 0).toLocaleString()} players online` : "status, tags, votes";
  return trimSeo(`${server.name} is a Minecraft server${tags ? ` for ${tags}` : ""}. Join at ${serverAddress(server)} and view ${status}, details, trailer, and voting.`, 158);
}

function serverJsonLd(server) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: server.name,
    url: absoluteUrl(`/server/?id=${encodeURIComponent(server.id)}`),
    description: trimSeo(server.description || serverSeoDescription(server), 300),
    keywords: [...(server.tags || []), "Minecraft server", "Minecraft server list"].join(", "),
    image: absoluteUrl(asset(server.bannerUrl || CONFIG.site.iconPath)),
    about: {
      "@type": "VideoGame",
      name: "Minecraft"
    },
    mainEntity: {
      "@type": "Thing",
      name: server.name,
      description: trimSeo(server.description || serverSeoDescription(server), 300),
      url: absoluteUrl(`/server/?id=${encodeURIComponent(server.id)}`)
    }
  };
}

function renderHome(state) {
  setSeoMeta({
    ...defaultPageSeo("home"),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: CONFIG.site.name,
      url: absoluteUrl("/"),
      description: CONFIG.seo?.pages?.home?.description || CONFIG.seo?.defaultDescription,
      potentialAction: {
        "@type": "SearchAction",
        target: `${absoluteUrl("/servers/")}?q={search_term_string}`,
        "query-input": "required name=search_term_string"
      }
    }
  });
  const sponsored = state.servers.filter((server) => server.sponsored);
  $("#app").innerHTML = `<div class="page">
    <section class="hero-band compact">
      <div class="hero-content">
        <div class="eyebrow">${escapeHtml(copy("home.eyebrow", "Minecraft server directory"))}</div>
        <h1 class="hero-title">${escapeHtml(copy("home.title", CONFIG.site.name))}</h1>
        <p class="hero-copy">${escapeHtml(copy("home.body", "A simple place to list servers, check basic status, and send votes. No fake seeded listings."))}</p>
        <div class="hero-actions">
          <a class="button primary" href="${route("/servers/")}">${escapeHtml(copy("home.browseButton", "Browse servers"))}</a>
          <a class="button" href="${state.user ? route("/dashboard/") : route("/login/")}">${escapeHtml(state.user ? copy("home.manageButton", "Manage listings") : copy("home.submitButton", "Submit a server"))}</a>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">${escapeHtml(copy("home.sponsoredTitle", "Sponsored Servers"))}</h2>
          <p class="section-copy">${escapeHtml(copy("home.sponsoredBody", "Paid placements. Marked separately from the main list."))}</p>
        </div>
      </div>
      <div id="sponsoredList" class="server-list"></div>
    </section>
    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">${escapeHtml(copy("home.allTitle", "All Servers"))}</h2>
          <p class="section-copy">${escapeHtml(copy("home.allBody", "Sorted by rank by default. Use search if you already know what you want."))}</p>
        </div>
      </div>
      ${toolbarMarkup()}
      <div id="serverList" class="server-list"></div>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">Browse Minecraft Servers by Gamemode</h2>
      <p class="section-copy">Find servers by the way you actually play: survival worlds, SMP communities, economy servers, PvP networks, Skyblock islands, prison progression, Bedrock support, and cross-play servers for friends on different editions.</p>
      <div class="server-tags">${popularTagLinks()}</div>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">How Icon Listing Helps Players Choose</h2>
      <p class="section-copy">Each listing can include a formatted description, server IP, tags, owner, country, player counts, status checks, vote totals, banners, trailers, and links. That gives players more context before joining and gives owners a cleaner place to advertise real communities.</p>
    </section>
  </div>`;
  renderServerList(sponsored, "#sponsoredList");
  setupFilters(state.servers);
}

function renderServers(state) {
  const tag = new URLSearchParams(location.search).get("tag") || "";
  setSeoMeta({
    ...defaultPageSeo("servers"),
    title: tag ? `${tag} Minecraft Servers | ${CONFIG.site.name}` : CONFIG.seo?.pages?.servers?.title,
    description: tag
      ? `Browse ${tag} Minecraft servers by votes, players, rank, and status. Find active ${tag} communities and vote for your favorites.`
      : CONFIG.seo?.pages?.servers?.description,
    path: tag ? `/servers/?tag=${encodeURIComponent(tag)}` : "/servers/",
    keywords: tag ? [tag, `${tag} Minecraft servers`] : [],
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: tag ? `${tag} Minecraft Servers` : "Minecraft Servers",
      url: absoluteUrl(tag ? `/servers/?tag=${encodeURIComponent(tag)}` : "/servers/"),
      itemListElement: state.servers.slice(0, 20).map((server, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: absoluteUrl(`/server/?id=${encodeURIComponent(server.id)}`),
        name: server.name
      }))
    }
  });
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">${tag ? `${escapeHtml(tag)} ${escapeHtml(copy("servers.taggedTitleSuffix", "Servers"))}` : escapeHtml(copy("servers.title", "Servers"))}</h1>
          <p class="section-copy">${escapeHtml(copy("servers.body", "Search by name, IP, or tag."))}</p>
        </div>
      </div>
      ${toolbarMarkup(tag)}
      <section class="seo-section">
        <h2 class="section-title">${tag ? `Find ${escapeHtml(tag)} Minecraft Servers` : "Find the Right Minecraft Server"}</h2>
        <p class="section-copy">${tag ? `Compare ${escapeHtml(tag)} servers by activity, votes, tags, descriptions, and status. Open a listing to view the server IP, details, trailer, banners, and vote page.` : "Use search, tags, and sorting to compare Minecraft servers by activity, votes, newest listings, and gamemode. Every listing links to a detail page with server information and voting."}</p>
        <div class="server-tags">${popularTagLinks()}</div>
      </section>
      <div id="serverList" class="server-list"></div>
    </section>
  </div>`;
  setupFilters(state.servers);
}

function renderServerDetail(state) {
  const id = new URLSearchParams(location.search).get("id");
  const server = state.servers.find((item) => item.id === id);
  if (!server) {
    setSeoMeta({
      title: `Server Not Found | ${CONFIG.site.name}`,
      description: "This Minecraft server listing could not be found. Browse active Minecraft servers by players, votes, tags, and status.",
      path: "/server/"
    });
    $("#app").innerHTML = `<div class="page">${emptyNotice()}</div>`;
    return;
  }
  const banner = server.bannerUrl ? `background-image:url('${escapeHtml(asset(server.bannerUrl))}')` : "";
  const owner = server.ownerName || "Server owner";
  const canEdit = state.user && (server.ownerId === state.user.id || isAdmin(state.user));
  const ip = serverAddress(server);
  const bedrockIp = server.crossPlay ? `${server.bedrockHost}:${Number(server.bedrockPort || CONFIG.defaults.bedrockPort)}` : "";
  setSeoMeta({
    title: serverSeoTitle(server),
    description: serverSeoDescription(server),
    path: `/server/?id=${encodeURIComponent(server.id)}`,
    image: server.bannerUrl || CONFIG.site.iconPath,
    type: "article",
    keywords: [...(server.tags || []), server.name, server.javaHost],
    jsonLd: serverJsonLd(server)
  });
  $("#app").innerHTML = `<div class="page detail-layout">
    <aside class="info-panel">
      <h1>${escapeHtml(server.name)}</h1>
      ${infoRow("Owner", owner)}
      ${infoRow("Status", `<span class="status inline"><span class="dot ${server.online ? "online" : ""}"></span>${server.online ? "Online" : "Offline"}</span>`)}
      ${infoRow("Java IP", `<span class="copy-row"><span>${escapeHtml(ip)}</span><button class="mini-button" data-copy-ip type="button">Copy</button></span>`)}
      ${server.crossPlay ? infoRow("Bedrock IP", `<span class="copy-row"><span>${escapeHtml(bedrockIp)}</span><button class="mini-button" data-copy-bedrock type="button">Copy</button></span>`) : ""}
      ${server.websiteUrl ? infoRow("Website", `<a href="${escapeHtml(server.websiteUrl)}">${escapeHtml(server.websiteUrl)}</a>`) : ""}
      ${server.discordUrl ? infoRow("Discord", `<a href="${escapeHtml(server.discordUrl)}">Click to join</a>`) : ""}
      ${infoRow("Players", `${Number(server.playersOnline || 0).toLocaleString()}${server.playersMax ? `/${Number(server.playersMax).toLocaleString()}` : ""}`)}
      ${infoRow("Version", `<span class="pill">${escapeHtml(server.version || "Unknown")}</span>`)}
      ${infoRow("Rank", `#${server.rank || "-"}`)}
      ${infoRow("Votes", Number(server.votes || 0).toLocaleString())}
      ${infoRow("Uptime", `${Number(server.uptimePercent || 0).toFixed(1)}%`)}
      ${infoRow("Last Ping", server.lastPingAt ? timeAgo(server.lastPingAt) : "Not pinged yet")}
      ${infoRow("Country", escapeHtml(server.country || "Unknown"))}
      ${infoRow("Tags", `<div class="server-tags">${(server.tags || []).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}</div>`)}
    </aside>
    <section class="detail-card">
      <div class="tabs">
        ${detailTabButton("info", "Info", true)}
        ${detailTabButton("stats", "Stats")}
        ${detailTabButton("banners", "Banners")}
        ${detailTabButton("analytics", "Analytics")}
        ${detailTabButton("trailer", "Trailer")}
        ${canEdit ? detailTabButton("edit", "Edit") : ""}
      </div>
      <div class="detail-body detail-tab-panel active" data-panel="info">
        <div class="server-showcase">
          <div class="detail-banner" style="${banner}"></div>
          <div>
            <p class="eyebrow">Server listing</p>
            <h2>${escapeHtml(server.name)}</h2>
            <p>${escapeHtml(serverAddress(server))}</p>
            <div class="server-tags">${(server.tags || []).slice(0, 5).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}</div>
          </div>
        </div>
        <div class="quick-stats">
          <div class="mini-stat"><strong>${Number(server.playersOnline || 0).toLocaleString()}</strong><span>online now</span></div>
          <div class="mini-stat"><strong>${Number(server.votes || 0).toLocaleString()}</strong><span>votes</span></div>
          <div class="mini-stat"><strong>#${server.rank || "-"}</strong><span>rank</span></div>
        </div>
        <div class="description-card">
          <h3>About this server</h3>
          <div class="description-text">${escapeHtml(server.description)}</div>
        </div>
        <a class="button vote-wide" href="${route(`/vote/?server=${encodeURIComponent(server.id)}`)}">Vote for ${escapeHtml(server.name)}</a>
      </div>
      <div class="detail-body detail-tab-panel" data-panel="stats">
        <h2 class="detail-heading">Player history</h2>
        ${playerChart(server.analytics?.playerHistory || [], server.playersOnline)}
        <div class="metric-select">Players</div>
      </div>
      <div class="detail-body detail-tab-panel" data-panel="banners">
        <h2 class="detail-heading">Banners</h2>
        ${bannerPreview(server)}
        <label class="field banner-field"><span>HTML code</span><input class="input code-input" value="${escapeHtml(htmlBannerCode(server))}" readonly></label>
        <label class="field banner-field"><span>BB code</span><input class="input code-input" value="${escapeHtml(bbBannerCode(server))}" readonly></label>
      </div>
      <div class="detail-body detail-tab-panel" data-panel="analytics">
        <h2 class="detail-heading">Unique IP copies</h2>
        <div class="grid two">
          <div class="mini-stat"><strong>${Number(server.analytics?.ipCopiesLast7 || 0).toLocaleString()}</strong><span>last 7 days</span></div>
          <div class="mini-stat"><strong>${Number(server.analytics?.ipCopiesLast30 || 0).toLocaleString()}</strong><span>last 30 days</span></div>
        </div>
        ${copyChart(server.analytics?.ipCopyDaily || [])}
        <p class="detail-note">Only the first copy from the same visitor in a 30-day period is counted.</p>
      </div>
      <div class="detail-body detail-tab-panel" data-panel="trailer">
        <h2 class="detail-heading">Trailer</h2>
        ${trailerEmbed(server.youtubeUrl)}
      </div>
      ${canEdit ? `<div class="detail-body detail-tab-panel" data-panel="edit">
        <h2 class="detail-heading">Edit listing</h2>
        <p class="section-copy">Open your dashboard to change the server name, tags, banner, description, Votifier, or links.</p>
        <a class="button primary" href="${route("/dashboard/")}">Open dashboard</a>
      </div>` : ""}
    </section>
  </div>`;
  bindServerDetail(server);
}

function infoRow(label, value) {
  return `<div class="info-row"><strong>${label}</strong><span>${value}</span></div>`;
}

function detailTabButton(id, label, active = false) {
  return `<button class="tab ${active ? "active" : ""}" type="button" data-detail-tab="${id}">${label}</button>`;
}

function bindServerDetail(server) {
  $$("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      $$("[data-detail-tab]").forEach((node) => node.classList.toggle("active", node === button));
      $$("[data-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === button.dataset.detailTab));
    });
  });
  $("[data-copy-ip]")?.addEventListener("click", () => copyServerAddress(server, serverAddress(server)));
  $("[data-copy-bedrock]")?.addEventListener("click", () => copyServerAddress(server, `${server.bedrockHost}:${Number(server.bedrockPort || CONFIG.defaults.bedrockPort)}`));
}

async function copyServerAddress(server, value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    window.prompt("Copy server address", value);
  }
  try {
    await request("trackCopy", { serverId: server.id });
  } catch {
    // Copying should still succeed even if analytics are unavailable.
  }
  toast("Server address copied.");
}

function serverAddress(server) {
  return `${server.javaHost}:${Number(server.javaPort || CONFIG.defaults.javaPort)}`;
}

function bannerPreview(server) {
  const banner = server.bannerUrl ? `background-image:url('${escapeHtml(asset(server.bannerUrl))}')` : "";
  return `<div class="generated-banner" style="${banner}">
    <div>
      <strong>${escapeHtml(server.name)}</strong>
      <span>${escapeHtml(serverAddress(server))}</span>
    </div>
    <div class="generated-banner-stats">
      <span>${server.online ? "Online" : "Offline"}</span>
      <span>${Number(server.playersOnline || 0).toLocaleString()} players</span>
    </div>
  </div>`;
}

function htmlBannerCode(server) {
  return `<a href="${listingUrl(server)}" target="_blank"><img src="${bannerImageUrl(server)}" alt="${server.name}"></a>`;
}

function bbBannerCode(server) {
  return `[url=${listingUrl(server)}][img]${bannerImageUrl(server)}[/img][/url]`;
}

function listingUrl(server) {
  return new URL(route(`/server/?id=${encodeURIComponent(server.id)}`), location.origin).href;
}

function bannerImageUrl(server) {
  return new URL(asset(server.bannerUrl || CONFIG.site.iconPath), location.origin).href;
}

function trailerEmbed(url) {
  const embed = youtubeEmbedUrl(url);
  if (!embed) return `<div class="empty-state"><h2>No trailer added</h2><p>Add a YouTube URL from the dashboard to show a trailer here.</p></div>`;
  return `<div class="trailer-frame"><iframe src="${escapeHtml(embed)}" title="Server trailer" allowfullscreen loading="lazy"></iframe></div>`;
}

function youtubeEmbedUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const id = parsed.hostname.includes("youtu.be") ? parsed.pathname.slice(1) : parsed.searchParams.get("v");
    return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : "";
  } catch {
    return "";
  }
}

function playerChart(history, currentPlayers = 0) {
  const points = (history.length ? history : [{ createdAt: new Date().toISOString(), playersOnline: currentPlayers }]).slice(-30);
  return lineChart(points.map((point) => Number(point.playersOnline || 0)), points.map((point) => shortDate(point.createdAt)), "Players");
}

function copyChart(days) {
  const points = days.length ? days : dailyIpCopies([], 30);
  return barChart(points.map((point) => Number(point.count || 0)), points.map((point) => shortDate(point.date)), "IP copies");
}

function lineChart(values, labels, title) {
  const max = Math.max(1, ...values);
  const width = 640;
  const height = 260;
  const pad = 34;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const path = values.map((value, index) => {
    const x = pad + step * index;
    const y = height - pad - (value / max) * (height - pad * 2);
    return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  return `<figure class="chart-box" aria-label="${escapeHtml(title)} chart">
    <svg viewBox="0 0 ${width} ${height}" role="img">
      ${chartGrid(width, height, pad)}
      <path d="${path}" fill="none" stroke="currentColor" stroke-width="3"></path>
      ${chartLabels(labels, width, height, pad)}
    </svg>
  </figure>`;
}

function barChart(values, labels, title) {
  const max = Math.max(1, ...values);
  const width = 640;
  const height = 260;
  const pad = 34;
  const gap = 4;
  const barWidth = (width - pad * 2) / values.length - gap;
  const bars = values.map((value, index) => {
    const h = (value / max) * (height - pad * 2);
    const x = pad + index * (barWidth + gap);
    const y = height - pad - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(2, barWidth).toFixed(1)}" height="${h.toFixed(1)}"></rect>`;
  }).join("");
  return `<figure class="chart-box" aria-label="${escapeHtml(title)} chart">
    <svg viewBox="0 0 ${width} ${height}" role="img">
      ${chartGrid(width, height, pad)}
      <g class="chart-bars">${bars}</g>
      ${chartLabels(labels, width, height, pad)}
    </svg>
  </figure>`;
}

function chartGrid(width, height, pad) {
  const lines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = pad + ratio * (height - pad * 2);
    return `<line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}"></line>`;
  }).join("");
  return `<g class="chart-grid">${lines}<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}"></line><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"></line></g>`;
}

function chartLabels(labels, width, height, pad) {
  const filtered = labels.filter((_, index) => index === 0 || index === labels.length - 1 || index % Math.ceil(labels.length / 4) === 0);
  return `<g class="chart-labels">${filtered.map((label, index) => {
    const x = pad + (index / Math.max(1, filtered.length - 1)) * (width - pad * 2);
    return `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(label)}</text>`;
  }).join("")}</g>`;
}

function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function timeAgo(value) {
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function renderVotePage(state) {
  const id = new URLSearchParams(location.search).get("server");
  const server = state.servers.find((item) => item.id === id);
  if (!server) {
    setSeoMeta({
      title: `Vote for Minecraft Servers | ${CONFIG.site.name}`,
      description: "Vote for Minecraft servers and support your favorite communities on Icon Listing.",
      path: "/vote/"
    });
    $("#app").innerHTML = `<div class="page">${emptyNotice()}</div>`;
    return;
  }
  setSeoMeta({
    title: `Vote for ${server.name} | ${CONFIG.site.name}`,
    description: `Vote for ${server.name}, a Minecraft server listed on Icon Listing. Votes help players find active servers and communities.`,
    path: `/vote/?server=${encodeURIComponent(server.id)}`,
    keywords: [server.name, "Minecraft server vote", ...(server.tags || [])]
  });
  const leaderboard = voteLeaderboard(state.votes, server.id);
  $("#app").innerHTML = `<div class="page vote-layout">
    <section class="card form">
      <h1 class="section-title">Vote for ${escapeHtml(server.name)}</h1>
      <p class="section-copy">${escapeHtml(copy("vote.body", "Enter your Minecraft username so this vote can count on the monthly board."))}</p>
      <form id="voteForm" class="form">
        <div class="field"><label>Minecraft Username</label><input id="minecraftUsername" class="input" autocomplete="username" minlength="3" maxlength="16" pattern="[A-Za-z0-9_]{3,16}" required></div>
        <button class="button primary" type="submit">Submit Vote</button>
      </form>
    </section>
    <aside class="card">
      <h2>votes this month</h2>
      <div class="leaderboard">${leaderboard.length ? leaderboard.map((item, index) => `<div class="leader-row"><strong>#${index + 1} ${escapeHtml(item.minecraftUsername)}</strong><span>${item.votes}</span></div>`).join("") : `<p class="section-copy">${escapeHtml(copy("vote.emptyLeaderboard", "No monthly votes yet."))}</p>`}</div>
    </aside>
  </div>`;
  $("#voteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await request("vote", { serverId: server.id, minecraftUsername: $("#minecraftUsername").value });
      toast("Vote counted. Thanks for supporting this server.");
      location.reload();
    } catch (error) {
      toast(error.message);
    }
  });
}

function renderSponsored() {
  setSeoMeta(defaultPageSeo("sponsored"));
  $("#app").innerHTML = `<div class="page">
    <section class="hero-band compact">
      <div class="hero-content">
        <div class="eyebrow">${escapeHtml(copy("sponsoredServers.eyebrow", "Paid placements"))}</div>
        <h1 class="hero-title">${escapeHtml(copy("sponsoredServers.title", "Sponsored Servers"))}</h1>
        <p class="hero-copy">${escapeHtml(copy("sponsoredServers.body", "Sponsors get placement above normal results. The listing stays labeled so players know what they are looking at."))}</p>
        <div class="hero-actions"><a class="button primary" href="${CONFIG.site.discordUrl}">${escapeHtml(copy("sponsoredServers.action", "Ask on Discord"))}</a></div>
      </div>
    </section>
    <section class="section grid two">
      <div class="card">
        <h2>${escapeHtml(copy("sponsoredServers.benefitsTitle", "What sponsors get"))}</h2>
        <ul class="feature-list">${CONFIG.sponsorship.benefits.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>
      <div class="card">
        <h2>${escapeHtml(copy("sponsoredServers.applyTitle", "How to apply"))}</h2>
        <p class="section-copy">${escapeHtml(CONFIG.sponsorship.applicationText)}</p>
      </div>
    </section>
  </div>`;
}

function renderClients(state) {
  setSeoMeta({
    ...defaultPageSeo("sponsored-clients"),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "Sponsored Minecraft Clients",
      url: absoluteUrl("/sponsored-clients/"),
      itemListElement: state.clients.slice(0, 20).map((client, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: client.url,
        name: client.name
      }))
    }
  });
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">${escapeHtml(copy("sponsoredClients.title", "Sponsored Clients"))}</h1>
          <p class="section-copy">${escapeHtml(copy("sponsoredClients.body", "Client promotions approved by staff."))}</p>
        </div>
      </div>
      <div class="grid two">${state.clients.length ? state.clients.map(clientCard).join("") : emptyNotice()}</div>
    </section>
  </div>`;
}

function clientCard(client) {
  const images = (client.images || []).slice(0, 2);
  return `<article class="card client-card">
    <div class="client-gallery">${images.length ? images.map((image) => `<div class="client-image" style="background-image:url('${escapeHtml(asset(image))}')"></div>`).join("") : `<div class="client-image placeholder">${escapeHtml(client.name || "Client")}</div>`}</div>
    <div class="server-tags">
      <span class="pill">${escapeHtml(client.version === "both" ? "Java + Bedrock" : client.version === "java" ? "Java" : "Bedrock")}</span>
      <span class="pill">${escapeHtml(client.pricing === "paid" ? copy("sponsoredClients.paidLabel", "Paid client") : copy("sponsoredClients.freeLabel", "Free client"))}</span>
    </div>
    <h2>${escapeHtml(client.name)}</h2>
    <div class="description-text compact">${escapeHtml(client.description)}</div>
    <div class="row-actions">
      <a class="button primary" href="${escapeHtml(client.url)}">${escapeHtml(copy("sponsoredClients.visitButton", "Website / Download"))}</a>
      ${client.youtubeUrl ? `<a class="button" href="${escapeHtml(client.youtubeUrl)}">${escapeHtml(copy("sponsoredClients.videoButton", "Watch video"))}</a>` : ""}
    </div>
  </article>`;
}

function renderLogin(state) {
  setSeoMeta({
    title: `Login | ${CONFIG.site.name}`,
    description: "Log in to Icon Listing to submit and manage Minecraft server listings.",
    path: "/login/"
  });
  if (state.user) {
    $("#app").innerHTML = `<div class="page"><div class="card"><h1>You are logged in as ${escapeHtml(state.user.username)}.</h1><button id="logoutButton" class="button danger">Logout</button></div></div>`;
    $("#logoutButton").addEventListener("click", () => {
      store.session = null;
      location.href = route("/");
    });
    return;
  }
  $("#app").innerHTML = `<div class="page">
    <section class="section grid two">
      <form id="loginForm" class="card form">
        <h1 class="section-title">${escapeHtml(copy("login.title", "Login"))}</h1>
        <p class="section-copy">${escapeHtml(copy("login.body", "Log in to manage your server listings."))}</p>
        <div class="field"><label>Username or email</label><input id="loginName" class="input" required></div>
        <div class="field"><label>Password</label><input id="loginPassword" class="input" type="password" required></div>
        <button class="button primary" type="submit">Login</button>
        <p class="section-copy">${escapeHtml(copy("login.signupPrompt", "Need an account?"))} <a class="text-link" href="#signup">${escapeHtml(copy("login.signupLink", "Sign up below"))}</a>.</p>
      </form>
      <form id="signup" class="card form">
        <h2 class="section-title">${escapeHtml(copy("login.signupTitle", "Sign Up"))}</h2>
        <p class="section-copy">${escapeHtml(copy("login.signupBody", "Create an account to submit a server."))}</p>
        <div class="field"><label>Username</label><input id="signupUser" class="input" minlength="3" required></div>
        <div class="field"><label>Email</label><input id="signupEmail" class="input" type="email" required></div>
        <div class="field"><label>Password</label><input id="signupPassword" class="input" type="password" minlength="6" required></div>
        <button class="button blue" type="submit">Create Account</button>
      </form>
    </section>
  </div>`;
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await request("login", { login: $("#loginName").value, password: $("#loginPassword").value });
      store.session = { token: result.token, user: result.user };
      location.href = route("/dashboard/");
    } catch (error) {
      toast(error.message);
    }
  });
  $("#signup").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await request("register", { username: $("#signupUser").value, email: $("#signupEmail").value, password: $("#signupPassword").value });
      store.session = { token: result.token, user: result.user };
      location.href = route("/dashboard/");
    } catch (error) {
      toast(error.message);
    }
  });
}

function renderDashboard(state) {
  if (!state.user) {
    $("#app").innerHTML = `<div class="page"><div class="notice">${escapeHtml(copy("dashboard.loginRequired", "Log in to add and manage server listings."))}</div><div class="row-actions"><a class="button primary" href="${route("/login/")}">${escapeHtml(copy("nav.login", "Login"))}</a></div></div>`;
    return;
  }
  const mine = state.servers.filter((server) => server.ownerId === state.user.id);
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">${escapeHtml(copy("dashboard.title", "Dashboard"))}</h1>
          <p class="section-copy">${escapeHtml(copy("dashboard.body", "Edit listings, check rank, or add another server."))}</p>
        </div>
      </div>
      <div class="dashboard-list">${mine.length ? mine.map((server) => `<article class="card dash-item">
        <div class="rank">#${server.rank}</div>
        <div>
          <h2 class="server-title">${escapeHtml(server.name)}</h2>
          <p class="server-ip">${escapeHtml(server.javaHost)}:${server.javaPort}</p>
        </div>
        <div class="row-actions">
          <a class="button" href="${route(`/server/?id=${encodeURIComponent(server.id)}`)}">View</a>
          <button class="button" data-edit="${escapeHtml(server.id)}">Edit</button>
          <button class="button danger" data-delete="${escapeHtml(server.id)}">Delete</button>
        </div>
      </article>`).join("") : emptyNotice()}</div>
      <div class="row-actions">
        <button id="addServerButton" class="button primary">${escapeHtml(copy("dashboard.addButton", "+ Add Server"))}</button>
        <button id="settingsButton" class="button">${escapeHtml(copy("dashboard.settingsButton", "Account Settings"))}</button>
      </div>
    </section>
    <section id="serverFormPanel" class="section hidden">${serverFormMarkup()}</section>
    <section id="settingsPanel" class="section hidden">${settingsMarkup(state.user)}</section>
  </div>`;
  bindDashboard(state);
}

function serverFormMarkup(server = {}) {
  return `<form id="serverForm" class="card form">
    <input type="hidden" id="serverId" value="${escapeHtml(server.id || "")}">
    <h2 class="section-title">${server.id ? "Edit Server" : "Add Server"}</h2>
    <div class="form-grid">
      <div class="field"><label>Server Name</label><input id="serverName" class="input" value="${escapeHtml(server.name || "")}" required></div>
      <div class="field"><label>Country</label><select id="serverCountry" class="select" required>${CONFIG.countries.map((country) => `<option ${country === server.country ? "selected" : ""}>${country}</option>`).join("")}</select></div>
      <div class="field"><label>Java IP / Host</label><input id="javaHost" class="input" value="${escapeHtml(server.javaHost || "")}" required></div>
      <div class="field"><label>Java Port</label><input id="javaPort" class="input" type="number" value="${Number(server.javaPort || CONFIG.defaults.javaPort)}" required></div>
    </div>
    <label class="check-row"><input id="crossPlay" type="checkbox" ${server.crossPlay ? "checked" : ""}> Cross-Play Server</label>
    <div id="bedrockFields" class="form-grid hidden">
      <div class="field"><label>Bedrock IP / Host</label><input id="bedrockHost" class="input" value="${escapeHtml(server.bedrockHost || "")}"></div>
      <div class="field"><label>Bedrock Port</label><input id="bedrockPort" class="input" type="number" value="${Number(server.bedrockPort || CONFIG.defaults.bedrockPort)}"></div>
    </div>
    <label class="check-row"><input id="votifierEnabled" type="checkbox" ${server.votifierEnabled ? "checked" : ""}> Enable Votifier</label>
    <div id="votifierFields" class="form-grid hidden">
      <div class="field"><label>Votifier IP / Host</label><input id="votifierHost" class="input" value="${escapeHtml(server.votifierHost || "")}"></div>
      <div class="field"><label>Votifier Port</label><input id="votifierPort" class="input" type="number" value="${Number(server.votifierPort || 8192)}"></div>
      <div class="field"><label>Votifier Token / Public Key</label><input id="votifierToken" class="input" value="${escapeHtml(server.votifierToken || "")}"></div>
      <div class="field"><label>&nbsp;</label><button id="testVote" class="button blue" type="button">Send Test Vote</button></div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Website URL</label><input id="websiteUrl" class="input" type="url" value="${escapeHtml(server.websiteUrl || "")}"></div>
      <div class="field"><label>Discord Invite Link</label><input id="discordUrl" class="input" type="url" value="${escapeHtml(server.discordUrl || "")}"></div>
      <div class="field"><label>YouTube Video URL</label><input id="youtubeUrl" class="input" type="url" value="${escapeHtml(server.youtubeUrl || "")}"></div>
      <div class="field"><label>Banner Image/GIF URL</label><input id="bannerUrl" class="input" value="${escapeHtml(server.bannerUrl || "")}"></div>
    </div>
    <div class="field"><label>Banner Upload</label><input id="bannerUpload" class="input" type="file" accept="image/png,image/gif,image/jpeg"></div>
    <div class="field"><label>Description</label><textarea id="description" class="textarea" minlength="${CONFIG.limits.descriptionMinLength}" required>${escapeHtml(server.description || "")}</textarea></div>
    <div class="field"><label>Tags</label><div id="tagPicker" class="tag-picker">${ALL_TAGS.map((tag) => `<button type="button" class="tag-choice ${(server.tags || []).includes(tag) ? "selected" : ""}" data-tag="${tag}">${tag}</button>`).join("")}</div></div>
    <button class="button primary" type="submit">Save Listing</button>
  </form>`;
}

function bindDashboard(state) {
  $("#addServerButton")?.addEventListener("click", () => {
    $("#serverFormPanel").innerHTML = serverFormMarkup();
    $("#serverFormPanel").classList.remove("hidden");
    $("#settingsPanel").classList.add("hidden");
    bindDashboard(state);
  });
  $("#settingsButton")?.addEventListener("click", () => {
    $("#settingsPanel").classList.toggle("hidden");
    $("#serverFormPanel").classList.add("hidden");
  });
  $$("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const server = state.servers.find((item) => item.id === button.dataset.edit);
      $("#serverFormPanel").innerHTML = serverFormMarkup(server);
      $("#serverFormPanel").classList.remove("hidden");
      $("#settingsPanel").classList.add("hidden");
      bindDashboard(state);
    });
  });
  $$("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Delete this listing permanently?")) return;
      try {
        await request("deleteServer", { id: button.dataset.delete });
        boot();
      } catch (error) {
        toast(error.message);
      }
    });
  });
  bindServerForm();
  bindSettingsForms();
}

function bindServerForm() {
  const crossPlay = $("#crossPlay");
  const votifier = $("#votifierEnabled");
  const sync = () => {
    $("#bedrockFields")?.classList.toggle("hidden", !crossPlay?.checked);
    $("#votifierFields")?.classList.toggle("hidden", !votifier?.checked);
  };
  crossPlay?.addEventListener("change", sync);
  votifier?.addEventListener("change", sync);
  sync();
  $$(".tag-choice").forEach((button) => {
    button.addEventListener("click", () => {
      const selected = $$(".tag-choice.selected").length;
      if (!button.classList.contains("selected") && selected >= CONFIG.limits.tagsMax) return toast(`Select up to ${CONFIG.limits.tagsMax} tags.`);
      button.classList.toggle("selected");
    });
  });
  $("#bannerUpload")?.addEventListener("change", validateBannerUpload);
  $("#testVote")?.addEventListener("click", async () => {
    try {
      const result = await request("testVote", { host: $("#votifierHost").value, port: $("#votifierPort").value, token: $("#votifierToken").value });
      toast(result.message || "Test vote sent.");
    } catch (error) {
      toast(error.message);
    }
  });
  $("#serverForm")?.addEventListener("submit", submitServerForm);
}

async function validateBannerUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > CONFIG.limits.bannerMaxBytes) {
    event.target.value = "";
    return toast("Banner file must be 1MB or smaller.");
  }
  const dataUrl = await fileToDataUrl(file);
  const image = new Image();
  image.onload = () => {
    if (image.width > CONFIG.limits.bannerMaxWidth || image.height > CONFIG.limits.bannerMaxHeight) {
      event.target.value = "";
      toast(`Banner dimensions must be ${CONFIG.limits.bannerMaxWidth}x${CONFIG.limits.bannerMaxHeight} or smaller.`);
      return;
    }
    $("#bannerUrl").value = dataUrl;
  };
  image.src = dataUrl;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function submitServerForm(event) {
  event.preventDefault();
  const selectedTags = $$(".tag-choice.selected").map((button) => button.dataset.tag);
  if (selectedTags.length < CONFIG.limits.tagsMin || selectedTags.length > CONFIG.limits.tagsMax) return toast(`Select ${CONFIG.limits.tagsMin} to ${CONFIG.limits.tagsMax} tags.`);
  if (["#serverName", "#description"].some((selector) => hasBlockedText($(selector).value))) return toast("Please remove blocked words from the listing.");
  try {
    await request("saveServer", {
      server: {
        id: $("#serverId").value,
        name: $("#serverName").value,
        javaHost: $("#javaHost").value,
        javaPort: $("#javaPort").value,
        crossPlay: $("#crossPlay").checked,
        bedrockHost: $("#bedrockHost").value,
        bedrockPort: $("#bedrockPort").value,
        votifierEnabled: $("#votifierEnabled").checked,
        votifierHost: $("#votifierHost").value,
        votifierPort: $("#votifierPort").value,
        votifierToken: $("#votifierToken").value,
        websiteUrl: $("#websiteUrl").value,
        discordUrl: $("#discordUrl").value,
        youtubeUrl: $("#youtubeUrl").value,
        country: $("#serverCountry").value,
        bannerUrl: $("#bannerUrl").value,
        description: $("#description").value,
        tags: selectedTags
      }
    });
    toast("Listing saved.");
    boot();
  } catch (error) {
    toast(error.message);
  }
}

function settingsMarkup(user) {
  return `<div class="grid two">
    <form id="settingsForm" class="card form">
      <h2 class="section-title">Account Settings</h2>
      <div class="field"><label>Username</label><input id="settingsUsername" class="input" value="${escapeHtml(user.username)}" required></div>
      <div class="field"><label>Email</label><input id="settingsEmail" class="input" type="email" value="${escapeHtml(user.email)}" required></div>
      <div class="field"><label>New Password</label><input id="settingsPassword" class="input" type="password" minlength="6"></div>
      <button class="button primary" type="submit">Save Account</button>
    </form>
    <form id="deleteAccountForm" class="card form danger-zone">
      <h2 class="section-title">Delete Account</h2>
      <p class="section-copy">Deleting your account also permanently removes every listing you own.</p>
      <div class="field"><label>Username</label><input id="deleteUsername" class="input" required></div>
      <div class="field"><label>Email</label><input id="deleteEmail" class="input" type="email" required></div>
      <div class="field"><label>Password</label><input id="deletePassword" class="input" type="password" required></div>
      <button class="button danger" type="submit">Delete Account</button>
    </form>
  </div>`;
}

function bindSettingsForms() {
  $("#settingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await request("accountUpdate", { username: $("#settingsUsername").value, email: $("#settingsEmail").value, password: $("#settingsPassword").value });
      store.session = { ...store.session, user: result.user };
      toast("Account updated.");
      boot();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#deleteAccountForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!confirm("Delete your account and every listing you own?")) return;
    try {
      await request("deleteAccount", { username: $("#deleteUsername").value, email: $("#deleteEmail").value, password: $("#deletePassword").value });
      location.href = route("/");
    } catch (error) {
      toast(error.message);
    }
  });
}

function renderAdmin(state) {
  if (!isAdmin(state.user)) {
    $("#app").innerHTML = `<div class="page"><div class="notice">${escapeHtml(copy("admin.accessRequired", "Admin access is required for this page."))}</div></div>`;
    return;
  }
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head"><div><h1 class="section-title">${escapeHtml(copy("admin.title", "Admin Panel"))}</h1><p class="section-copy">${escapeHtml(copy("admin.body", "Manage servers, sponsorships, clients, users, and bans."))}</p></div></div>
      <div class="grid two">
        <div class="card"><h2>${escapeHtml(copy("admin.serverListingsTitle", "Server Listings"))}</h2><div class="dashboard-list">${state.servers.length ? state.servers.map((server) => `<div class="dash-item">
          <div class="rank">#${server.rank}</div><div><strong>${escapeHtml(server.name)}</strong><p class="server-ip">${escapeHtml(server.javaHost)}</p></div>
          <div class="row-actions"><button class="button" data-admin="toggleSponsor" data-id="${server.id}">${server.sponsored ? "Unsponsor" : "Sponsor"}</button><button class="button danger" data-delete="${server.id}">Delete</button></div>
        </div>`).join("") : emptyNotice()}</div></div>
        <div class="card admin-client-panel">
          <h2>${escapeHtml(copy("admin.sponsoredClientsTitle", "Sponsored Clients"))}</h2>
          <p class="section-copy">${escapeHtml(copy("admin.sponsoredClientsBody", "Create and edit sponsored Minecraft client listings."))}</p>
          ${adminClientPanel(state.clients)}
        </div>
      </div>
    </section>
  </div>`;
  $$("[data-admin]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await request("admin", { command: button.dataset.admin, value: { id: button.dataset.id } });
      boot();
    } catch (error) {
      toast(error.message);
    }
  }));
  $$("[data-delete]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await request("deleteServer", { id: button.dataset.delete });
      boot();
    } catch (error) {
      toast(error.message);
    }
  }));
  bindAdminClientForms(state);
}

function adminClientPanel(clients) {
  return `<div class="dashboard-list admin-client-list">${clients.length ? clients.map((client) => `<div class="dash-item client-admin-row">
    <div class="rank">${escapeHtml(client.pricing === "paid" ? "$" : "0")}</div>
    <div>
      <strong>${escapeHtml(client.name)}</strong>
      <p class="server-ip">${escapeHtml(client.version === "both" ? "Java + Bedrock" : client.version)} | ${escapeHtml(client.url)}</p>
    </div>
    <div class="row-actions">
      <button class="button" data-client-edit="${escapeHtml(client.id)}" type="button">Edit</button>
      <button class="button danger" data-client-delete="${escapeHtml(client.id)}" type="button">Delete</button>
    </div>
  </div>`).join("") : `<p class="section-copy">${escapeHtml(copy("admin.noSponsoredClients", "No sponsored clients yet."))}</p>`}</div>
  <div id="clientFormPanel">${clientFormMarkup()}</div>`;
}

function clientFormMarkup(client = {}) {
  const images = client.images || [];
  return `<form id="clientForm" class="form client-form">
    <input id="clientId" type="hidden" value="${escapeHtml(client.id || "")}">
    <div class="form-grid">
      <div class="field"><label>Client Name</label><input id="clientName" class="input" value="${escapeHtml(client.name || "")}" required></div>
      <div class="field"><label>Website/download link</label><input id="clientUrl" class="input" type="url" value="${escapeHtml(client.url || "")}" required></div>
      <div class="field"><label>YouTube video</label><input id="clientYoutube" class="input" type="url" value="${escapeHtml(client.youtubeUrl || "")}"></div>
      <div class="field"><label>Version</label><select id="clientVersion" class="select">
        <option value="both" ${client.version === "both" || !client.version ? "selected" : ""}>Java and Bedrock</option>
        <option value="java" ${client.version === "java" ? "selected" : ""}>Java</option>
        <option value="bedrock" ${client.version === "bedrock" ? "selected" : ""}>Bedrock</option>
      </select></div>
      <div class="field"><label>Pricing</label><select id="clientPricing" class="select">
        <option value="free" ${client.pricing === "free" || !client.pricing ? "selected" : ""}>Free client</option>
        <option value="paid" ${client.pricing === "paid" ? "selected" : ""}>Paid client</option>
      </select></div>
      <div class="field"><label>Showcase image 1</label><input id="clientImage1" class="input" value="${escapeHtml(images[0] || "")}"></div>
      <div class="field"><label>Showcase image 2</label><input id="clientImage2" class="input" value="${escapeHtml(images[1] || "")}"></div>
    </div>
    <div class="field"><label>Description (${CONFIG.limits.descriptionMinLength}+ characters)</label><textarea id="clientDescription" class="textarea" minlength="${CONFIG.limits.descriptionMinLength}" required>${escapeHtml(client.description || "")}</textarea></div>
    <div class="row-actions">
      <button class="button primary" type="submit">${client.id ? "Save Client" : "Create Sponsored Client"}</button>
      <button id="clearClientForm" class="button" type="button">Clear</button>
    </div>
  </form>`;
}

function bindAdminClientForms(state) {
  $("#clientForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await request("admin", {
        command: "saveClient",
        value: {
          id: $("#clientId").value,
          name: $("#clientName").value,
          url: $("#clientUrl").value,
          youtubeUrl: $("#clientYoutube").value,
          description: $("#clientDescription").value,
          images: [$("#clientImage1").value, $("#clientImage2").value].filter(Boolean),
          version: $("#clientVersion").value,
          pricing: $("#clientPricing").value
        }
      });
      toast("Sponsored client saved.");
      boot();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#clearClientForm")?.addEventListener("click", () => {
    $("#clientFormPanel").innerHTML = clientFormMarkup();
    bindAdminClientForms(state);
  });
  $$("[data-client-edit]").forEach((button) => button.addEventListener("click", () => {
    const client = state.clients.find((item) => item.id === button.dataset.clientEdit);
    $("#clientFormPanel").innerHTML = clientFormMarkup(client);
    bindAdminClientForms(state);
  }));
  $$("[data-client-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Delete this sponsored client listing?")) return;
    try {
      await request("admin", { command: "deleteClient", value: { id: button.dataset.clientDelete } });
      toast("Sponsored client deleted.");
      boot();
    } catch (error) {
      toast(error.message);
    }
  }));
}

function renderStatic(page) {
  const staticCopy = CONFIG.copy?.staticPages?.[page] || ["Page", "This page is ready to configure."];
  setSeoMeta({
    title: `${staticCopy[0]} | ${CONFIG.site.name}`,
    description: staticCopy[1],
    path: `/${page}/`
  });
  $("#app").innerHTML = `<div class="page"><section class="section card"><h1 class="section-title">${escapeHtml(staticCopy[0])}</h1><p class="section-copy">${escapeHtml(staticCopy[1])}</p></section></div>`;
}

async function boot() {
  if (!$("#app")) renderLayout();
  try {
    const state = await getState();
    syncAuthUi(state.user);
    const page = document.body.dataset.page || "home";
    if (page === "home") renderHome(state);
    else if (page === "servers") renderServers(state);
    else if (page === "server") renderServerDetail(state);
    else if (page === "vote") renderVotePage(state);
    else if (page === "sponsored") renderSponsored();
    else if (page === "sponsored-clients") renderClients(state);
    else if (page === "login") renderLogin(state);
    else if (page === "dashboard") renderDashboard(state);
    else if (page === "admin") renderAdmin(state);
    else renderStatic(page);
  } catch (error) {
    $("#app").innerHTML = `<div class="page"><div class="notice">${escapeHtml(error.message)}</div></div>`;
  }
}

document.addEventListener("DOMContentLoaded", boot);
