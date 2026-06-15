const CONFIG = window.ICON_LISTING_CONFIG;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const ALL_TAGS = [...CONFIG.gamemodes, ...CONFIG.generalTags];
const EMPTY_TEXT = "Theres no listing here, Be the first to make one!";

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
    servers: Array.isArray(db.servers) ? db.servers.filter((server) => !String(server.id || "").startsWith("seed-")) : [],
    clients: Array.isArray(db.clients) ? db.clients.filter((client) => !String(client.id || "").startsWith("client-")) : [],
    votes: Array.isArray(db.votes) ? db.votes : [],
    voteIps: db.voteIps && !Array.isArray(db.voteIps) ? db.voteIps : {}
  };
  store.fallbackDb = next;
  return next;
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

function isAdmin(user) {
  return !!user && (CONFIG.admins.users.includes(user.username) || CONFIG.admins.emails.includes(user.email));
}

function authHeaders() {
  return store.session?.token ? { Authorization: `Bearer ${store.session.token}` } : {};
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
      const response = await fetch(`${CONFIG.api.basePath}?action=${encodeURIComponent(action)}`, options);
      const json = await response.json();
      if (!response.ok || json.error) throw new Error(json.error || "Request failed");
      return json;
    } catch (error) {
      if (!CONFIG.api.useLocalFallback) throw error;
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
    const next = { id: crypto.randomUUID(), username: cleanText(payload.username), email: cleanText(payload.email), password: payload.password, banned: false };
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
    const next = {
      ...existing,
      ...server,
      id: server.id || crypto.randomUUID(),
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
    return Promise.resolve({ server: next });
  }
  if (action === "deleteServer") {
    if (!user) return Promise.reject(new Error("Log in before deleting a listing."));
    const server = db.servers.find((item) => item.id === payload.id);
    if (!server) return Promise.reject(new Error("Listing not found."));
    if (server.ownerId !== user.id && !isAdmin(user)) return Promise.reject(new Error("You cannot delete that listing."));
    db.servers = db.servers.filter((item) => item.id !== payload.id);
    db.votes = db.votes.filter((vote) => vote.serverId !== payload.id);
    save();
    return Promise.resolve({ ok: true });
  }
  if (action === "vote") {
    const server = db.servers.find((item) => item.id === payload.serverId);
    const username = cleanText(payload.minecraftUsername || "");
    if (!server) return Promise.reject(new Error("Listing not found."));
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return Promise.reject(new Error("Enter a valid Minecraft username."));
    const vote = { id: crypto.randomUUID(), serverId: server.id, minecraftUsername: username, createdAt: new Date().toISOString() };
    db.votes.push(vote);
    server.votes = db.votes.filter((item) => item.serverId === server.id).length;
    save();
    return Promise.resolve({ ok: true, vote, server });
  }
  if (action === "accountUpdate") {
    if (!user) return Promise.reject(new Error("Log in before editing your account."));
    if (hasBlockedText(payload.username)) return Promise.reject(new Error("That username is not allowed here."));
    if (payload.username) user.username = cleanText(payload.username);
    if (payload.email) user.email = cleanText(payload.email);
    if (payload.password) user.password = payload.password;
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
    }
    if (payload.command === "saveClient") {
      const client = sanitizeClient(payload.value || {});
      const existing = db.clients.find((item) => item.id === client.id);
      db.clients = existing ? db.clients.map((item) => (item.id === existing.id ? client : item)) : [...db.clients, { ...client, id: crypto.randomUUID() }];
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
  return next;
}

function sanitizeClient(client) {
  return {
    id: cleanText(client.id),
    name: cleanText(client.name),
    logoUrl: String(client.logoUrl || "").trim(),
    description: cleanText(client.description),
    url: String(client.url || "").trim()
  };
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
    .map((server) => ({ ...server, votes: votesForServer(votes, server.id).length || server.votes || 0 }))
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

function renderLayout() {
  const page = document.body.dataset.page || "home";
  document.title = `${CONFIG.site.name} | ${pageTitle(page)}`;
  document.body.innerHTML = `<div class="site-shell">
    <header class="topbar">
      <nav class="nav" aria-label="Main navigation">
        <a class="brand" href="${route("/home/")}" aria-label="${CONFIG.site.name} home">
          <img class="brand-icon" src="${asset(CONFIG.site.iconPath)}" alt="">
          <span>${CONFIG.site.name}</span>
        </a>
        <button class="mobile-toggle" type="button" aria-label="Toggle menu">Menu</button>
        <div class="nav-links">
          <a class="nav-link" data-route="home" href="${route("/home/")}">Home</a>
          <div class="dropdown">
            <button class="drop-button" type="button">Servers <span aria-hidden="true">v</span></button>
            <div class="dropdown-menu">
              <div class="dropdown-section-title">Gamemodes</div>
              <div class="tag-grid">${CONFIG.gamemodes.map((tag) => `<a class="tag-link" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${tag}</a>`).join("")}</div>
              <div class="dropdown-section-title" style="margin-top:14px">General Tags</div>
              <div class="tag-grid">${CONFIG.generalTags.map((tag) => `<a class="tag-link" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${tag}</a>`).join("")}</div>
            </div>
          </div>
          <a class="nav-link" data-route="sponsored" href="${route("/sponsored/")}">Sponsored</a>
          <a class="nav-link" data-route="sponsored-clients" href="${route("/sponsored-clients/")}">Sponsored Clients</a>
          <a class="nav-link hidden" data-auth="dashboard" data-route="dashboard" href="${route("/dashboard/")}">Dashboard</a>
          <a class="nav-link hidden" data-auth="admin" data-route="admin" href="${route("/admin/")}">Admin</a>
          <a class="nav-link" data-auth="login" data-route="login" href="${route("/login/")}">Login</a>
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
    <h2>${EMPTY_TEXT}</h2>
    <p>New servers show up here as soon as someone submits a listing.</p>
    <a class="button primary" href="${store.session ? route("/dashboard/") : route("/login/")}">Add a Server</a>
  </div>`;
}

function serverCard(server) {
  const banner = server.bannerUrl ? `background-image:url('${escapeHtml(asset(server.bannerUrl))}')` : "";
  return `<article class="server-card ${server.sponsored ? "sponsored" : ""}" data-server-id="${escapeHtml(server.id)}">
    <a class="server-card-link" href="${route(`/server/?id=${encodeURIComponent(server.id)}`)}" aria-label="Open ${escapeHtml(server.name)} listing"></a>
    <div class="rank">${server.sponsored ? `<span class="star">★</span>` : ""}#${server.rank || "-"}</div>
    <div class="banner" style="${banner}" role="img" aria-label="${escapeHtml(server.name)} banner"></div>
    <div class="server-main">
      <h3 class="server-title">${escapeHtml(server.name)} ${server.sponsored ? `<span class="pill">Sponsored</span>` : ""}</h3>
      <p class="server-ip">${escapeHtml(server.javaHost)}:${Number(server.javaPort || CONFIG.defaults.javaPort)}</p>
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
    <input id="searchInput" class="input" type="search" placeholder="Search by name, IP, or tag" autocomplete="off">
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

function renderHome(state) {
  const sponsored = state.servers.filter((server) => server.sponsored);
  $("#app").innerHTML = `<div class="page">
    <section class="hero-band compact">
      <div class="hero-content">
        <div class="eyebrow">Minecraft server lists, without the clutter</div>
        <h1 class="hero-title"><span>${CONFIG.site.name}</span></h1>
        <p class="hero-copy">Browse Minecraft servers by gamemode, check live status, and vote for the communities you actually play on.</p>
        <div class="hero-actions">
          <a class="button primary" href="${route("/servers/")}">Browse Servers</a>
          <a class="button" href="${state.user ? route("/dashboard/") : route("/login/")}">${state.user ? "Manage Listings" : "Add Your Server"}</a>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">Sponsored Servers</h2>
          <p class="section-copy">Paid placements appear here first, clearly marked with a star.</p>
        </div>
      </div>
      <div id="sponsoredList" class="server-list"></div>
    </section>
    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">All Servers</h2>
          <p class="section-copy">Rankings use live player counts and real community votes.</p>
        </div>
      </div>
      ${toolbarMarkup()}
      <div id="serverList" class="server-list"></div>
    </section>
  </div>`;
  renderServerList(sponsored, "#sponsoredList");
  setupFilters(state.servers);
}

function renderServers(state) {
  const tag = new URLSearchParams(location.search).get("tag") || "";
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">${tag ? `${escapeHtml(tag)} Servers` : "Servers"}</h1>
          <p class="section-copy">Use the filters to find a server that fits how you play.</p>
        </div>
      </div>
      ${toolbarMarkup(tag)}
      <div id="serverList" class="server-list"></div>
    </section>
  </div>`;
  setupFilters(state.servers);
}

function renderServerDetail(state) {
  const id = new URLSearchParams(location.search).get("id");
  const server = state.servers.find((item) => item.id === id);
  if (!server) {
    $("#app").innerHTML = `<div class="page">${emptyNotice()}</div>`;
    return;
  }
  const banner = server.bannerUrl ? `background-image:url('${escapeHtml(asset(server.bannerUrl))}')` : "";
  const owner = server.ownerName || "Server owner";
  $("#app").innerHTML = `<div class="page detail-layout">
    <aside class="info-panel">
      <h1>${escapeHtml(server.name)}</h1>
      ${infoRow("Owner", owner)}
      ${infoRow("Status", `<span class="status inline"><span class="dot ${server.online ? "online" : ""}"></span>${server.online ? "Online" : "Offline"}</span>`)}
      ${infoRow("Java IP", `${escapeHtml(server.javaHost)}:${Number(server.javaPort || CONFIG.defaults.javaPort)}`)}
      ${server.crossPlay ? infoRow("Bedrock IP", `${escapeHtml(server.bedrockHost)}:${Number(server.bedrockPort || CONFIG.defaults.bedrockPort)}`) : ""}
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
      <div class="tabs"><button class="tab active">Info</button><button class="tab">Stats</button><button class="tab">Banners</button><button class="tab">Trailer</button></div>
      <div class="detail-body">
        <div class="detail-banner" style="${banner}"></div>
        <p>${escapeHtml(server.description)}</p>
        <div class="grid two">
          <div class="mini-stat"><strong>${Number(server.playersOnline || 0).toLocaleString()}</strong><span>players online</span></div>
          <div class="mini-stat"><strong>${Number(server.votes || 0).toLocaleString()}</strong><span>total votes</span></div>
        </div>
      </div>
      <a class="button vote-wide" href="${route(`/vote/?server=${encodeURIComponent(server.id)}`)}">Vote for ${escapeHtml(server.name)}</a>
    </section>
  </div>`;
}

function infoRow(label, value) {
  return `<div class="info-row"><strong>${label}</strong><span>${value}</span></div>`;
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
    $("#app").innerHTML = `<div class="page">${emptyNotice()}</div>`;
    return;
  }
  const leaderboard = voteLeaderboard(state.votes, server.id);
  $("#app").innerHTML = `<div class="page vote-layout">
    <section class="card form">
      <h1 class="section-title">Vote for ${escapeHtml(server.name)}</h1>
      <p class="section-copy">Enter your Minecraft username so this vote can count on the monthly board.</p>
      <form id="voteForm" class="form">
        <div class="field"><label>Minecraft Username</label><input id="minecraftUsername" class="input" autocomplete="username" minlength="3" maxlength="16" pattern="[A-Za-z0-9_]{3,16}" required></div>
        <button class="button primary" type="submit">Submit Vote</button>
      </form>
    </section>
    <aside class="card">
      <h2>votes this month</h2>
      <div class="leaderboard">${leaderboard.length ? leaderboard.map((item, index) => `<div class="leader-row"><strong>#${index + 1} ${escapeHtml(item.minecraftUsername)}</strong><span>${item.votes}</span></div>`).join("") : `<p class="section-copy">No monthly votes yet.</p>`}</div>
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
  $("#app").innerHTML = `<div class="page">
    <section class="hero-band compact">
      <div class="hero-content">
        <div class="eyebrow">Paid placements</div>
        <h1 class="hero-title"><span>Sponsored Servers</span></h1>
        <p class="hero-copy">Sponsorship is for server owners who want their listing placed above normal results while still being clearly labeled.</p>
        <div class="hero-actions"><a class="button primary" href="${CONFIG.site.discordUrl}">Apply on Discord</a></div>
      </div>
    </section>
    <section class="section grid two">
      <div class="card">
        <h2>What sponsors get</h2>
        <ul class="feature-list">${CONFIG.sponsorship.benefits.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>
      <div class="card">
        <h2>How to apply</h2>
        <p class="section-copy">${escapeHtml(CONFIG.sponsorship.applicationText)}</p>
      </div>
    </section>
  </div>`;
}

function renderClients(state) {
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">Sponsored Clients</h1>
          <p class="section-copy">Approved client promotions will appear here after staff adds them.</p>
        </div>
      </div>
      <div class="grid three">${state.clients.length ? state.clients.map((client) => `<article class="card client-card">
        <div class="client-logo" style="background-image:url('${escapeHtml(asset(client.logoUrl))}')"></div>
        <h2>${escapeHtml(client.name)}</h2>
        <p class="section-copy">${escapeHtml(client.description)}</p>
        <a class="button primary" href="${escapeHtml(client.url)}">Visit</a>
      </article>`).join("") : emptyNotice()}</div>
    </section>
  </div>`;
}

function renderLogin(state) {
  if (state.user) {
    $("#app").innerHTML = `<div class="page"><div class="card"><h1>You are logged in as ${escapeHtml(state.user.username)}.</h1><button id="logoutButton" class="button danger">Logout</button></div></div>`;
    $("#logoutButton").addEventListener("click", () => {
      store.session = null;
      location.href = route("/home/");
    });
    return;
  }
  $("#app").innerHTML = `<div class="page">
    <section class="section grid two">
      <form id="loginForm" class="card form">
        <h1 class="section-title">Login</h1>
        <p class="section-copy">Welcome back. Log in to manage your listings.</p>
        <div class="field"><label>Username or email</label><input id="loginName" class="input" required></div>
        <div class="field"><label>Password</label><input id="loginPassword" class="input" type="password" required></div>
        <button class="button primary" type="submit">Login</button>
        <p class="section-copy">Don't have an account? <a class="pill" href="#signup">Sign up here!</a></p>
      </form>
      <form id="signup" class="card form">
        <h2 class="section-title">Sign Up</h2>
        <p class="section-copy">Create an account so you can submit and manage servers.</p>
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
    $("#app").innerHTML = `<div class="page"><div class="notice">Log in to add and manage server listings.</div><div class="row-actions"><a class="button primary" href="${route("/login/")}">Login</a></div></div>`;
    return;
  }
  const mine = state.servers.filter((server) => server.ownerId === state.user.id);
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">Dashboard</h1>
          <p class="section-copy">Your listings, ranks, and account tools are all in one place.</p>
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
        <button id="addServerButton" class="button primary">+ Add Server</button>
        <button id="settingsButton" class="button">Account Settings</button>
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
      location.href = route("/home/");
    } catch (error) {
      toast(error.message);
    }
  });
}

function renderAdmin(state) {
  if (!isAdmin(state.user)) {
    $("#app").innerHTML = `<div class="page"><div class="notice">Admin access is required for this page.</div></div>`;
    return;
  }
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head"><div><h1 class="section-title">Admin Panel</h1><p class="section-copy">Manage servers, sponsorships, clients, users, and bans.</p></div></div>
      <div class="grid two">
        <div class="card"><h2>Server Listings</h2><div class="dashboard-list">${state.servers.length ? state.servers.map((server) => `<div class="dash-item">
          <div class="rank">#${server.rank}</div><div><strong>${escapeHtml(server.name)}</strong><p class="server-ip">${escapeHtml(server.javaHost)}</p></div>
          <div class="row-actions"><button class="button" data-admin="toggleSponsor" data-id="${server.id}">${server.sponsored ? "Unsponsor" : "Sponsor"}</button><button class="button danger" data-delete="${server.id}">Delete</button></div>
        </div>`).join("") : emptyNotice()}</div></div>
        <div class="card"><h2>Sponsored Clients</h2><p class="section-copy">Add client promotions through the API or extend this panel for your staff workflow.</p>${state.clients.length ? "" : emptyNotice()}</div>
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
}

function renderStatic(page) {
  const copy = {
    terms: ["Terms", "Use Icon Listing honestly. Do not submit listings you do not control, spam the vote system, or post unsafe content."],
    privacy: ["Privacy", "Icon Listing stores account details, listings, votes, and moderation data needed to run the site."],
    help: ["Help", "Need help with a listing, vote, sponsorship, or account? Join the Discord or contact the IconRealms team."],
    contact: ["Contact", `Reach ${CONFIG.site.owner} at ${CONFIG.site.contactEmail} or through Discord.`]
  }[page] || ["Page", "This page is ready to configure."];
  $("#app").innerHTML = `<div class="page"><section class="section card"><h1 class="section-title">${copy[0]}</h1><p class="section-copy">${copy[1]}</p></section></div>`;
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
