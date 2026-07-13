const CONFIG = window.ICON_LISTING_CONFIG;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const ALL_TAGS = [...CONFIG.gamemodes, ...CONFIG.generalTags];
const ANALYTICS_DAYS = 30;
const PLAYER_HISTORY_LIMIT = 48;
const COPY_HASHES_PER_DAY_LIMIT = 120;
const DURABLE_CLIENT_ACTIONS = new Set(["register", "saveServer", "deleteServer", "vote", "trackCopy", "accountUpdate", "deleteAccount", "verifyEmail", "resendEmailVerification", "pluginPoll", "testPluginVote", "admin"]);
const TRUSTPILOT_REVIEW_URL = "https://www.trustpilot.com/review/minecraft-listing.iconrealms.net";
let turnstileLoadPromise = null;
const renderedTurnstileWidgets = new Map();
let publicSnapshotPromise = null;

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
  get pendingVerification() {
    try {
      return JSON.parse(sessionStorage.getItem("iconListingPendingVerification") || "null");
    } catch {
      return null;
    }
  },
  set pendingVerification(value) {
    if (value) sessionStorage.setItem("iconListingPendingVerification", JSON.stringify(value));
    else sessionStorage.removeItem("iconListingPendingVerification");
  },
  get fallbackDb() {
    const saved = localStorage.getItem("iconListingDb");
    if (saved) return migrateDb(JSON.parse(saved));
    return freshDb();
  },
  set fallbackDb(value) {
    localStorage.setItem("iconListingDb", JSON.stringify(value));
  },
  get publicState() {
    try {
      return JSON.parse(sessionStorage.getItem("iconListingPublicState") || "null");
    } catch {
      return null;
    }
  },
  set publicState(value) {
    if (value) sessionStorage.setItem("iconListingPublicState", JSON.stringify(value));
    else sessionStorage.removeItem("iconListingPublicState");
  }
};

function clearLegacyLocalOverlays() {
  try {
    localStorage.removeItem("iconListingConfirmedWrites");
  } catch {
    // Some browsers block storage. Shared API state still works without it.
  }
}

function freshDb() {
  return { version: 2, users: [], servers: [], clients: [], hosts: [], votes: [], voteIps: {} };
}

function migrateDb(db) {
  const next = {
    ...freshDb(),
    ...db,
    version: 2,
    users: Array.isArray(db.users) ? db.users : [],
    servers: Array.isArray(db.servers) ? db.servers.filter((server) => !String(server.id || "").startsWith("seed-")).map(normalizeServer) : [],
    clients: Array.isArray(db.clients) ? db.clients.filter((client) => !String(client.id || "").startsWith("client-")).map(normalizeClient) : [],
    hosts: Array.isArray(db.hosts) ? db.hosts.filter((host) => !String(host.id || "").startsWith("host-")).map(normalizeHost) : [],
    votes: Array.isArray(db.votes) ? db.votes : [],
    voteIps: db.voteIps && !Array.isArray(db.voteIps) ? db.voteIps : {}
  };
  store.fallbackDb = next;
  return next;
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
    iconUrl: normalizeMinecraftIcon(server.iconUrl || ""),
    votifierType: cleanVotifierType(server.votifierType || "auto"),
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
  const duration = /error|unavailable|failed|not|cannot|could not|refresh/i.test(String(message || "")) ? 8500 : 4200;
  window.setTimeout(() => node.remove(), duration);
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

function clean(value = "") {
  return String(value || "").trim();
}

function cleanText(value = "") {
  let next = clean(value);
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
  return store.session?.token ? { Authorization: `Bearer ${store.session.token}`, "X-IconListing-Token": store.session.token } : {};
}

function isLocalFallbackAllowed() {
  return !!CONFIG.api.useLocalFallback && (location.protocol === "file:" || (CONFIG.api.localFallbackHosts || []).includes(location.hostname));
}

function apiBasePaths() {
  const productionBase = CONFIG.api.productionBasePath || "";
  const sameOriginBase = CONFIG.api.basePath || "/api";
  return [...new Set([productionBase, sameOriginBase].filter(Boolean))];
}

function apiActionUrl(action, params = {}) {
  const basePath = apiBasePaths()[0] || "/api";
  const search = new URLSearchParams({ action, ...params });
  return `${basePath}${basePath.includes("?") ? "&" : "?"}${search.toString()}`;
}

function googleStartUrl() {
  return apiActionUrl("googleStart", { next: "/dashboard/" });
}

function productionApiMessage() {
  return "This action could not be completed right now. Please try again.";
}

function networkApiMessage() {
  return "Error: network error. Refreshing...";
}

function isNetworkAbort(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.name === "AbortError" || message.includes("signal is aborted") || message.includes("aborted without reason") || message.includes("failed to fetch") || message.includes("networkerror");
}

function isInternalApiMessage(value = "") {
  return /error\s*:?\s*67|shared storage|permanent storage|temporarily unavailable/i.test(String(value || ""));
}

function publicApiMessage(action, status) {
  if (action === "vote" && status === 429) return "You can only vote once every 24 hours.";
  if (action === "vote") return "Vote could not be counted. Please try again.";
  if (status === 401) return "Log in again before doing that.";
  if (status === 403) return "You do not have permission to do that.";
  if (status === 404 && ["deleteServer", "trackCopy"].includes(action)) return "That listing could not be found.";
  if (status === 409) return "That listing already exists.";
  return productionApiMessage();
}

function publicRequestError(action, error) {
  if (action === "vote" && error?.status === 429) return "You can only vote once every 24 hours.";
  if (action === "vote") return error?.publicMessage || "Vote could not be counted. Please try again.";
  if ([401, 403, 404, 409].includes(Number(error?.status))) return publicApiMessage(action, Number(error.status));
  if (Number(error?.status) >= 500 || isInternalApiMessage(error?.message) || isInternalApiMessage(error?.publicMessage)) return productionApiMessage();
  if (isNetworkAbort(error) || isNetworkAbort(error?.originalError)) return networkApiMessage();
  return error?.publicMessage || error?.message || productionApiMessage();
}

function publicDurableFailure(action, error) {
  const next = new Error(publicRequestError(action, error));
  next.originalError = error;
  return next;
}

function requireDurableResult(action, result) {
  if (!DURABLE_CLIENT_ACTIONS.has(action)) return;
  if (result?.durable) return;
  const error = new Error("Permanent storage is not connected. Error: 67.");
  error.publicMessage = productionApiMessage();
  throw error;
}

async function request(action, payload = {}, method = "POST") {
  if (location.protocol !== "file:") {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), CONFIG.api.requestTimeoutMs);
    try {
      const options = {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        signal: controller.signal,
        cache: "no-store"
      };
      if (method !== "GET") options.body = JSON.stringify(payload);
      let lastError = null;
      for (const basePath of apiBasePaths()) {
        try {
          const params = new URLSearchParams({ action });
          if (method === "GET") {
            Object.entries(payload || {}).forEach(([key, value]) => {
              if (value !== undefined && value !== null && value !== "") params.set(key, value);
            });
          }
          const url = `${basePath}${basePath.includes("?") ? "&" : "?"}${params.toString()}`;
          const response = await fetch(url, options);
          let json = null;
          try {
            json = await response.json();
          } catch {
            const error = new Error(response.ok ? "The site service returned an unreadable response. Please try again." : publicApiMessage(action, response.status));
            error.status = response.status;
            const contentType = response.headers.get("content-type") || "";
            error.stopRetry = response.status >= 400 && response.status < 500 && contentType.includes("application/json");
            throw error;
          }
          if (!response.ok || json.error) {
            const error = new Error(json.error || publicApiMessage(action, response.status));
            error.status = response.status;
            if (action === "vote" || !json.error) error.publicMessage = publicApiMessage(action, response.status);
            error.stopRetry = response.status >= 400 && response.status < 500;
            throw error;
          }
          requireDurableResult(action, json);
          return json;
        } catch (error) {
          lastError = error;
          if (isNetworkAbort(error)) {
            error.publicMessage = networkApiMessage();
          }
          if (error.stopRetry) throw error;
        }
      }
      throw lastError || new Error(productionApiMessage());
    } catch (error) {
      if (DURABLE_CLIENT_ACTIONS.has(action)) throw publicDurableFailure(action, error);
      if (!isLocalFallbackAllowed()) {
        const next = new Error(publicRequestError(action, error));
        next.originalError = error;
        throw next;
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }
  if (DURABLE_CLIENT_ACTIONS.has(action)) throw new Error(productionApiMessage());
  return fallbackRequest(action, payload);
}

function publicUser(user) {
  if (!user) return null;
  const plan = planConfigForUser(user);
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    plan: plan.key,
    planName: plan.name,
    serverLimit: serverLimitForUser(user),
    sponsorCredits: Number(plan.sponsorCredits || 0),
    sponsorDurationDays: Number(plan.sponsorDurationDays || 0),
    emailOptIn: user.emailOptIn === true,
    emailVerified: user.emailVerified === true,
    emailVerificationPending: user.emailVerified !== true && (!!user.emailVerification?.codeHash || !!user.emailVerificationCode),
    passwordLogin: !!user.password,
    googleLinked: !!user.googleSub,
    admin: isAdmin(user),
    banned: !!user.banned
  };
}

function publicClientState(state = {}, options = {}) {
  const servers = Array.isArray(state.servers) ? state.servers.map(publicClientServer) : [];
  const votes = Array.isArray(state.votes) ? state.votes : [];
  return {
    users: [],
    servers: rankServers(servers, votes),
    clients: (Array.isArray(state.clients) ? state.clients : []).map(normalizeClient),
    hosts: (Array.isArray(state.hosts) ? state.hosts : []).map(normalizeHost),
    votes,
    user: options.user === undefined ? (store.session?.user || null) : options.user,
    apiHydrating: !!options.apiHydrating
  };
}

function publicClientServer(server = {}) {
  const next = normalizeServer({ ...server });
  next.bannerUrl = publicListImage(next.bannerUrl, next, "banner");
  next.iconUrl = publicListImage(next.iconUrl, next, "icon");
  delete next.votifierToken;
  delete next.iconListingVoteKey;
  delete next.iconListingVoteQueue;
  return next;
}

function publicListImage(value = "", server = null, kind = "banner") {
  const image = clean(value);
  if (/^data:image\//i.test(image) && image.length > 12000) {
    return server?.id || server?.name ? apiActionUrl("serverImage", { slug: serverSlug(server.name, server.id), kind }) : "";
  }
  return image;
}

function cachePublicState(state) {
  try {
    store.publicState = publicClientState(state, { user: null, apiHydrating: false });
  } catch {
    // Public cache is only a speed/SEO fallback.
  }
}

function planConfigForUser(user) {
  const plans = CONFIG.plans || {};
  const key = normalizePlanKey(user?.plan || user?.subscriptionPlan || "free");
  return { key, ...(plans[key] || plans.free || { name: "Free", serverLimit: 2, sponsorCredits: 0, sponsorDurationDays: 0 }) };
}

function normalizePlanKey(value = "") {
  const key = String(value || "free").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return CONFIG.plans?.[key] ? key : "free";
}

function serverLimitForUser(user) {
  if (isAdmin(user)) return 999;
  return Math.max(0, Number(planConfigForUser(user).serverLimit || 2));
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
    const detailServerId = clean(payload.serverId || payload.server || "");
    return Promise.resolve({
      servers: rankServers(db.servers, db.votes).map((server) => ({
        ...server,
        analytics: publicAnalytics(server, { full: server.id === detailServerId })
      })),
      clients: db.clients,
      hosts: db.hosts,
      user: publicUser(user),
      votes: detailServerId ? db.votes.filter((vote) => vote.serverId === detailServerId && String(vote.createdAt || "").startsWith(new Date().toISOString().slice(0, 7))) : []
    });
  }
  if (action === "register") {
    if (!payload.username || !payload.email || !payload.password) return Promise.reject(new Error("Fill out every signup field."));
    if (payload.termsAccepted !== true) return Promise.reject(new Error("You must accept the terms and conditions."));
    if (hasBlockedText(payload.username)) return Promise.reject(new Error("That username is not allowed here."));
    const exists = db.users.some((item) => same(item.email, payload.email) || same(item.username, payload.username));
    if (exists) return Promise.reject(new Error("That username or email is already taken."));
    const emailOptIn = payload.emailOptIn === true;
    const next = {
      id: createId(),
      username: cleanText(payload.username),
      email: cleanText(payload.email),
      password: payload.password,
      emailOptIn,
      emailOptInAt: emailOptIn ? new Date().toISOString() : "",
      emailVerified: false,
      emailVerifiedAt: "",
      emailVerificationCode: "000000",
      termsAcceptedAt: new Date().toISOString(),
      banned: false
    };
    db.users.push(next);
    save();
    return Promise.resolve({ pendingVerification: true, user: publicUser(next), verificationToken: `local-${next.id}`, emailVerificationMessage: "Local preview code is 000000." });
  }
  if (action === "login") {
    const next = db.users.find((item) => (same(item.email, payload.login) || same(item.username, payload.login)) && item.password === payload.password && !item.banned);
    if (!next) return Promise.reject(new Error("That login did not match an account."));
    if (next.emailVerified !== true) {
      next.emailVerificationCode = "000000";
      save();
      return Promise.resolve({ pendingVerification: true, user: publicUser(next), verificationToken: `local-${next.id}`, emailVerificationMessage: "Local preview code is 000000." });
    }
    store.session = { token: `local-${next.id}`, user: publicUser(next) };
    return Promise.resolve({ user: publicUser(next), token: store.session.token });
  }
  if (action === "votifierToolTest" || action === "testVote") {
    return Promise.reject(new Error("Votifier testing needs the production API."));
  }
  if (action === "saveServer") {
    if (!user) return Promise.reject(new Error("Log in before adding a server."));
    const server = sanitizeServer(payload.server || {});
    const existing = db.servers.find((item) => item.id === server.id);
    if (existing && existing.ownerId !== user.id && !isAdmin(user)) return Promise.reject(new Error("You cannot edit that listing."));
    if (!existing) {
      const limit = serverLimitForUser(user);
      const owned = db.servers.filter((item) => item.ownerId === user.id).length;
      if (!isAdmin(user) && owned >= limit) {
        const plan = planConfigForUser(user);
        return Promise.reject(new Error(`Your ${plan.name} plan allows ${limit} server listings. Delete a listing or upgrade your plan to add another.`));
      }
    }
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
    if (next.iconListingPluginEnabled && !next.iconListingVoteKey) next.iconListingVoteKey = createVoteKey();
    ensureUniqueVoteKey(db, next, existing?.id || next.id);
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
    const previousVoteCount = displayedVoteCount(server, db.votes);
    const vote = { id: createId(), serverId: server.id, minecraftUsername: username, createdAt: new Date().toISOString() };
    db.votes.push(vote);
    queueIconListingPluginVote(server, vote);
    recordVoteCooldown(db, server.id, username);
    server.votes = Math.max(previousVoteCount + 1, db.votes.filter((item) => item.serverId === server.id).length);
    save();
    return Promise.resolve({ ok: true, vote, server: { ...server, analytics: publicAnalytics(server, { full: true }) } });
  }
  if (action === "trackCopy") {
    const server = db.servers.find((item) => item.id === payload.serverId);
    if (!server) return Promise.reject(new Error("Listing not found."));
    recordLocalIpCopy(server);
    save();
    return Promise.resolve({ ok: true, analytics: publicAnalytics(server, { full: true }) });
  }
  if (action === "accountUpdate") {
    if (!user) return Promise.reject(new Error("Log in before editing your account."));
    if (hasBlockedText(payload.username)) return Promise.reject(new Error("That username is not allowed here."));
    if (payload.username) user.username = cleanText(payload.username);
    if (payload.email && !same(payload.email, user.email)) {
      user.email = cleanText(payload.email);
      user.emailVerified = false;
      user.emailVerifiedAt = "";
      user.emailVerificationCode = "000000";
    }
    if (payload.password) user.password = payload.password;
    try {
      ensureUniqueUser(db, user, user.id);
    } catch (error) {
      return Promise.reject(error);
    }
    save();
    store.session = { ...store.session, user: publicUser(user) };
    return Promise.resolve({ user: publicUser(user), token: store.session.token });
  }
  if (action === "verifyEmail") {
    const target = user || db.users.find((item) => `local-${item.id}` === payload.verificationToken);
    if (!target) return Promise.reject(new Error("Verification session expired. Log in or sign up again."));
    if (target.emailVerified) return Promise.resolve({ ok: true, user: publicUser(target), token: store.session?.token || `local-${target.id}`, message: "Email is already verified." });
    if (clean(payload.code).replace(/\s+/g, "") !== clean(target.emailVerificationCode || "000000")) {
      return Promise.reject(new Error("That verification code did not match."));
    }
    target.emailVerified = true;
    target.emailVerifiedAt = new Date().toISOString();
    delete target.emailVerificationCode;
    save();
    store.session = { token: `local-${target.id}`, user: publicUser(target) };
    return Promise.resolve({ ok: true, user: publicUser(target), token: store.session.token, message: "Email verified." });
  }
  if (action === "resendEmailVerification") {
    const target = user || db.users.find((item) => `local-${item.id}` === payload.verificationToken);
    if (!target) return Promise.reject(new Error("Verification session expired. Log in or sign up again."));
    if (target.emailVerified) return Promise.resolve({ ok: true, user: publicUser(target), token: store.session?.token || `local-${target.id}`, message: "Email is already verified." });
    target.emailVerificationCode = "000000";
    save();
    return Promise.resolve({ ok: true, sent: false, user: publicUser(target), verificationToken: `local-${target.id}`, message: "Local preview code is 000000. Production sends this with Resend." });
  }
  if (action === "deleteAccount") {
    if (!user) return Promise.reject(new Error("Log in before deleting your account."));
    const passwordRequired = !!user.password;
    const identityMatches = same(payload.username, user.username) && same(payload.email, user.email);
    const passwordMatches = passwordRequired ? payload.password === user.password : same(payload.confirmEmail || payload.email, user.email);
    if (!identityMatches || !passwordMatches) {
      return Promise.reject(new Error("Those details do not match your account."));
    }
    db.users = db.users.filter((item) => item.id !== user.id);
    db.servers = db.servers.filter((item) => item.ownerId !== user.id);
    pruneVoteCooldowns(db);
    save();
    store.session = null;
    return Promise.resolve({ ok: true });
  }
  if (action === "admin") {
    if (!isAdmin(user)) return Promise.reject(new Error("Admin access required."));
    const id = payload.value?.id;
    if (payload.command === "listUsers") {
      return Promise.resolve({ users: db.users.map(publicUser) });
    }
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
    if (payload.command === "saveHost") {
      const host = sanitizeHost(payload.value || {});
      const existing = db.hosts.find((item) => item.id === host.id);
      const next = { ...existing, ...host, id: existing?.id || host.id || createId(), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      db.hosts = existing ? db.hosts.map((item) => (item.id === existing.id ? next : item)) : [...db.hosts, next];
    }
    if (payload.command === "deleteHost") {
      db.hosts = db.hosts.filter((item) => item.id !== id);
    }
    save();
    return Promise.resolve({ users: db.users.map(publicUser), servers: rankServers(db.servers, db.votes), clients: db.clients, hosts: db.hosts });
  }
  return Promise.reject(new Error("Unknown action."));
}

function sanitizeServer(server) {
  const tags = Array.isArray(server.tags) ? server.tags.filter((tag) => ALL_TAGS.includes(tag)).slice(0, CONFIG.limits.tagsMax) : [];
  const edition = server.edition === "bedrock" ? "bedrock" : "java";
  const bedrockType = server.bedrockType === "realm" ? "realm" : "server";
  const next = {
    id: cleanText(server.id),
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
    votifierType: cleanVotifierType(server.votifierType || "auto"),
    votifierHost: cleanText(server.votifierHost),
    votifierPort: Number(server.votifierPort || 8192),
    votifierToken: cleanText(server.votifierToken),
    iconListingPluginEnabled: !!server.iconListingPluginEnabled,
    iconListingVoteKey: cleanVoteKey(server.iconListingVoteKey),
    websiteUrl: cleanText(server.websiteUrl),
    discordUrl: cleanText(server.discordUrl),
    youtubeUrl: cleanText(server.youtubeUrl),
    country: cleanText(server.country),
    bannerUrl: String(server.bannerUrl || "").trim(),
    description: cleanText(server.description),
    tags
  };
  if (!next.name) throw new Error("Server name is required.");
  if (next.edition === "java" && !next.javaHost) throw new Error("Java host is required.");
  if (next.edition === "java" && next.crossPlay && !next.bedrockHost) throw new Error("Bedrock host is required for cross-play listings.");
  if (next.edition === "bedrock" && next.bedrockType === "server" && !next.bedrockHost) throw new Error("Bedrock server IP or host is required.");
  if (next.edition === "bedrock" && next.bedrockType === "realm" && !next.realmCode) throw new Error("Realm code is required.");
  if (next.description.length < CONFIG.limits.descriptionMinLength) throw new Error(`Description must be at least ${CONFIG.limits.descriptionMinLength} characters.`);
  if (next.iconListingVoteKey && !isValidVoteKey(next.iconListingVoteKey)) throw new Error("IconListing vote key must be 12-96 characters using letters, numbers, dots, dashes, underscores, or colons.");
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

function ensureUniqueVoteKey(db, server, currentId = "") {
  const key = cleanVoteKey(server.iconListingVoteKey);
  if (!key) return;
  for (const existing of db.servers || []) {
    if (existing.id && existing.id === currentId) continue;
    if (sameVoteKey(existing.iconListingVoteKey, key)) throw new Error("That IconListing vote plugin key is already being used.");
  }
}

function createVoteKey() {
  const bytes = window.crypto?.getRandomValues ? window.crypto.getRandomValues(new Uint8Array(18)) : Array.from({ length: 18 }, () => Math.floor(Math.random() * 256));
  return `ilv_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function cleanVoteKey(value = "") {
  return cleanText(value).replace(/\s+/g, "");
}

function cleanVotifierType(value = "") {
  const next = String(value || "").toLowerCase();
  if (next === "votifier") return "votifier";
  if (next === "auto") return "auto";
  if (next === "azuvotifier") return "azuvotifier";
  return "nuvotifier";
}

function normalizeMinecraftIcon(value = "") {
  const icon = String(value || "").trim();
  if (!icon || icon.length > 30000) return "";
  if (/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(icon)) return icon;
  if (/^https?:\/\//i.test(icon)) return icon;
  return "";
}

function sameVoteKey(a = "", b = "") {
  return cleanVoteKey(a).toLowerCase() === cleanVoteKey(b).toLowerCase();
}

function isValidVoteKey(value = "") {
  return /^[A-Za-z0-9._:-]{12,96}$/.test(cleanVoteKey(value));
}

function normalizeIconListingVoteQueue(queue = []) {
  if (!Array.isArray(queue)) return [];
  return queue
    .filter((item) => item?.id && item?.minecraftUsername)
    .map((item) => ({
      id: cleanText(item.id),
      voteId: cleanText(item.voteId),
      serverId: cleanText(item.serverId),
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

function sanitizeHost(host) {
  const images = Array.isArray(host.images) ? host.images : [host.imageUrl1, host.imageUrl2, host.imageUrl3, host.logoUrl].filter(Boolean);
  const next = {
    id: cleanText(host.id),
    name: cleanText(host.name),
    description: cleanText(host.description),
    url: String(host.url || host.websiteUrl || "").trim(),
    youtubeUrl: String(host.youtubeUrl || "").trim(),
    images: images.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3),
    pricing: "paid"
  };
  if (!next.name) throw new Error("Host name is required.");
  if (!next.url) throw new Error("Website link is required.");
  if (hasBlockedText(host.name) || hasBlockedText(host.description)) throw new Error("Please remove blocked words from the host listing.");
  if (next.description.length < CONFIG.limits.descriptionMinLength) throw new Error(`Host description must be at least ${CONFIG.limits.descriptionMinLength} characters.`);
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
    throw new Error("You can only vote once every 24 hours.");
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
  const voteCount = displayedVoteCount(server, votes);
  return (server.playersOnline || 0) * CONFIG.ranking.playerWeight + voteCount * CONFIG.ranking.voteWeight + (server.sponsored ? CONFIG.ranking.sponsoredBoost : 0);
}

function rankServers(servers, votes = []) {
  return [...servers]
    .map((server) => ({ ...server, votes: displayedVoteCount(server, votes), analytics: publicAnalytics(server, { full: !!server.analytics?.playerHistory || !!server.analytics?.ipCopyDaily }) }))
    .sort((a, b) => scoreServer(b, votes) - scoreServer(a, votes))
    .map((server, index) => ({ ...server, rank: index + 1 }));
}

function displayedVoteCount(server, votes = []) {
  return Math.max(votesForServer(votes, server.id).length, Number(server.votes || 0));
}

async function getState() {
  const page = document.body.dataset.page || "home";
  const params = new URLSearchParams(location.search);
  const detailServerId = ["server", "vote"].includes(page) ? (params.get("id") || params.get("server")) : "";
  const detailServerSlug = page === "server" ? serverSlugFromPath() : "";
  const state = await request("state", detailServerId ? { serverId: detailServerId } : detailServerSlug ? { serverSlug: detailServerSlug } : {}, "GET");
  sessionStorage.removeItem("iconListingBootRetries");
  if (state.user && store.session) store.session = { ...store.session, user: state.user };
  const next = { ...state, votes: state.votes || [] };
  cachePublicState(next);
  return next;
}

async function loadPublicSnapshotState() {
  if (!publicSnapshotPromise) {
    publicSnapshotPromise = fetch(route("/data/public-state.json"), { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Public listing snapshot unavailable.");
        return response.json();
      })
      .then((snapshot) => publicClientState(snapshot, { user: store.session?.user || null, apiHydrating: true }))
      .catch(() => null);
  }
  return publicSnapshotPromise;
}

function consumeGoogleAuthHash() {
  const raw = String(location.hash || "").replace(/^#/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const token = params.get("googleToken");
  const error = params.get("googleError");
  if (!token && !error) return null;
  history.replaceState(null, document.title, `${location.pathname}${location.search}`);
  if (token) {
    store.session = { token, user: null };
    return { ok: true, message: "Signed in with Google." };
  }
  return { ok: false, message: isInternalApiMessage(error) ? "Google sign-in could not be completed right now. Please try again." : (error || "Google sign-in could not be completed right now. Please try again.") };
}

function scheduleNetworkRefresh(error) {
  if (!isNetworkAbort(error) && !isNetworkAbort(error?.originalError) && error?.message !== networkApiMessage()) return false;
  const key = "iconListingBootRetries";
  const attempts = Number(sessionStorage.getItem(key) || 0);
  if (attempts >= 5) return false;
  sessionStorage.setItem(key, String(attempts + 1));
  window.setTimeout(() => location.reload(), Math.min(1200 + attempts * 800, 5000));
  return true;
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
  const key = page === "sponsored-clients" ? "sponsoredClients" : page === "sponsored-hosts" ? "sponsoredHosts" : page;
  const pageSeo = seo.pages?.[key] || {};
  const path = page === "home" ? "/" : `/${page}/`;
  return {
    title: pageSeo.title || `${CONFIG.site.name} | ${pageTitle(page)}`,
    description: pageSeo.description || seo.defaultDescription || copy("home.body", ""),
    path
  };
}

function navMenuLink(href, title, body = "", extra = "") {
  return `<a class="menu-link ${extra}" href="${route(href)}">
    <strong>${escapeHtml(title)}</strong>
    ${body ? `<span>${escapeHtml(body)}</span>` : ""}
  </a>`;
}

function serversDropdownMarkup() {
  const gamemodes = CONFIG.gamemodes.slice(0, 12).map((tag) => navMenuLink(`/servers/?tag=${encodeURIComponent(tag)}`, tag, "Browse ranked servers")).join("");
  return `<div class="dropdown mega-dropdown">
    <button class="drop-button" type="button" data-route-group="servers">Servers <span class="chevron" aria-hidden="true">v</span></button>
    <div class="dropdown-menu mega-menu">
      <div class="mega-column">
        <div class="dropdown-section-title">Java edition</div>
        ${navMenuLink("/servers/?tag=Java", "Java Servers", "Servers for Minecraft Java Edition")}
        ${navMenuLink("/servers/?sort=players", "Popular Java Servers", "Sort by active players")}
        ${navMenuLink("/servers/?sort=new", "Newest Java Servers", "Recently submitted listings")}
        ${navMenuLink("/servers/?tag=Modded", "Modded Servers", "Modded and custom gameplay")}
      </div>
      <div class="mega-column">
        <div class="dropdown-section-title">Bedrock edition</div>
        ${navMenuLink("/servers/?tag=Bedrock", "Bedrock Servers", "Servers for Bedrock players")}
        ${navMenuLink("/servers/?tag=Cross-Play", "Crossplay Servers", "Java and Bedrock together")}
        ${navMenuLink("/servers/?tag=New", "Newest Bedrock Servers", "Fresh Bedrock listings")}
        ${navMenuLink("/servers/?tag=Vote%20Rewards", "Vote Reward Servers", "Communities with vote rewards")}
      </div>
      <div class="mega-column wide">
        <div class="dropdown-section-title">Server game modes</div>
        <div class="compact-link-grid">${gamemodes}</div>
        <a class="menu-link view-all" href="${route("/servers/")}"><strong>View all servers</strong><span>Search every listing</span></a>
      </div>
      <div class="mega-column search-column">
        <div class="dropdown-section-title">Search</div>
        <form class="menu-search" action="${route("/servers/")}" method="get">
          <input name="q" class="input" type="search" placeholder="Find a specific server">
        </form>
        <div class="dropdown-section-title">Quick filters</div>
        ${["Survival", "SMP", "Skyblock", "Prison", "PvP", "Factions"].map((tag) => `<a class="quick-filter" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${escapeHtml(tag)}</a>`).join("")}
      </div>
    </div>
  </div>`;
}

function sponsoredDropdownMarkup() {
  return `<div class="dropdown">
    <button class="drop-button" type="button" data-route-group="sponsored sponsored-clients sponsored-hosts plans">${escapeHtml(copy("nav.sponsoredServers", "Sponsored"))} <span class="chevron" aria-hidden="true">v</span></button>
    <div class="dropdown-menu sponsor-menu">
      ${navMenuLink("/sponsored/", copy("sponsoredServers.title", "Sponsored Servers"), "Paid Minecraft server placements", "accent-purple")}
      ${navMenuLink("/sponsored-clients/", copy("nav.sponsoredClients", "Sponsored Clients"), "Client promotions and downloads", "accent-pink")}
      ${navMenuLink("/sponsored-hosts/", copy("nav.sponsoredHosts", "Sponsored Hosts"), "Minecraft hosting sponsors", "accent-blue")}
      ${navMenuLink("/sponsored/plans/", copy("nav.plans", "Plans"), "Listing limits and sponsor access", "accent-cyan")}
    </div>
  </div>`;
}

function toolsDropdownMarkup() {
  return `<div class="dropdown">
    <button class="drop-button" type="button" data-route-group="motd-builder votifier-tester rgb-text-generator fonts-generator">${escapeHtml(copy("nav.tools", "Tools"))} <span class="chevron" aria-hidden="true">v</span></button>
    <div class="dropdown-menu tools-menu">
      ${navMenuLink("/tools/votifier-tester/", copy("tools.votifierTitle", "Votifier Tester"), "Check Votifier, NuVotifier, or AzuVotifier settings", "accent-blue")}
      ${navMenuLink("/tools/motd-builder/", copy("tools.motdTitle", "MOTD Builder"), "Build a two-line Minecraft MOTD", "accent-purple")}
      ${navMenuLink("/tools/rgb-text-generator/", copy("tools.rgbTitle", "RGB Text Generator"), "Create RGB gradient Minecraft text", "accent-pink")}
      ${navMenuLink("/tools/fonts-generator/", copy("tools.fontsTitle", "Fonts Generator"), "Generate small caps, superscript, subscript, and styled text", "accent-cyan")}
    </div>
  </div>`;
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
          ${serversDropdownMarkup()}
          ${sponsoredDropdownMarkup()}
          ${toolsDropdownMarkup()}
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
          <a class="footer-review-link" href="${TRUSTPILOT_REVIEW_URL}" target="_blank" rel="noopener">Review</a>
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
  $$("[data-route-group]").forEach((node) => {
    const routes = String(node.dataset.routeGroup || "").split(/\s+/);
    node.classList.toggle("active", routes.includes(page));
  });
}

function syncAuthUi(user) {
  $$("[data-auth='dashboard']").forEach((node) => node.classList.toggle("hidden", !user));
  $$("[data-auth='admin']").forEach((node) => node.classList.toggle("hidden", !isAdmin(user)));
  $$("[data-auth='login']").forEach((node) => node.classList.toggle("hidden", !!user));
}

function emptyNotice(title = copy("empty.title", "No servers listed yet"), body = copy("empty.body", "Listings will show here after they are submitted and saved."), action = copy("empty.action", "Add a Server"), actionHref = null) {
  const href = actionHref || (store.session ? route("/dashboard/") : route("/login/"));
  return `<div class="empty-state">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(body)}</p>
    <a class="button primary" href="${href}">${escapeHtml(action)}</a>
  </div>`;
}

function loadingNotice(title = "Loading shared listings", body = "Fetching the newest public listings now.") {
  return `<div class="empty-state loading-state">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(body)}</p>
  </div>`;
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
  for (const copyItem of Array.isArray(analytics.ipCopies) ? analytics.ipCopies : []) {
    const date = dateKey(copyItem.createdAt);
    if (!date || !isRecentDateKey(date, ANALYTICS_DAYS)) continue;
    const hash = shortVisitorHash(copyItem.visitorHash || "");
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

function recordLocalIpCopy(server) {
  const analytics = normalizeAnalytics(server.analytics || {});
  const date = new Date().toISOString().slice(0, 10);
  const visitorHash = shortVisitorHash(store.session?.user?.id || "local");
  const visitors = analytics.ipCopyVisitorDays[date] || [];
  if (!visitors.includes(visitorHash)) {
    if (visitors.length < COPY_HASHES_PER_DAY_LIMIT) visitors.push(visitorHash);
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
  return String(hash || "").replace(/[^a-z0-9]/gi, "").slice(0, 16);
}

function descriptionSnippet(value = "", max = 150) {
  return trimSeo(value, max);
}

function serverSlug(value = "", fallback = "") {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || String(fallback || "server").replace(/[^a-z0-9-]/gi, "").slice(0, 80) || "server";
}

function serverPath(server) {
  return `/server/${encodeURIComponent(serverSlug(server.name, server.id))}/`;
}

function serverRoute(server, options = {}) {
  if (options.byId && server?.id) return route(`/server/?id=${encodeURIComponent(server.id)}`);
  return route(serverPath(server));
}

function serverSlugFromPath() {
  const match = location.pathname.match(/\/server\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1] || "") : "";
}

function sameServerSlug(server, slug = "") {
  return serverSlug(server.name, server.id).toLowerCase() === serverSlug(slug).toLowerCase();
}

function findServerFromLocation(servers = []) {
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || params.get("server");
  if (id) return servers.find((item) => item.id === id);
  const slug = serverSlugFromPath();
  return slug ? servers.find((item) => sameServerSlug(item, slug)) : null;
}

function popularTagLinks(limit = 12) {
  return [...CONFIG.gamemodes.slice(0, limit - 3), "Bedrock", "Cross-Play", "New"].slice(0, limit).map((tag) => (
    `<a class="pill" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${escapeHtml(tag)} servers</a>`
  )).join("");
}

function popularGamemodeStats(servers = [], limit = 8) {
  const stats = new Map();
  for (const server of servers) {
    const tags = [...new Set(server.tags || [])].filter((tag) => CONFIG.gamemodes.includes(tag));
    for (const tag of tags) {
      const item = stats.get(tag) || { tag, players: 0, listings: 0 };
      item.players += Number(server.playersOnline || 0);
      item.listings += 1;
      stats.set(tag, item);
    }
  }
  const ranked = [...stats.values()].sort((a, b) => b.players - a.players || b.listings - a.listings || a.tag.localeCompare(b.tag));
  return ranked.length ? ranked.slice(0, limit) : CONFIG.gamemodes.slice(0, limit).map((tag) => ({ tag, players: 0, listings: 0 }));
}

function popularGamemodesCard(servers = []) {
  const rows = popularGamemodeStats(servers);
  return `<article class="side-card popular-card">
    <h2><span class="side-icon">G</span> Popular Gamemodes</h2>
    <div class="popular-rows">${rows.map((item, index) => `<a class="popular-row" href="${route(`/servers/?tag=${encodeURIComponent(item.tag)}`)}">
      <span class="popular-rank">#${index + 1}</span>
      <strong>${escapeHtml(item.tag)}</strong>
      <span class="player-badge">${Number(item.players || 0).toLocaleString()} players</span>
    </a>`).join("")}</div>
  </article>`;
}

function directorySidebar(servers = []) {
  const online = onlineServerCount(servers);
  const totalPlayers = servers.reduce((sum, server) => sum + Number(server.playersOnline || 0), 0);
  return `<aside class="directory-sidebar">
    ${popularGamemodesCard(servers)}
    <article class="side-card stat-side-card">
      <h2>Live Directory</h2>
      <div class="side-stat"><strong>${Number(online).toLocaleString()}</strong><span>servers online</span></div>
      <div class="side-stat"><strong>${Number(totalPlayers).toLocaleString()}</strong><span>players online</span></div>
      <a class="button primary side-button" href="${route("/login/")}">Submit a server</a>
    </article>
    <article class="side-card browse-card">
      <h2>Browse Faster</h2>
      <div class="server-tags">
        ${["Java", "Bedrock", "Cross-Play", "SMP", "PvP", "Survival"].map((tag) => `<a class="pill" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${escapeHtml(tag)}</a>`).join("")}
      </div>
    </article>
  </aside>`;
}

const HOME_FAQS = [
  {
    question: "How do I find the best Minecraft server for me?",
    answer: "Start by filtering for the gamemode you want, such as SMP, Survival, Skyblock, Factions, Lifesteal, Prison, PvP, Bedrock, or Cross-Play. Then compare player counts, votes, server status, tags, descriptions, and banners before joining."
  },
  {
    question: "Can server owners submit their Minecraft server?",
    answer: "Yes. Server owners can create an account, submit a unique listing, add a formatted description, choose tags, upload a banner, add trailer links, and connect voting details."
  },
  {
    question: "How are Minecraft servers ranked?",
    answer: "Icon Listing ranks servers using player activity, votes, and listing data. Sponsored servers are clearly marked separately so players can tell promoted placements apart from normal listings."
  }
];

const SERVER_LIST_FAQS = [
  {
    question: "What types of Minecraft servers are listed?",
    answer: "The server list supports SMP, Survival, Economy, Skyblock, Factions, Lifesteal, Prison, PvP, Minigames, Bedrock, Java, and cross-play Minecraft communities."
  },
  {
    question: "Can I search by server IP or gamemode?",
    answer: "Yes. You can search by server name, IP address, tag, or gamemode, then sort by rank, votes, newest listings, or online player counts."
  }
];

function faqJsonLd(items) {
  return {
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer
      }
    }))
  };
}

function faqMarkup(items) {
  return `<div class="faq-list">${items.map((item) => `<article class="faq-item">
    <h3>${escapeHtml(item.question)}</h3>
    <p>${escapeHtml(item.answer)}</p>
  </article>`).join("")}</div>`;
}

function serverCard(server) {
  const banner = server.bannerUrl ? `background-image:url('${escapeHtml(asset(server.bannerUrl))}')` : "";
  const editionLabel = serverEditionLabel(server);
  const icon = serverIconUrl(server);
  return `<article class="server-card ${server.sponsored ? "sponsored" : ""}" data-server-id="${escapeHtml(server.id)}">
    <a class="server-card-link" href="${serverRoute(server)}" aria-label="Open ${escapeHtml(server.name)} listing"></a>
    <div class="rank-stack">
      <div class="rank">${server.sponsored ? `<span class="star">*</span>` : ""}#${server.rank || "-"}</div>
      <img class="server-favicon" src="${escapeHtml(icon)}" alt="${escapeHtml(server.name)} icon" loading="lazy">
    </div>
    <div class="banner" style="${banner}" role="img" aria-label="${escapeHtml(server.name)} banner"></div>
    <div class="server-main">
      <h3 class="server-title">${escapeHtml(server.name)} ${server.sponsored ? `<span class="pill">Sponsored</span>` : ""}</h3>
      <p class="server-ip">${escapeHtml(serverAddress(server))}</p>
      <p class="server-summary">${escapeHtml(descriptionSnippet(server.description || `${server.name} is a Minecraft server listed with tags, votes, player counts, and status.`))}</p>
      <div class="server-tags"><span class="pill">${escapeHtml(editionLabel)}</span>${(server.tags || []).map((tag) => `<a class="pill above-link" href="${route(`/servers/?tag=${encodeURIComponent(tag)}`)}">${escapeHtml(tag)}</a>`).join("")}</div>
    </div>
    <div class="stats">
      <span class="status"><span class="dot ${server.online ? "online" : ""}"></span>${server.online ? "Online" : "Offline"}</span>
      <span><strong class="stat-value">${Number(server.playersOnline || 0).toLocaleString()}</strong> <span class="muted">players</span></span>
      <a class="button blue above-link" href="${route(`/vote/?server=${encodeURIComponent(server.id)}`)}">Vote (${Number(server.votes || 0).toLocaleString()})</a>
    </div>
  </article>`;
}

function pageSize() {
  return Math.max(1, Number(CONFIG.limits?.pageSize || 20));
}

function pageFromParams(pageParam = "page") {
  const page = Number(new URLSearchParams(location.search).get(pageParam) || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function clampListPage(page, totalPages) {
  return Math.min(Math.max(1, Number(page) || 1), Math.max(1, totalPages));
}

function onlineServerCount(servers) {
  return servers.filter((server) => server.online).length;
}

function paginationPages(current, total) {
  const pages = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3].forEach((page) => pages.add(page));
  if (current >= total - 2) [total - 2, total - 1].forEach((page) => pages.add(page));
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  return sorted.reduce((items, page, index) => {
    if (index && page - sorted[index - 1] > 1) items.push("...");
    items.push(page);
    return items;
  }, []);
}

function pageHref(basePath, page, pageParam = "page", params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  if (page > 1) query.set(pageParam, page);
  else query.delete(pageParam);
  const search = query.toString();
  return `${route(basePath)}${search ? `?${search}` : ""}`;
}

function paginationMarkup(totalItems, currentPage, options = {}) {
  if (!totalItems) return "";
  const size = options.pageSize || pageSize();
  const totalPages = Math.ceil(totalItems / size);
  const count = Number(options.count ?? totalItems).toLocaleString();
  const noun = options.noun || "servers";
  const basePath = options.basePath || location.pathname || "/";
  const pageParam = options.pageParam || "page";
  const params = options.params || {};
  const pageItems = totalPages > 1
    ? `<nav class="pager" aria-label="Listing pages">
        ${currentPage > 1 ? `<a class="pager-button" data-page-number="${currentPage - 1}" href="${pageHref(basePath, currentPage - 1, pageParam, params)}">prev</a>` : ""}
        ${paginationPages(currentPage, totalPages).map((page) => page === "..."
          ? `<span class="pager-ellipsis">...</span>`
          : `<a class="pager-button ${page === currentPage ? "active" : ""}" data-page-number="${page}" href="${pageHref(basePath, page, pageParam, params)}" aria-current="${page === currentPage ? "page" : "false"}">${page}</a>`
        ).join("")}
        ${currentPage < totalPages ? `<a class="pager-button next" data-page-number="${currentPage + 1}" href="${pageHref(basePath, currentPage + 1, pageParam, params)}">next</a>` : ""}
      </nav>`
    : "";
  return `<div class="list-footer">${pageItems}<p class="listing-count">listing ${count} ${escapeHtml(noun)}</p></div>`;
}

function bindPager(pagerSelector, onPage) {
  const pager = $(pagerSelector);
  if (!pager) return;
  $$("[data-page-number]", pager).forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    history.replaceState(null, "", link.href);
    onPage(Number(link.dataset.pageNumber || 1));
  }));
}

function renderServerList(servers, selector = "#serverList", options = {}) {
  const root = $(selector);
  if (!root) return;
  const size = options.pageSize || pageSize();
  const totalPages = Math.ceil(servers.length / size);
  const page = clampListPage(options.page || pageFromParams(options.pageParam), totalPages);
  const start = (page - 1) * size;
  const visible = servers.slice(start, start + size);
  root.innerHTML = visible.length ? visible.map(serverCard).join("") : (options.loading ? loadingNotice() : emptyNotice());
  if (options.pagerSelector) {
    const pager = $(options.pagerSelector);
    if (pager) {
      pager.innerHTML = paginationMarkup(servers.length, page, {
        ...options,
        count: options.count ?? onlineServerCount(servers),
        noun: options.noun || "servers"
      });
    }
  }
  return page;
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

function setupFilters(servers, options = {}) {
  const params = new URLSearchParams(location.search);
  const initialTag = params.get("tag") || $("#tagFilter")?.value || "";
  const initialSearch = params.get("q") || "";
  const initialSort = params.get("sort") || "rank";
  const pageParam = options.pageParam || "page";
  let currentPage = pageFromParams(pageParam);
  if ($("#tagFilter")) $("#tagFilter").value = initialTag;
  if ($("#searchInput")) $("#searchInput").value = initialSearch;
  if ($("#sortMode")) $("#sortMode").value = initialSort;
  const apply = () => {
    const search = ($("#searchInput")?.value || "").toLowerCase();
    const tag = $("#tagFilter")?.value || "";
    const sort = $("#sortMode")?.value || "rank";
    let result = servers.filter((server) => {
      const text = `${server.name} ${server.javaHost} ${server.bedrockHost} ${server.realmCode} ${serverEditionLabel(server)} ${(server.tags || []).join(" ")}`.toLowerCase();
      return (!search || text.includes(search)) && (!tag || (server.tags || []).includes(tag));
    });
    if (sort === "players") result = [...result].sort((a, b) => (b.playersOnline || 0) - (a.playersOnline || 0));
    if (sort === "votes") result = [...result].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    if (sort === "new") result = [...result].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    currentPage = renderServerList(result, options.selector || "#serverList", {
      pagerSelector: options.pagerSelector || "#serverPager",
      page: currentPage,
      pageParam,
      basePath: options.basePath || (document.body.dataset.page === "servers" ? "/servers/" : "/"),
      params: { q: search, tag, sort: sort === "rank" ? "" : sort },
      loading: !!options.loading
    });
    bindPager(options.pagerSelector || "#serverPager", (page) => {
      currentPage = page;
      apply();
    });
  };
  ["searchInput", "tagFilter", "sortMode"].forEach((id) => $(`#${id}`)?.addEventListener("input", () => {
    currentPage = 1;
    apply();
  }));
  apply();
}

function serverSeoTitle(server) {
  const base = `${server.name} Minecraft Server`;
  return base.length <= 43 ? `${base} | ${CONFIG.site.name}` : base;
}

function serverSeoDescription(server) {
  const tags = (server.tags || []).slice(0, 4).join(", ");
  const status = server.online ? `${Number(server.playersOnline || 0).toLocaleString()} players online` : "status, tags, votes";
  return trimSeo(`Join ${server.name}${tags ? `, a ${tags} Minecraft server` : " Minecraft server"}. View IP, live ${status}, votes, tags, trailer, banner, and details.`, 158);
}

function serverJsonLd(server) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: server.name,
    url: absoluteUrl(serverPath(server)),
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
      url: absoluteUrl(serverPath(server))
    }
  };
}

function renderHome(state) {
  setSeoMeta({
    ...defaultPageSeo("home"),
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebSite",
          name: CONFIG.site.name,
          url: absoluteUrl("/"),
          description: CONFIG.seo?.pages?.home?.description || CONFIG.seo?.defaultDescription,
          potentialAction: {
            "@type": "SearchAction",
            target: `${absoluteUrl("/servers/")}?q={search_term_string}`,
            "query-input": "required name=search_term_string"
          }
        },
        {
          "@type": "Organization",
          name: CONFIG.site.owner || CONFIG.site.name,
          url: absoluteUrl("/"),
          logo: absoluteUrl(CONFIG.site.iconPath)
        },
        faqJsonLd(HOME_FAQS)
      ]
    }
  });
  const loadingListings = !!state.apiHydrating && !state.servers.length;
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
      <div id="sponsoredPager"></div>
    </section>
    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">${escapeHtml(copy("home.allTitle", "All Servers"))}</h2>
          <p class="section-copy">${escapeHtml(copy("home.allBody", "Sorted by rank by default. Use search if you already know what you want."))}</p>
        </div>
      </div>
      ${toolbarMarkup()}
      <div class="directory-layout">
        <div>
          <div id="serverList" class="server-list"></div>
          <div id="serverPager"></div>
        </div>
        ${directorySidebar(state.servers)}
      </div>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">Browse Minecraft Servers by Gamemode</h2>
      <p class="section-copy">Find servers by the way you actually play: survival worlds, SMP communities, economy servers, PvP networks, Skyblock islands, prison progression, Bedrock support, and cross-play servers for friends on different editions.</p>
      <div class="server-tags">${popularTagLinks()}</div>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">Popular Minecraft Server Searches</h2>
      <p class="section-copy">Players often search for active SMP servers, survival servers with land claims, Skyblock servers with economies, Lifesteal servers with PvP, Prison servers with progression, and Bedrock or cross-play servers they can join with friends. Icon Listing keeps those searches connected to real listings with status, votes, descriptions, and server details.</p>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">How Icon Listing Helps Players Choose</h2>
      <p class="section-copy">Each listing can include a formatted description, server IP, tags, owner, country, player counts, status checks, vote totals, banners, trailers, and links. That gives players more context before joining and gives owners a cleaner place to advertise real communities.</p>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">Minecraft Server List FAQ</h2>
      ${faqMarkup(HOME_FAQS)}
    </section>
  </div>`;
  renderServerList(sponsored, "#sponsoredList", {
    pagerSelector: "#sponsoredPager",
    pageParam: "sponsoredPage",
    basePath: "/",
    loading: loadingListings
  });
  setupFilters(state.servers, { pagerSelector: "#serverPager", basePath: "/", loading: loadingListings });
}

function renderServers(state) {
  const tag = new URLSearchParams(location.search).get("tag") || "";
  const loadingListings = !!state.apiHydrating && !state.servers.length;
  setSeoMeta({
    ...defaultPageSeo("servers"),
    title: tag ? `${tag} Minecraft Servers | ${CONFIG.site.name}` : CONFIG.seo?.pages?.servers?.title,
    description: tag
      ? `Browse ${tag} Minecraft servers by rank, votes, players, tags, and status. Find active ${tag} communities and vote for your favorites.`
      : CONFIG.seo?.pages?.servers?.description,
    path: tag ? `/servers/?tag=${encodeURIComponent(tag)}` : "/servers/",
    keywords: tag ? [tag, `${tag} Minecraft servers`] : [],
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          name: tag ? `${tag} Minecraft Servers` : "Minecraft Server List",
          url: absoluteUrl(tag ? `/servers/?tag=${encodeURIComponent(tag)}` : "/servers/"),
          description: tag
            ? `Browse ${tag} Minecraft servers by rank, votes, players, tags, and status.`
            : CONFIG.seo?.pages?.servers?.description
        },
        {
          "@type": "ItemList",
          name: tag ? `${tag} Minecraft Servers` : "Minecraft Servers",
          url: absoluteUrl(tag ? `/servers/?tag=${encodeURIComponent(tag)}` : "/servers/"),
          itemListElement: state.servers.slice(0, 20).map((server, index) => ({
            "@type": "ListItem",
            position: index + 1,
            url: absoluteUrl(serverPath(server)),
            name: server.name
          }))
        },
        faqJsonLd(SERVER_LIST_FAQS)
      ]
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
      <section class="seo-section">
        <h2 class="section-title">Compare Minecraft Servers Before Joining</h2>
        <p class="section-copy">A useful Minecraft server list should show more than a name. Icon Listing lets players compare server IPs, online status, player counts, votes, tags, formatted descriptions, banners, trailers, and owner links so they can pick a community that matches how they play.</p>
        ${faqMarkup(SERVER_LIST_FAQS)}
      </section>
      <div class="directory-layout">
        <div>
          <div id="serverList" class="server-list"></div>
          <div id="serverPager"></div>
        </div>
        ${directorySidebar(state.servers)}
      </div>
    </section>
  </div>`;
  setupFilters(state.servers, { pagerSelector: "#serverPager", basePath: "/servers/", loading: loadingListings });
}

function renderServerDetail(state) {
  const server = findServerFromLocation(state.servers);
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
  const bedrockIp = bedrockAddress(server);
  const isBedrockRealm = server.edition === "bedrock" && server.bedrockType === "realm";
  setSeoMeta({
    title: serverSeoTitle(server),
    description: serverSeoDescription(server),
    path: serverPath(server),
    image: server.bannerUrl || CONFIG.site.iconPath,
    type: "article",
    keywords: [...(server.tags || []), server.name, server.javaHost, server.bedrockHost, server.realmCode].filter(Boolean),
    jsonLd: serverJsonLd(server)
  });
  $("#app").innerHTML = `<div class="page detail-layout">
    <aside class="info-panel">
      <h1>${escapeHtml(server.name)}</h1>
      ${infoRow("Owner", owner)}
      ${infoRow("Status", `<span class="status inline"><span class="dot ${server.online ? "online" : ""}"></span>${server.online ? "Online" : "Offline"}</span>`)}
      ${infoRow("Edition", `<span class="pill">${escapeHtml(serverEditionLabel(server))}</span>`)}
      ${server.edition !== "bedrock" ? infoRow("Java IP", `<span class="copy-row"><span>${escapeHtml(ip)}</span><button class="mini-button" data-copy-ip type="button">Copy</button></span>`) : ""}
      ${server.edition === "bedrock" && isBedrockRealm ? infoRow("Realm Code", `<span class="copy-row"><span>${escapeHtml(server.realmCode)}</span><button class="mini-button" data-copy-realm type="button">Copy</button></span>`) : ""}
      ${(server.crossPlay || (server.edition === "bedrock" && !isBedrockRealm)) ? infoRow("Bedrock IP", `<span class="copy-row"><span>${escapeHtml(bedrockIp)}</span><button class="mini-button" data-copy-bedrock type="button">Copy</button></span>`) : ""}
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
  $("[data-copy-bedrock]")?.addEventListener("click", () => copyServerAddress(server, bedrockAddress(server)));
  $("[data-copy-realm]")?.addEventListener("click", () => copyServerAddress(server, server.realmCode));
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
  if (server.edition === "bedrock") {
    return server.bedrockType === "realm" ? server.realmCode : bedrockAddress(server);
  }
  return javaAddress(server);
}

function serverIconUrl(server) {
  const icon = normalizeMinecraftIcon(server.iconUrl || "");
  return icon || asset(CONFIG.site.iconPath);
}

function javaAddress(server) {
  const host = cleanHost(server.javaHost);
  if (server.javaSrvResolved || server.javaStatusTarget === host) return host;
  const port = javaPort(server);
  return !port || port === CONFIG.defaults.javaPort ? host : `${host}:${port}`;
}

function bedrockAddress(server) {
  return `${server.bedrockHost}:${Number(server.bedrockPort || CONFIG.defaults.bedrockPort)}`;
}

function javaPort(server) {
  const hostPort = String(server.javaHost || "").trim().match(/^.+:(\d+)$/);
  return Number(hostPort?.[1] || server.javaPort || CONFIG.defaults.javaPort);
}

function cleanHost(host = "") {
  let value = String(host || "").trim();
  value = value.replace(/^https?:\/\//i, "").split("/")[0].replace(/\.$/, "");
  const match = value.match(/^(.+):(\d+)$/);
  return match ? match[1] : value;
}

function serverEditionLabel(server) {
  if (server.edition === "bedrock") return server.bedrockType === "realm" ? "Bedrock Realm" : "Bedrock";
  return server.crossPlay ? "Java + Bedrock" : "Java";
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
  return new URL(serverRoute(server), location.origin).href;
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
  const points = days.length ? days : denseDailyCopies([], ANALYTICS_DAYS);
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
  const params = new URLSearchParams(location.search);
  const id = params.get("server") || params.get("id");
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
      const result = await request("vote", { serverId: server.id, minecraftUsername: $("#minecraftUsername").value });
      state.votes = [...(state.votes || []), result.vote].filter(Boolean);
      const updatedServer = result.server || { ...server, votes: Number(server.votes || 0) + 1 };
      state.servers = rankServers(state.servers.map((item) => (item.id === server.id ? { ...item, ...updatedServer } : item)), state.votes);
      toast("Vote counted. Thanks for supporting this server.");
      renderVotePage(state);
    } catch (error) {
      toast(publicRequestError("vote", error));
    }
  });
}

function renderSponsored(state) {
  const sponsoredServers = state.servers.filter((server) => server.sponsored);
  setSeoMeta({
    ...defaultPageSeo("sponsored"),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Sponsored Minecraft Servers",
      url: absoluteUrl("/sponsored/"),
      description: CONFIG.seo?.pages?.sponsored?.description,
      mainEntity: {
        "@type": "ItemList",
        itemListElement: sponsoredServers.slice(0, 20).map((server, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: absoluteUrl(serverPath(server)),
          name: server.name
        }))
      }
    }
  });
  $("#app").innerHTML = `<div class="page">
    <section class="hero-band compact">
      <div class="hero-content">
        <div class="eyebrow">${escapeHtml(copy("sponsoredServers.eyebrow", "Paid placements"))}</div>
        <h1 class="hero-title">${escapeHtml(copy("sponsoredServers.title", "Sponsored Servers"))}</h1>
        <p class="hero-copy">${escapeHtml(copy("sponsoredServers.body", "Sponsors get placement above normal results. The listing stays labeled so players know what they are looking at."))}</p>
        <div class="hero-actions">
          <a class="button primary" href="${CONFIG.site.discordUrl}">${escapeHtml(copy("sponsoredServers.action", "Ask on Discord"))}</a>
          <a class="button" href="${route("/servers/")}">Browse all servers</a>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">Featured Sponsored Minecraft Servers</h2>
          <p class="section-copy">Sponsored listings are promoted placements for Minecraft servers that want more visibility. They still include useful server information like IP address, tags, status, player counts, descriptions, trailers, banners, and vote links.</p>
        </div>
      </div>
      <div id="sponsoredServerList" class="server-list"></div>
      <div id="sponsoredServerPager"></div>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">Sponsored Server Categories</h2>
      <p class="section-copy">Players can find sponsored Minecraft servers across common categories including SMP, Survival, Skyblock, Factions, Lifesteal, Prison, Economy, Bedrock, and cross-play communities.</p>
      <div class="server-tags">${popularTagLinks()}</div>
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
  const page = renderServerList(sponsoredServers, "#sponsoredServerList", {
    pagerSelector: "#sponsoredServerPager",
    pageParam: "page",
    basePath: "/sponsored/"
  });
  bindPager("#sponsoredServerPager", () => renderSponsored(state));
}

function renderClients(state) {
  setSeoMeta({
    ...defaultPageSeo("sponsored-clients"),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Sponsored Minecraft Clients",
      url: absoluteUrl("/sponsored-clients/"),
      description: CONFIG.seo?.pages?.sponsoredClients?.description,
      mainEntity: {
        "@type": "ItemList",
        itemListElement: state.clients.slice(0, 20).map((client, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: client.url,
          name: client.name
        }))
      }
    }
  });
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">${escapeHtml(copy("sponsoredClients.title", "Sponsored Clients"))}</h1>
          <p class="section-copy">${escapeHtml(copy("sponsoredClients.body", "Client promotions approved by staff."))} Browse approved Minecraft client advertisements with download links, videos, images, pricing, and Java or Bedrock support.</p>
        </div>
      </div>
      <div id="clientList" class="grid two"></div>
      <div id="clientPager"></div>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">What Sponsored Minecraft Clients Include</h2>
      <p class="section-copy">Sponsored client listings can include a website or download link, a YouTube video, up to two showcase images, pricing information, and whether the client supports Java Edition, Bedrock Edition, or both. This helps players compare client promotions before visiting the download page.</p>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">Related Minecraft Server Discovery</h2>
      <p class="section-copy">Client users can also explore Minecraft servers by category and vote for active communities on Icon Listing.</p>
      <div class="server-tags">${popularTagLinks()}</div>
    </section>
  </div>`;
  const page = renderClientList(state.clients, "#clientList", {
    pagerSelector: "#clientPager",
    pageParam: "page",
    basePath: "/sponsored-clients/"
  });
  bindPager("#clientPager", () => renderClients(state));
}

function renderHosts(state) {
  const hosts = state.hosts || [];
  setSeoMeta({
    ...defaultPageSeo("sponsored-hosts"),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Sponsored Minecraft Hosts",
      url: absoluteUrl("/sponsored-hosts/"),
      description: CONFIG.seo?.pages?.sponsoredHosts?.description,
      mainEntity: {
        "@type": "ItemList",
        itemListElement: hosts.slice(0, 20).map((host, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: host.url,
          name: host.name
        }))
      }
    }
  });
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">${escapeHtml(copy("sponsoredHosts.title", "Sponsored Hosts"))}</h1>
          <p class="section-copy">${escapeHtml(copy("sponsoredHosts.body", "Paid Minecraft hosting sponsors approved by staff."))} Compare sponsored Minecraft hosting providers with showcase images, descriptions, videos, and website links.</p>
        </div>
      </div>
      <div id="hostList" class="grid two"></div>
      <div id="hostPager"></div>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">What Sponsored Minecraft Hosts Include</h2>
      <p class="section-copy">Sponsored host listings can include a website link, YouTube video, up to three showcase images, and a long description of the hosting service. These are paid sponsor placements and are kept separate from server and client listings.</p>
    </section>
    <section class="section seo-section">
      <h2 class="section-title">Related Minecraft Discovery</h2>
      <p class="section-copy">Hosting sponsors can reach server owners while players continue browsing Minecraft servers, clients, and active communities on Icon Listing.</p>
      <div class="server-tags">${popularTagLinks()}</div>
    </section>
  </div>`;
  renderHostList(hosts, "#hostList", {
    pagerSelector: "#hostPager",
    pageParam: "page",
    basePath: "/sponsored-hosts/"
  });
  bindPager("#hostPager", () => renderHosts(state));
}

function renderPlans(state) {
  const plans = Object.entries(CONFIG.plans || {}).filter(([key]) => key !== "free");
  const currentPlan = normalizePlanKey(state.user?.plan || "free");
  setSeoMeta({
    ...defaultPageSeo("plans"),
    title: CONFIG.seo?.pages?.plans?.title || "Icon Listing Plans",
    description: CONFIG.seo?.pages?.plans?.description || "Compare Icon Listing plans for server limits and sponsor access.",
    path: "/sponsored/plans/"
  });
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">${escapeHtml(copy("plans.title", "Plans"))}</h1>
          <p class="section-copy">${escapeHtml(copy("plans.body", "Choose the listing limit and sponsor access that fits your Minecraft community. Stripe checkout is coming soon."))}</p>
        </div>
      </div>
      <div class="plans-grid">
        ${planCard("free", CONFIG.plans.free, currentPlan)}
        ${plans.map(([key, plan]) => planCard(key, plan, currentPlan)).join("")}
      </div>
    </section>
  </div>`;
}

function planCard(key, plan = {}, currentPlan = "free") {
  const isCurrent = currentPlan === key;
  const sponsorLine = Number(plan.sponsorCredits || 0) > 0
    ? `${Number(plan.sponsorCredits).toLocaleString()}x ${escapeHtml(copy("plans.sponsorLabel", "sponsor access"))} - ${escapeHtml(plan.sponsorDurationLabel || "")}`
    : escapeHtml(plan.sponsorDurationLabel || "No sponsor slot");
  return `<article class="plan-card ${key === "elite" ? "featured" : ""}">
    <div class="plan-head">
      <div>
        <h2>${escapeHtml(plan.name || key)}</h2>
        <p>${escapeHtml(plan.description || "")}</p>
      </div>
      ${isCurrent ? `<span class="status-badge">${escapeHtml(copy("plans.currentPlan", "Current plan"))}</span>` : ""}
    </div>
    <div class="plan-price">${escapeHtml(plan.price || "")}</div>
    <ul class="feature-list">
      <li>${Number(plan.serverLimit || 0).toLocaleString()} ${escapeHtml(copy("plans.serverLimitLabel", "server listings"))}</li>
      <li>${sponsorLine}</li>
      <li>Stripe checkout not connected yet</li>
    </ul>
    <button class="button primary" type="button" disabled>${escapeHtml(copy("plans.comingSoon", "Coming soon"))}</button>
  </article>`;
}

function renderClientList(clients, selector = "#clientList", options = {}) {
  const root = $(selector);
  if (!root) return;
  const size = options.pageSize || pageSize();
  const totalPages = Math.ceil(clients.length / size);
  const page = clampListPage(options.page || pageFromParams(options.pageParam), totalPages);
  const start = (page - 1) * size;
  const visible = clients.slice(start, start + size);
  root.innerHTML = visible.length ? visible.map(clientCard).join("") : emptyNotice();
  if (options.pagerSelector) {
    const pager = $(options.pagerSelector);
    if (pager) {
      pager.innerHTML = paginationMarkup(clients.length, page, {
        ...options,
        count: clients.length,
        noun: "clients"
      });
    }
  }
  return page;
}

function renderHostList(hosts, selector = "#hostList", options = {}) {
  const root = $(selector);
  if (!root) return;
  const size = options.pageSize || pageSize();
  const totalPages = Math.ceil(hosts.length / size);
  const page = clampListPage(options.page || pageFromParams(options.pageParam), totalPages);
  const start = (page - 1) * size;
  const visible = hosts.slice(start, start + size);
  root.innerHTML = visible.length ? visible.map(hostCard).join("") : emptyNotice("No sponsored hosts yet", "Paid Minecraft hosting sponsors will show here after staff adds them.", "Contact staff", route("/contact/"));
  if (options.pagerSelector) {
    const pager = $(options.pagerSelector);
    if (pager) {
      pager.innerHTML = paginationMarkup(hosts.length, page, {
        ...options,
        count: hosts.length,
        noun: "hosts"
      });
    }
  }
  return page;
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

function hostCard(host) {
  const images = (host.images || []).slice(0, 3);
  return `<article class="card client-card host-card">
    <div class="client-gallery host-gallery">${images.length ? images.map((image) => `<div class="client-image" style="background-image:url('${escapeHtml(asset(image))}')"></div>`).join("") : `<div class="client-image placeholder">${escapeHtml(host.name || "Host")}</div>`}</div>
    <div class="server-tags">
      <span class="pill">${escapeHtml(copy("sponsoredHosts.paidLabel", "Paid sponsor"))}</span>
      <span class="pill">Minecraft hosting</span>
    </div>
    <h2>${escapeHtml(host.name)}</h2>
    <div class="description-text compact">${escapeHtml(host.description)}</div>
    <div class="row-actions">
      <a class="button primary" href="${escapeHtml(host.url)}">${escapeHtml(copy("sponsoredHosts.moreInfoButton", "More info"))}</a>
      ${host.youtubeUrl ? `<a class="button" href="${escapeHtml(host.youtubeUrl)}">${escapeHtml(copy("sponsoredHosts.videoButton", "Watch video"))}</a>` : ""}
    </div>
  </article>`;
}

function turnstileEnabled() {
  return !!(CONFIG.security?.turnstile?.enabled && CONFIG.security?.turnstile?.siteKey);
}

function turnstileMarkup(widgetId, tokenId) {
  if (!turnstileEnabled()) return "";
  return `<div class="field turnstile-field">
    <label>Security check</label>
    <div id="${escapeHtml(widgetId)}" class="turnstile-box"></div>
    <input id="${escapeHtml(tokenId)}" type="hidden" required>
  </div>`;
}

function loadTurnstile() {
  if (!turnstileEnabled()) return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoadPromise) return turnstileLoadPromise;
  turnstileLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-turnstile]");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.turnstile));
      existing.addEventListener("error", reject);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.turnstile = "true";
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => reject(new Error("Captcha could not load."));
    document.head.appendChild(script);
  });
  return turnstileLoadPromise;
}

function renderTurnstileWidget(widgetId, tokenId, action) {
  if (!turnstileEnabled()) return;
  renderedTurnstileWidgets.delete(widgetId);
  loadTurnstile().then((turnstile) => {
    const container = $(`#${widgetId}`);
    const input = $(`#${tokenId}`);
    if (!turnstile || !container || !input || renderedTurnstileWidgets.has(widgetId)) return;
    const widget = turnstile.render(container, {
      sitekey: CONFIG.security.turnstile.siteKey,
      theme: "dark",
      action,
      callback(token) {
        input.value = token || "";
      },
      "expired-callback"() {
        input.value = "";
      },
      "error-callback"() {
        input.value = "";
      }
    });
    renderedTurnstileWidgets.set(widgetId, widget);
  }).catch(() => {
    const container = $(`#${widgetId}`);
    if (container) container.innerHTML = `<p class="notice compact">Captcha could not load. Refresh and try again.</p>`;
  });
}

function turnstileToken(tokenId) {
  if (!turnstileEnabled()) return "";
  const token = $(`#${tokenId}`)?.value || "";
  if (!token) throw new Error("Complete the captcha.");
  return token;
}

function resetTurnstileWidget(widgetId, tokenId) {
  if (!turnstileEnabled()) return;
  const input = $(`#${tokenId}`);
  if (input) input.value = "";
  const widget = renderedTurnstileWidgets.get(widgetId);
  if (window.turnstile && widget !== undefined) window.turnstile.reset(widget);
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
  if (store.pendingVerification) {
    renderPendingEmailVerification(store.pendingVerification);
    return;
  }
  $("#app").innerHTML = `<div class="page">
    <section class="section grid two">
      <form id="loginForm" class="card form">
        <h1 class="section-title">${escapeHtml(copy("login.title", "Login"))}</h1>
        <p class="section-copy">${escapeHtml(copy("login.body", "Log in to manage your server listings."))}</p>
        <a class="button google-button" href="${escapeHtml(googleStartUrl())}">Continue with Google</a>
        <div class="auth-divider"><span>or</span></div>
        <div class="field"><label>Username or email</label><input id="loginName" class="input" required></div>
        <div class="field"><label>Password</label><input id="loginPassword" class="input" type="password" required></div>
        ${turnstileMarkup("loginTurnstile", "loginTurnstileToken")}
        <button class="button primary" type="submit">Login</button>
        <p class="section-copy">${escapeHtml(copy("login.signupPrompt", "Need an account?"))} <a class="text-link" href="#signup">${escapeHtml(copy("login.signupLink", "Sign up below"))}</a>.</p>
      </form>
      <form id="signup" class="card form">
        <h2 class="section-title">${escapeHtml(copy("login.signupTitle", "Sign Up"))}</h2>
        <p class="section-copy">${escapeHtml(copy("login.signupBody", "Create an account to submit a server."))}</p>
        <a class="button google-button" href="${escapeHtml(googleStartUrl())}">Sign up with Google</a>
        <p class="fine-print">By continuing with Google, you accept the <a class="text-link" href="${route("/terms/")}">terms and conditions</a> of IconListing.</p>
        <div class="auth-divider"><span>or</span></div>
        <div class="field"><label>Username</label><input id="signupUser" class="input" minlength="3" required></div>
        <div class="field"><label>Email</label><input id="signupEmail" class="input" type="email" required></div>
        <div class="field"><label>Password</label><input id="signupPassword" class="input" type="password" minlength="6" required></div>
        <label class="check-row"><input id="signupEmailOptIn" type="checkbox"> Allow IconListing to send me news and updates.</label>
        <label class="check-row"><input id="signupTerms" type="checkbox" required> I accept the <a class="text-link" href="${route("/terms/")}">terms and conditions</a> of IconListing.</label>
        ${turnstileMarkup("signupTurnstile", "signupTurnstileToken")}
        <button class="button blue" type="submit">Create Account</button>
      </form>
    </section>
  </div>`;
  renderTurnstileWidget("loginTurnstile", "loginTurnstileToken", "login");
  renderTurnstileWidget("signupTurnstile", "signupTurnstileToken", "register");
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#loginForm button[type='submit']");
    setButtonLoading(button, "Logging in...");
    try {
      const result = await request("login", { login: $("#loginName").value, password: $("#loginPassword").value, turnstileToken: turnstileToken("loginTurnstileToken") });
      if (result.pendingVerification) {
        showPendingEmailVerification(result);
        return;
      }
      store.session = { token: result.token, user: result.user };
      location.href = route("/dashboard/");
    } catch (error) {
      toast(error.message);
      resetTurnstileWidget("loginTurnstile", "loginTurnstileToken");
      setButtonLoading(button, "Login", false);
    }
  });
  $("#signup").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#signup button[type='submit']");
    setButtonLoading(button, "Creating account...");
    try {
      const result = await request("register", {
        username: $("#signupUser").value,
        email: $("#signupEmail").value,
        password: $("#signupPassword").value,
        emailOptIn: $("#signupEmailOptIn").checked,
        termsAccepted: $("#signupTerms").checked,
        turnstileToken: turnstileToken("signupTurnstileToken")
      });
      if (result.pendingVerification) {
        showPendingEmailVerification(result);
        return;
      }
      store.session = { token: result.token, user: result.user };
      location.href = route("/dashboard/");
    } catch (error) {
      toast(error.message);
      resetTurnstileWidget("signupTurnstile", "signupTurnstileToken");
      setButtonLoading(button, "Create Account", false);
    }
  });
}

function showPendingEmailVerification(result) {
  const pending = {
    verificationToken: result.verificationToken,
    user: result.user,
    message: result.emailVerificationMessage || result.message || "Check your email for a verification code."
  };
  store.pendingVerification = pending;
  renderPendingEmailVerification(pending);
}

function renderPendingEmailVerification(pending = {}) {
  const user = pending.user || {};
  $("#app").innerHTML = `<div class="page">
    <form id="pendingEmailVerificationForm" class="card form auth-verification-card">
      <h1 class="section-title">Verify your email</h1>
      <p class="section-copy">Enter the 6-digit code sent to <strong>${escapeHtml(user.email || "your email")}</strong>. Your account will log in after verification.</p>
      ${pending.message ? `<div class="notice compact">${escapeHtml(pending.message)}</div>` : ""}
      <div class="field"><label>Verification code</label><input id="pendingEmailVerificationCode" class="input code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" required></div>
      <div class="row-actions">
        <button id="pendingVerifyEmailButton" class="button primary" type="submit">Verify and continue</button>
        <button id="pendingResendEmailButton" class="button" type="button">Resend code</button>
        <button id="cancelPendingVerification" class="button" type="button">Back to login</button>
      </div>
    </form>
  </div>`;
  $("#pendingEmailVerificationForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#pendingVerifyEmailButton");
    setButtonLoading(button, "Verifying...");
    try {
      const result = await request("verifyEmail", {
        code: $("#pendingEmailVerificationCode").value,
        verificationToken: pending.verificationToken
      });
      store.pendingVerification = null;
      store.session = { token: result.token, user: result.user };
      toast(result.message || "Email verified.");
      location.href = route("/dashboard/");
    } catch (error) {
      toast(error.message);
      setButtonLoading(button, "Verify and continue", false);
    }
  });
  $("#pendingResendEmailButton")?.addEventListener("click", async () => {
    const button = $("#pendingResendEmailButton");
    setButtonLoading(button, "Sending...");
    try {
      const result = await request("resendEmailVerification", { verificationToken: pending.verificationToken });
      const next = {
        verificationToken: result.verificationToken || pending.verificationToken,
        user: result.user || pending.user,
        message: result.message || "Verification code sent."
      };
      store.pendingVerification = next;
      renderPendingEmailVerification(next);
      toast(next.message);
    } catch (error) {
      toast(error.message);
      setButtonLoading(button, "Resend code", false);
    }
  });
  $("#cancelPendingVerification")?.addEventListener("click", () => {
    store.pendingVerification = null;
    boot();
  });
}

function setButtonLoading(button, text, loading = true) {
  if (!button) return;
  button.disabled = loading;
  button.textContent = text;
}

function renderDashboard(state) {
  if (!state.user) {
    $("#app").innerHTML = `<div class="page"><div class="notice">${escapeHtml(copy("dashboard.loginRequired", "Log in to add and manage server listings."))}</div><div class="row-actions"><a class="button primary" href="${route("/login/")}">${escapeHtml(copy("nav.login", "Login"))}</a></div></div>`;
    return;
  }
  const mine = state.servers.filter((server) => server.ownerId === state.user.id);
  const limit = Number(state.user.serverLimit || serverLimitForUser(state.user));
  const limitLabel = limit >= 999 ? "Unlimited" : `${mine.length}/${limit}`;
  const addDisabled = limit < 999 && mine.length >= limit;
  $("#app").innerHTML = `<div class="page">
    <section class="section">
      <div class="section-head">
        <div>
          <h1 class="section-title">${escapeHtml(copy("dashboard.title", "Dashboard"))}</h1>
          <p class="section-copy">${escapeHtml(copy("dashboard.body", "Edit listings, check rank, or add another server."))}</p>
        </div>
      </div>
      ${emailVerificationPanel(state.user)}
      <div class="plan-strip">
        <div>
          <span class="eyebrow">Current plan</span>
          <strong>${escapeHtml(state.user.planName || planConfigForUser(state.user).name)}</strong>
        </div>
        <div>
          <span class="eyebrow">Listing slots</span>
          <strong>${escapeHtml(limitLabel)}</strong>
        </div>
        <a class="button" href="${route("/sponsored/plans/")}">${escapeHtml(copy("dashboard.plansButton", "Plans"))}</a>
      </div>
      <div class="dashboard-list">${mine.length ? mine.map((server) => `<article class="card dash-item">
        <div class="rank">#${server.rank}</div>
        <div>
          <h2 class="server-title">${escapeHtml(server.name)}</h2>
          <p class="server-ip">${escapeHtml(serverAddress(server))}</p>
        </div>
        <div class="row-actions">
          <a class="button" href="${serverRoute(server, { byId: true })}">View</a>
          <button class="button" data-edit="${escapeHtml(server.id)}">Edit</button>
          <button class="button danger" data-delete="${escapeHtml(server.id)}">Delete</button>
        </div>
      </article>`).join("") : emptyNotice()}</div>
      <div class="row-actions">
        <button id="addServerButton" class="button primary" ${addDisabled ? "disabled" : ""}>${escapeHtml(addDisabled ? "Limit reached" : copy("dashboard.addButton", "+ Add Server"))}</button>
        <button id="settingsButton" class="button">${escapeHtml(copy("dashboard.settingsButton", "Account Settings"))}</button>
      </div>
    </section>
    <section id="serverFormPanel" class="section hidden">${serverFormMarkup()}</section>
    <section id="settingsPanel" class="section hidden">${settingsMarkup(state.user)}</section>
  </div>`;
  bindDashboard(state);
}

function emailVerificationPanel(user) {
  if (!user || user.emailVerified) return "";
  return `<form id="emailVerificationForm" class="card email-verification-card">
    <div>
      <h2>Email verification</h2>
      <p class="section-copy">Enter the 6-digit code sent to <strong>${escapeHtml(user.email || "your email")}</strong>.</p>
    </div>
    <div class="email-verification-controls">
      <input id="emailVerificationCode" class="input code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" required>
      <button id="verifyEmailButton" class="button primary" type="submit">Verify email</button>
      <button id="resendVerificationButton" class="button" type="button">Resend code</button>
    </div>
  </form>`;
}

function serverFormMarkup(server = {}) {
  const edition = server.edition === "bedrock" ? "bedrock" : "java";
  const bedrockType = server.bedrockType === "realm" ? "realm" : "server";
  const listenerType = server.votifierType ? cleanVotifierType(server.votifierType) : "auto";
  return `<form id="serverForm" class="card form">
    <input type="hidden" id="serverId" value="${escapeHtml(server.id || "")}">
    <h2 class="section-title">${server.id ? "Edit Server" : "Add Server"}</h2>
    <div class="form-grid">
      <div class="field"><label>Server Name</label><input id="serverName" class="input" value="${escapeHtml(server.name || "")}" required></div>
      <div class="field"><label>Country</label><select id="serverCountry" class="select" required>${CONFIG.countries.map((country) => `<option ${country === server.country ? "selected" : ""}>${country}</option>`).join("")}</select></div>
      <div class="field"><label>Server Edition</label><select id="serverEdition" class="select">
        <option value="java" ${edition === "java" ? "selected" : ""}>Mainly Java</option>
        <option value="bedrock" ${edition === "bedrock" ? "selected" : ""}>Bedrock only</option>
      </select></div>
    </div>
    <div id="javaFields" class="form-grid">
      <div class="field"><label>Java IP / Host</label><input id="javaHost" class="input" value="${escapeHtml(server.javaHost || "")}" required></div>
      <div class="field"><label>Java Port</label><input id="javaPort" class="input" type="number" value="${Number(server.javaPort || CONFIG.defaults.javaPort)}" placeholder="${CONFIG.defaults.javaPort}"></div>
    </div>
    <label id="crossPlayRow" class="check-row"><input id="crossPlay" type="checkbox" ${server.crossPlay ? "checked" : ""}> Also supports Bedrock / cross-play</label>
    <div id="bedrockModeFields" class="form-grid hidden">
      <div class="field"><label>Bedrock address type</label><select id="bedrockType" class="select">
        <option value="server" ${bedrockType === "server" ? "selected" : ""}>Server IP / Host</option>
        <option value="realm" ${bedrockType === "realm" ? "selected" : ""}>Realm code</option>
      </select></div>
      <div id="realmCodeField" class="field hidden"><label>Realm Code</label><input id="realmCode" class="input" value="${escapeHtml(server.realmCode || "")}"></div>
    </div>
    <div id="bedrockFields" class="form-grid hidden">
      <div class="field"><label>Bedrock IP / Host</label><input id="bedrockHost" class="input" value="${escapeHtml(server.bedrockHost || "")}"></div>
      <div class="field"><label>Bedrock Port</label><input id="bedrockPort" class="input" type="number" value="${Number(server.bedrockPort || CONFIG.defaults.bedrockPort)}"></div>
    </div>
    <label class="check-row"><input id="votifierEnabled" type="checkbox" ${server.votifierEnabled ? "checked" : ""}> Enable Votifier</label>
    <div id="votifierFields" class="form-grid hidden">
      <div class="field"><label>Vote Listener Type</label><select id="votifierType" class="select">
        <option value="auto" ${listenerType === "auto" ? "selected" : ""}>Auto detect</option>
        <option value="nuvotifier" ${listenerType === "nuvotifier" ? "selected" : ""}>NuVotifier</option>
        <option value="azuvotifier" ${listenerType === "azuvotifier" ? "selected" : ""}>AzuVotifier</option>
        <option value="votifier" ${listenerType === "votifier" ? "selected" : ""}>Votifier / Classic</option>
      </select></div>
      <div class="field"><label>Votifier IP / Host</label><input id="votifierHost" class="input" value="${escapeHtml(server.votifierHost || "")}"></div>
      <div class="field"><label>Votifier Port</label><input id="votifierPort" class="input" type="number" value="${Number(server.votifierPort || 8192)}"></div>
      <div class="field"><label>Token / Public Key</label><textarea id="votifierToken" class="textarea code-input" rows="3" placeholder="NuVotifier/AzuVotifier token from config.yml, or classic rsa/public.key">${escapeHtml(server.votifierToken || "")}</textarea><p class="fine-print">Auto detect uses short NuVotifier/AzuVotifier tokens for v2 and rsa/public.key values for classic Votifier.</p></div>
      <div class="field"><label>&nbsp;</label><button id="testVote" class="button blue" type="button">Send Test Vote</button></div>
    </div>
    <div class="form-grid">
      <div class="field"><label>IconListing vote plugin</label><select id="iconListingPluginEnabled" class="select">
        <option value="disabled" ${server.iconListingPluginEnabled ? "" : "selected"}>Disabled</option>
        <option value="enabled" ${server.iconListingPluginEnabled ? "selected" : ""}>Enabled</option>
      </select></div>
    </div>
    <div id="iconListingPluginFields" class="form-grid hidden">
      <div class="field"><label>Server Vote Key</label><input id="iconListingVoteKey" class="input" value="${escapeHtml(server.iconListingVoteKey || createVoteKey())}" maxlength="96"></div>
      <div class="field"><label>&nbsp;</label><button id="generateIconListingVoteKey" class="button blue" type="button">Generate Key</button></div>
      <div class="field"><label>&nbsp;</label><button id="testIconListingPluginVote" class="button blue" type="button" ${server.id ? "" : "disabled"}>Test Plugin Vote</button></div>
      <div class="field"><label>&nbsp;</label><a class="button secondary" href="${route(CONFIG.iconListingVotePlugin?.downloadPath || "/download/IconListingVotePlugin.jar")}" download>${escapeHtml(CONFIG.iconListingVotePlugin?.downloadLabel || "Download Plugin")}</a></div>
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
      setButtonLoading(button, "Deleting...");
      try {
        const result = await request("deleteServer", { id: button.dataset.delete });
        state = result.servers ? { ...state, ...result, votes: result.votes || state.votes || [] } : await getState();
        toast("Listing deleted.");
        renderDashboard(state);
      } catch (error) {
        toast(error.message);
        setButtonLoading(button, "Delete", false);
      }
    });
  });
  bindServerForm();
  bindEmailVerificationPanel();
  bindSettingsForms();
}

function bindEmailVerificationPanel() {
  $("#emailVerificationForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#verifyEmailButton");
    setButtonLoading(button, "Verifying...");
    try {
      const result = await request("verifyEmail", { code: $("#emailVerificationCode").value });
      const verifiedUser = { ...(result.user || store.session?.user || {}), emailVerified: true, emailVerificationPending: false };
      store.session = { token: result.token || store.session?.token, user: verifiedUser };
      toast(result.message || "Email verified.");
      $("#emailVerificationForm")?.remove();
      boot();
    } catch (error) {
      toast(error.message);
      setButtonLoading(button, "Verify email", false);
    }
  });
  $("#resendVerificationButton")?.addEventListener("click", async () => {
    const button = $("#resendVerificationButton");
    setButtonLoading(button, "Sending...");
    try {
      const result = await request("resendEmailVerification", {});
      if (result.user) store.session = { token: result.token || store.session?.token, user: result.user };
      toast(result.message || "Verification code sent.");
    } catch (error) {
      toast(error.message);
    } finally {
      setButtonLoading(button, "Resend code", false);
    }
  });
}

function bindServerForm() {
  const edition = $("#serverEdition");
  const crossPlay = $("#crossPlay");
  const bedrockType = $("#bedrockType");
  const votifier = $("#votifierEnabled");
  const iconListingPlugin = $("#iconListingPluginEnabled");
  const sync = () => {
    const isBedrock = edition?.value === "bedrock";
    const isRealm = bedrockType?.value === "realm";
    $("#javaFields")?.classList.toggle("hidden", isBedrock);
    $("#crossPlayRow")?.classList.toggle("hidden", isBedrock);
    $("#bedrockModeFields")?.classList.toggle("hidden", !isBedrock);
    $("#realmCodeField")?.classList.toggle("hidden", !isBedrock || !isRealm);
    $("#bedrockFields")?.classList.toggle("hidden", isBedrock ? isRealm : !crossPlay?.checked);
    $("#javaHost")?.toggleAttribute("required", !isBedrock);
    $("#bedrockHost")?.toggleAttribute("required", isBedrock ? !isRealm : !!crossPlay?.checked);
    $("#realmCode")?.toggleAttribute("required", isBedrock && isRealm);
    $("#votifierFields")?.classList.toggle("hidden", !votifier?.checked);
    $("#iconListingPluginFields")?.classList.toggle("hidden", iconListingPlugin?.value !== "enabled");
  };
  edition?.addEventListener("change", sync);
  crossPlay?.addEventListener("change", sync);
  bedrockType?.addEventListener("change", sync);
  votifier?.addEventListener("change", sync);
  iconListingPlugin?.addEventListener("change", sync);
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
    const minecraftUsername = prompt("Minecraft username for the test vote:", CONFIG.votifier.testUsername || "IconListingTest");
    if (!minecraftUsername) return;
    try {
      const result = await request("testVote", { host: $("#votifierHost").value, port: $("#votifierPort").value, token: $("#votifierToken").value, type: $("#votifierType")?.value || "auto", minecraftUsername });
      toast(result.message || "Test vote sent.");
    } catch (error) {
      toast(error.message);
    }
  });
  $("#generateIconListingVoteKey")?.addEventListener("click", () => {
    $("#iconListingVoteKey").value = createVoteKey();
  });
  $("#testIconListingPluginVote")?.addEventListener("click", async () => {
    const serverId = $("#serverId").value;
    if (!serverId) return toast("Save the listing before testing the plugin vote.");
    const minecraftUsername = prompt("Minecraft username for the test reward:");
    if (!minecraftUsername) return;
    try {
      const result = await request("testPluginVote", { serverId, minecraftUsername });
      toast(result.message || "Plugin test vote queued.");
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
    const result = await request("saveServer", {
      server: {
        id: $("#serverId").value,
        name: $("#serverName").value,
        edition: $("#serverEdition").value,
        javaHost: $("#javaHost").value,
        javaPort: $("#javaPort").value,
        crossPlay: $("#crossPlay").checked,
        bedrockType: $("#bedrockType").value,
        bedrockHost: $("#bedrockHost").value,
        bedrockPort: $("#bedrockPort").value,
        realmCode: $("#realmCode").value,
        votifierEnabled: $("#votifierEnabled").checked,
        votifierType: $("#votifierType")?.value || "nuvotifier",
        votifierHost: $("#votifierHost").value,
        votifierPort: $("#votifierPort").value,
        votifierToken: $("#votifierToken").value,
        iconListingPluginEnabled: $("#iconListingPluginEnabled").value === "enabled",
        iconListingVoteKey: $("#iconListingVoteKey").value,
        websiteUrl: $("#websiteUrl").value,
        discordUrl: $("#discordUrl").value,
        youtubeUrl: $("#youtubeUrl").value,
        country: $("#serverCountry").value,
        bannerUrl: $("#bannerUrl").value,
        description: $("#description").value,
        tags: selectedTags
      }
    });
    toast("Listing saved to shared storage.");
    if (Array.isArray(result.servers) && result.user) {
      syncAuthUi(result.user);
      renderDashboard({ ...result, votes: result.votes || [] });
    } else {
      boot();
    }
  } catch (error) {
    toast(error.message);
  }
}

function settingsMarkup(user) {
  const passwordLogin = user.passwordLogin !== false;
  return `<div class="grid two">
    <form id="settingsForm" class="card form">
      <h2 class="section-title">Account Settings</h2>
      <p class="section-copy">Email status: <strong>${user.emailVerified ? "Verified" : "Not verified"}</strong></p>
      <div class="field"><label>Username</label><input id="settingsUsername" class="input" autocomplete="username" value="${escapeHtml(user.username)}" required></div>
      <div class="field"><label>Email</label><input id="settingsEmail" class="input" type="email" autocomplete="email" value="${escapeHtml(user.email)}" required></div>
      <div class="field"><label>${passwordLogin ? "New Password" : "Add Password Login"}</label><input id="settingsPassword" class="input" type="password" autocomplete="new-password" minlength="6"></div>
      <button class="button primary" type="submit">Save Account</button>
    </form>
    <form id="deleteAccountForm" class="card form danger-zone">
      <h2 class="section-title">Delete Account</h2>
      <p class="section-copy">Deleting your account also permanently removes every listing you own.</p>
      <div class="field"><label>Username</label><input id="deleteUsername" class="input" autocomplete="off" value="${escapeHtml(user.username)}" required></div>
      <div class="field"><label>Email</label><input id="deleteEmail" class="input" type="email" autocomplete="off" value="${escapeHtml(user.email)}" required></div>
      ${passwordLogin ? `<div class="field"><label>Current Password</label><input id="deletePassword" class="input" type="password" autocomplete="current-password" required></div>` : `<div class="field"><label>Confirm Email</label><input id="deleteConfirmEmail" class="input" type="email" autocomplete="off" placeholder="${escapeHtml(user.email)}" required></div>`}
      <button class="button danger" type="submit">Delete Account</button>
    </form>
  </div>`;
}

function bindSettingsForms() {
  $("#settingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await request("accountUpdate", { username: $("#settingsUsername").value, email: $("#settingsEmail").value, password: $("#settingsPassword").value });
      store.session = { token: result.token || store.session?.token, user: result.user };
      toast(result.emailVerificationMessage || "Account updated.");
      boot();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#deleteAccountForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!confirm("Delete your account and every listing you own?")) return;
    try {
      await request("deleteAccount", {
        username: $("#deleteUsername").value,
        email: $("#deleteEmail").value,
        password: $("#deletePassword")?.value || "",
        confirmEmail: $("#deleteConfirmEmail")?.value || ""
      });
      store.session = null;
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
          <div class="rank">#${server.rank}</div><div><strong>${escapeHtml(server.name)}</strong><p class="server-ip">${escapeHtml(serverAddress(server))}</p></div>
          <div class="row-actions"><button class="button" data-admin="toggleSponsor" data-id="${server.id}">${server.sponsored ? "Unsponsor" : "Sponsor"}</button><button class="button danger" data-delete="${server.id}">Delete</button></div>
        </div>`).join("") : emptyNotice()}</div></div>
        <div class="card admin-client-panel">
          <h2>User Accounts</h2>
          <p class="section-copy">Load account emails from the admin API when you need to contact users.</p>
          ${adminUserPanel(state.users)}
        </div>
        <div class="card admin-client-panel">
          <h2>${escapeHtml(copy("admin.sponsoredClientsTitle", "Sponsored Clients"))}</h2>
          <p class="section-copy">${escapeHtml(copy("admin.sponsoredClientsBody", "Create and edit sponsored Minecraft client listings."))}</p>
          ${adminClientPanel(state.clients)}
        </div>
        <div class="card admin-client-panel">
          <h2>${escapeHtml(copy("admin.sponsoredHostsTitle", "Sponsored Hosts"))}</h2>
          <p class="section-copy">${escapeHtml(copy("admin.sponsoredHostsBody", "Create and edit paid Minecraft hosting sponsor listings."))}</p>
          ${adminHostPanel(state.hosts || [])}
        </div>
      </div>
    </section>
  </div>`;
  $$("[data-admin]").forEach((button) => button.addEventListener("click", async () => {
    const label = button.textContent;
    try {
      setButtonLoading(button, "Saving...");
      const result = await request("admin", { command: button.dataset.admin, value: { id: button.dataset.id } });
      state = result.servers ? { ...state, ...result, votes: result.votes || state.votes || [] } : { ...state, users: result.users || state.users };
      if (result.servers) cachePublicState(result);
      toast("Admin change saved.");
      renderAdmin(state);
    } catch (error) {
      toast(error.message);
      setButtonLoading(button, label, false);
    }
  }));
  $$("[data-delete]").forEach((button) => button.addEventListener("click", async () => {
    try {
      setButtonLoading(button, "Deleting...");
      const result = await request("deleteServer", { id: button.dataset.delete });
      state = result.servers ? { ...state, ...result, votes: result.votes || state.votes || [] } : await getState();
      toast("Listing deleted.");
      renderAdmin(state);
    } catch (error) {
      toast(error.message);
      setButtonLoading(button, "Delete", false);
    }
  }));
  bindAdminClientForms(state);
  bindAdminHostForms(state);
  bindAdminUserPanel(state);
}

function adminUserPanel(users) {
  if (!Array.isArray(users)) {
    return `<div class="row-actions"><button id="loadAdminUsers" class="button primary" type="button">Load user emails</button></div>`;
  }
  return `<div class="dashboard-list admin-user-list">${users.length ? users.map((user) => adminUserRow(user)).join("") : `<p class="section-copy">No users have signed up yet.</p>`}</div>`;
}

function adminUserRow(user) {
  const email = String(user.email || "").trim();
  const optedIn = user.emailOptIn === true;
  const canSendReview = !!email && optedIn;
  const subject = reviewEmailSubject();
  const body = reviewEmailBody(user.username);
  return `<details class="admin-user-row">
    <summary>
      <span><strong>${escapeHtml(user.username || "Unnamed user")}</strong>${user.banned ? ` <span class="status-badge danger">Banned</span>` : ""}${user.emailVerified ? ` <span class="status-badge">Verified email</span>` : ""}${optedIn ? ` <span class="status-badge">Email opt-in</span>` : ` <span class="status-badge danger">Email opt-out</span>`}</span>
      <span class="muted">View email</span>
    </summary>
    <div class="admin-user-details">
      <p><span>Email</span><a class="text-link" href="mailto:${escapeHtml(user.email || "")}">${escapeHtml(user.email || "No email saved")}</a></p>
      ${optedIn ? "" : `<p class="admin-email-warning">! this user opted out of emails</p>`}
      <p><span>User ID</span><code>${escapeHtml(user.id || "")}</code></p>
      <div class="row-actions compact">
        <button class="button" data-email-review data-review-email="${escapeHtml(encodeURIComponent(email))}" data-review-subject="${escapeHtml(encodeURIComponent(subject))}" data-review-body="${escapeHtml(encodeURIComponent(body))}" type="button" ${canSendReview ? "" : "disabled"}>Email review link</button>
        <button class="button" data-copy-review-template data-review-email="${escapeHtml(encodeURIComponent(email))}" data-review-subject="${escapeHtml(encodeURIComponent(subject))}" data-review-body="${escapeHtml(encodeURIComponent(body))}" type="button" ${canSendReview ? "" : "disabled"}>Copy template</button>
        <button class="button" data-admin="banUser" data-id="${escapeHtml(user.id || "")}" type="button">${user.banned ? "Unban" : "Ban"}</button>
        <button class="button danger" data-admin="deleteUser" data-id="${escapeHtml(user.id || "")}" type="button">Delete user</button>
      </div>
    </div>
  </details>`;
}

function reviewEmailSubject() {
  return "Review Icon Listing";
}

function reviewEmailBody(username = "") {
  return `Hey ${username || "there"},

If you have a minute, could you leave Icon Listing a review?

${TRUSTPILOT_REVIEW_URL}

Thank you!`;
}

function decodeReviewEmailButton(button) {
  return {
    email: decodeURIComponent(button.dataset.reviewEmail || ""),
    subject: decodeURIComponent(button.dataset.reviewSubject || reviewEmailSubject()),
    body: decodeURIComponent(button.dataset.reviewBody || reviewEmailBody())
  };
}

function gmailComposeUrl(email, subject, body) {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: email,
    su: subject,
    body
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

function reviewEmailTemplate(email, subject, body) {
  return `To: ${email}
Subject: ${subject}

${body}`;
}

function bindAdminUserPanel(state) {
  $("#loadAdminUsers")?.addEventListener("click", async () => {
    try {
      const result = await request("admin", { command: "listUsers" });
      renderAdmin({ ...state, users: result.users || [] });
    } catch (error) {
      toast(error.message);
    }
  });
  $$("[data-email-review]").forEach((button) => button.addEventListener("click", async () => {
    const { email, subject, body } = decodeReviewEmailButton(button);
    const opened = window.open(gmailComposeUrl(email, subject, body), "_blank");
    if (opened) opened.opener = null;
    await copyText(reviewEmailTemplate(email, subject, body));
    if (opened) toast("Gmail compose opened. Template copied too.");
    else toast("Template copied. Allow popups or paste it into your email manually.");
  }));
  $$("[data-copy-review-template]").forEach((button) => button.addEventListener("click", async () => {
    const { email, subject, body } = decodeReviewEmailButton(button);
    await copyText(reviewEmailTemplate(email, subject, body));
    toast("Review email template copied.");
  }));
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
      const result = await request("admin", {
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
      cachePublicState(result);
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
      const result = await request("admin", { command: "deleteClient", value: { id: button.dataset.clientDelete } });
      cachePublicState(result);
      toast("Sponsored client deleted.");
      boot();
    } catch (error) {
      toast(error.message);
    }
  }));
}

function adminHostPanel(hosts) {
  return `<div class="dashboard-list admin-client-list">${hosts.length ? hosts.map((host) => `<div class="dash-item client-admin-row">
    <div class="rank">$</div>
    <div>
      <strong>${escapeHtml(host.name)}</strong>
      <p class="server-ip">${escapeHtml(host.url)}</p>
    </div>
    <div class="row-actions">
      <button class="button" data-host-edit="${escapeHtml(host.id)}" type="button">Edit</button>
      <button class="button danger" data-host-delete="${escapeHtml(host.id)}" type="button">Delete</button>
    </div>
  </div>`).join("") : `<p class="section-copy">${escapeHtml(copy("admin.noSponsoredHosts", "No sponsored hosts yet."))}</p>`}</div>
  <div id="hostFormPanel">${hostFormMarkup()}</div>`;
}

function hostFormMarkup(host = {}) {
  const images = host.images || [];
  return `<form id="hostForm" class="form client-form">
    <input id="hostId" type="hidden" value="${escapeHtml(host.id || "")}">
    <div class="form-grid">
      <div class="field"><label>Host Name</label><input id="hostName" class="input" value="${escapeHtml(host.name || "")}" required></div>
      <div class="field"><label>Website link</label><input id="hostUrl" class="input" type="url" value="${escapeHtml(host.url || "")}" required></div>
      <div class="field"><label>YouTube video</label><input id="hostYoutube" class="input" type="url" value="${escapeHtml(host.youtubeUrl || "")}"></div>
      <div class="field"><label>Showcase image 1</label><input id="hostImage1" class="input" value="${escapeHtml(images[0] || "")}"></div>
      <div class="field"><label>Showcase image 2</label><input id="hostImage2" class="input" value="${escapeHtml(images[1] || "")}"></div>
      <div class="field"><label>Showcase image 3</label><input id="hostImage3" class="input" value="${escapeHtml(images[2] || "")}"></div>
    </div>
    <div class="field"><label>Description (${CONFIG.limits.descriptionMinLength}+ characters)</label><textarea id="hostDescription" class="textarea" minlength="${CONFIG.limits.descriptionMinLength}" required>${escapeHtml(host.description || "")}</textarea></div>
    <div class="row-actions">
      <button class="button primary" type="submit">${host.id ? "Save Host" : "Create Sponsored Host"}</button>
      <button id="clearHostForm" class="button" type="button">Clear</button>
    </div>
  </form>`;
}

function bindAdminHostForms(state) {
  $("#hostForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await request("admin", {
        command: "saveHost",
        value: {
          id: $("#hostId").value,
          name: $("#hostName").value,
          url: $("#hostUrl").value,
          youtubeUrl: $("#hostYoutube").value,
          description: $("#hostDescription").value,
          images: [$("#hostImage1").value, $("#hostImage2").value, $("#hostImage3").value].filter(Boolean)
        }
      });
      cachePublicState(result);
      toast("Sponsored host saved.");
      boot();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#clearHostForm")?.addEventListener("click", () => {
    $("#hostFormPanel").innerHTML = hostFormMarkup();
    bindAdminHostForms(state);
  });
  $$("[data-host-edit]").forEach((button) => button.addEventListener("click", () => {
    const host = (state.hosts || []).find((item) => item.id === button.dataset.hostEdit);
    $("#hostFormPanel").innerHTML = hostFormMarkup(host);
    bindAdminHostForms(state);
  }));
  $$("[data-host-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Delete this sponsored host listing?")) return;
    try {
      const result = await request("admin", { command: "deleteHost", value: { id: button.dataset.hostDelete } });
      cachePublicState(result);
      toast("Sponsored host deleted.");
      boot();
    } catch (error) {
      toast(error.message);
    }
  }));
}

const MINECRAFT_COLORS = [
  ["0", "Black", "#000000"],
  ["1", "Dark Blue", "#0000aa"],
  ["2", "Dark Green", "#00aa00"],
  ["3", "Dark Aqua", "#00aaaa"],
  ["4", "Dark Red", "#aa0000"],
  ["5", "Dark Purple", "#aa00aa"],
  ["6", "Gold", "#ffaa00"],
  ["7", "Gray", "#aaaaaa"],
  ["8", "Dark Gray", "#555555"],
  ["9", "Blue", "#5555ff"],
  ["a", "Green", "#55ff55"],
  ["b", "Aqua", "#55ffff"],
  ["c", "Red", "#ff5555"],
  ["d", "Light Purple", "#ff55ff"],
  ["e", "Yellow", "#ffff55"],
  ["f", "White", "#ffffff"]
];

const MINECRAFT_COLOR_MAP = Object.fromEntries(MINECRAFT_COLORS.map(([code, , color]) => [code, color]));

function renderMotdBuilder() {
  setSeoMeta({
    title: CONFIG.seo?.pages?.motdBuilder?.title || "Minecraft MOTD Builder | Icon Listing",
    description: CONFIG.seo?.pages?.motdBuilder?.description || "Build a two-line Minecraft server MOTD with colors, formatting, centering, live preview, raw output, and shareable URL.",
    path: "/tools/motd-builder/"
  });
  const params = new URLSearchParams(location.search);
  const line1 = params.get("line1") || "&6&lAwesome &aMinecraft&f Server";
  const line2 = params.get("line2") || "&7Join now &8- &bSurvival &7and &dSkyblock";
  $("#app").innerHTML = `<div class="page tool-page">
    <section class="tool-hero">
      <div class="tool-icon">M</div>
      <div>
        <h1 class="section-title">${escapeHtml(copy("tools.motdTitle", "MOTD Builder"))}</h1>
        <p class="section-copy">${escapeHtml(copy("tools.motdBody", "Design a two-line Minecraft server MOTD with a live in-game style preview, centering helper, and shareable URL."))}</p>
      </div>
    </section>
    <section class="tool-card motd-builder">
      <div class="field">
        <div class="field-head"><label for="motdLine1">Line 1</label><button class="button small" type="button" data-center-line="motdLine1">Center</button></div>
        <input id="motdLine1" class="input motd-input" maxlength="80" value="${escapeHtml(line1)}">
        <div class="meter"><span id="motdMeter1"></span></div>
        <p class="field-hint"><span id="motdCount1">0</span>/60 visible characters</p>
      </div>
      <div class="field">
        <div class="field-head"><label for="motdLine2">Line 2</label><button class="button small" type="button" data-center-line="motdLine2">Center</button></div>
        <input id="motdLine2" class="input motd-input" maxlength="80" value="${escapeHtml(line2)}">
        <div class="meter"><span id="motdMeter2"></span></div>
        <p class="field-hint"><span id="motdCount2">0</span>/60 visible characters</p>
      </div>
      <div class="tool-block">
        <h2>Colors</h2>
        <div class="swatch-row">${MINECRAFT_COLORS.map(([code, name, color]) => `<button class="swatch" type="button" style="--swatch:${color}" data-insert-code="&${code}" title="${escapeHtml(name)}"></button>`).join("")}</div>
      </div>
      <div class="tool-block">
        <h2>Formatting</h2>
        <div class="row-actions compact">
          <button class="button small" type="button" data-insert-code="&l">B Bold</button>
          <button class="button small" type="button" data-insert-code="&o">I Italic</button>
          <button class="button small" type="button" data-insert-code="&n">U Underline</button>
          <button class="button small" type="button" data-insert-code="&m">S Strike</button>
          <button class="button small" type="button" data-insert-code="&k">Obfuscated</button>
          <button class="button small" type="button" data-insert-code="&r">Reset</button>
        </div>
      </div>
      <div class="tool-block">
        <h2>Server list preview</h2>
        <div class="motd-preview">
          <div class="motd-preview-icon"></div>
          <div class="motd-preview-copy">
            <strong>Minecraft Server</strong>
            <p id="motdPreview1"></p>
            <p id="motdPreview2"></p>
          </div>
          <span class="motd-preview-count">12/100</span>
        </div>
      </div>
      <div class="field">
        <div class="field-head"><label for="rawMotd">Raw MOTD</label><div class="row-actions compact"><button class="button small" id="shareMotd" type="button">Get URL</button><button class="button small" id="copyMotd" type="button">Copy</button></div></div>
        <textarea id="rawMotd" class="textarea code-input" readonly></textarea>
      </div>
    </section>
  </div>`;
  bindMotdBuilder();
}

function bindMotdBuilder() {
  let activeInput = $("#motdLine1");
  $$(".motd-input").forEach((input) => {
    input.addEventListener("focus", () => {
      activeInput = input;
    });
    input.addEventListener("input", updateMotdBuilder);
  });
  $$("[data-insert-code]").forEach((button) => button.addEventListener("click", () => {
    insertAtCursor(activeInput || $("#motdLine1"), button.dataset.insertCode);
    updateMotdBuilder();
  }));
  $$("[data-center-line]").forEach((button) => button.addEventListener("click", () => {
    const input = $(`#${button.dataset.centerLine}`);
    input.value = centerMotdLine(input.value);
    input.focus();
    updateMotdBuilder();
  }));
  $("#copyMotd")?.addEventListener("click", async () => {
    await copyText($("#rawMotd").value);
    toast("MOTD copied.");
  });
  $("#shareMotd")?.addEventListener("click", async () => {
    const params = new URLSearchParams({ line1: $("#motdLine1").value, line2: $("#motdLine2").value });
    const url = `${location.origin}${route("/tools/motd-builder/")}?${params.toString()}`;
    history.replaceState(null, "", url);
    await copyText(url);
    toast("MOTD link copied.");
  });
  updateMotdBuilder();
}

function updateMotdBuilder() {
  const line1 = $("#motdLine1")?.value || "";
  const line2 = $("#motdLine2")?.value || "";
  $("#motdPreview1").innerHTML = minecraftMotdHtml(line1);
  $("#motdPreview2").innerHTML = minecraftMotdHtml(line2);
  $("#rawMotd").value = `${line1}\n${line2}`;
  updateMotdCount("1", line1);
  updateMotdCount("2", line2);
}

function updateMotdCount(index, value) {
  const count = stripMinecraftCodes(value).length;
  $(`#motdCount${index}`).textContent = count;
  $(`#motdMeter${index}`).style.width = `${Math.min(100, (count / 60) * 100)}%`;
}

function centerMotdLine(value = "") {
  const visible = stripMinecraftCodes(value).trim();
  const padding = Math.max(0, Math.floor((44 - visible.length) / 2));
  return `${" ".repeat(padding)}${value.trim()}`;
}

function stripMinecraftCodes(value = "") {
  return String(value || "").replace(/&[0-9a-fk-or]/gi, "");
}

function minecraftMotdHtml(value = "") {
  let state = resetMinecraftStyle();
  let buffer = "";
  const parts = [];
  const flush = () => {
    if (!buffer) return;
    parts.push(`<span style="${minecraftStyleAttr(state)}">${escapeHtml(buffer)}</span>`);
    buffer = "";
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const code = char === "&" ? String(value[index + 1] || "").toLowerCase() : "";
    if (code && /[0-9a-fk-or]/.test(code)) {
      flush();
      index += 1;
      if (MINECRAFT_COLOR_MAP[code]) state = { ...resetMinecraftStyle(), color: MINECRAFT_COLOR_MAP[code] };
      else if (code === "l") state.bold = true;
      else if (code === "o") state.italic = true;
      else if (code === "n") state.underline = true;
      else if (code === "m") state.strike = true;
      else if (code === "k") state.obfuscated = true;
      else if (code === "r") state = resetMinecraftStyle();
    } else {
      buffer += state.obfuscated && char !== " " ? "#" : char;
    }
  }
  flush();
  return parts.join("") || "&nbsp;";
}

function resetMinecraftStyle() {
  return { color: "#ffffff", bold: false, italic: false, underline: false, strike: false, obfuscated: false };
}

function minecraftStyleAttr(state) {
  const decorations = [state.underline ? "underline" : "", state.strike ? "line-through" : ""].filter(Boolean).join(" ");
  return [
    `color:${state.color}`,
    state.bold ? "font-weight:800" : "",
    state.italic ? "font-style:italic" : "",
    decorations ? `text-decoration:${decorations}` : ""
  ].filter(Boolean).join(";");
}

function insertAtCursor(input, text) {
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
  input.focus();
  input.selectionStart = input.selectionEnd = start + text.length;
}

const DEFAULT_RGB_STOPS = ["#ff0000", "#ff8800", "#ffff00", "#21ff00", "#51dcff", "#f095ff", "#ff0000"];

function renderRgbTextGenerator() {
  setSeoMeta({
    title: CONFIG.seo?.pages?.rgbTextGenerator?.title || "Minecraft RGB Text Generator | Icon Listing",
    description: CONFIG.seo?.pages?.rgbTextGenerator?.description || "Create RGB gradient Minecraft text with hex colors, formatting, preview, and copy-ready output.",
    path: "/tools/rgb-text-generator/"
  });
  const params = new URLSearchParams(location.search);
  const text = params.get("text") || "Iconic";
  const colors = (params.get("colors") || DEFAULT_RGB_STOPS.join(",")).split(",").map(normalizeHexColor).filter(Boolean).slice(0, 12);
  $("#app").innerHTML = `<div class="page rgb-page">
    <section class="tool-hero rgb-hero">
      <div class="tool-icon">RGB</div>
      <div>
        <h1 class="section-title">${escapeHtml(copy("tools.rgbTitle", "RGB Text Generator"))}</h1>
        <p class="section-copy">${escapeHtml(copy("tools.rgbBody", "Build Minecraft RGB gradient text with hex colors, formatting, live preview, and copy-ready output."))}</p>
      </div>
    </section>
    <section class="rgb-tool">
      <div class="rgb-main">
        <div class="rgb-toolbar">
          <div class="rgb-text-label"><span>Input Text</span><small>Type directly in the gradient box</small></div>
          <div class="rgb-format-buttons">
            <select id="rgbFont" class="select"><option>Default Font</option><option>Bold headline</option><option>Compact chat</option></select>
            <button class="button small active" type="button" data-rgb-style="bold">B</button>
            <button class="button small" type="button" data-rgb-style="italic">I</button>
            <button class="button small active" type="button" data-rgb-style="underline">U</button>
            <button class="button small" type="button" data-rgb-style="strike">S</button>
          </div>
        </div>
        <input id="rgbInput" type="hidden" value="${escapeHtml(text)}">
        <div id="rgbPreviewInput" class="rgb-live-input" contenteditable="true" role="textbox" aria-label="Input text" spellcheck="false" data-placeholder="Type here"></div>
        <div id="rgbGradientBar" class="rgb-gradient-bar"></div>
        <div class="rgb-body-grid">
          <aside class="rgb-colors-panel">
            <div class="rgb-panel-head"><h2><span id="rgbColorCount">${colors.length}</span> Colors</h2><div class="row-actions compact"><button id="rgbRemoveColor" class="button small" type="button">-</button><button id="rgbAddColor" class="button small" type="button">+</button></div></div>
            <div class="rgb-mini-actions">
              <button class="button small" type="button" data-rgb-preset="rainbow">Rainbow</button>
              <button class="button small" type="button" data-rgb-preset="ice">Ice</button>
              <button class="button small" type="button" data-rgb-preset="icon">Icon</button>
            </div>
            <div id="rgbColorRows" class="rgb-color-rows">${colors.map(rgbColorRow).join("")}</div>
          </aside>
          <div class="rgb-output-panel">
            <div class="rgb-panel-head">
              <h2>Output</h2>
              <div class="rgb-output-actions">
                <select id="rgbOutputFormat" class="select"><option value="amp">&amp;#rrggbb</option><option value="legacy">&amp;x&amp;r&amp;r...</option><option value="section">&sect;x&sect;r&sect;r...</option><option value="minimessage">MiniMessage gradient</option></select>
                <button id="rgbCopyOutput" class="button small" type="button">Copy</button>
                <button id="rgbShareUrl" class="button small" type="button">Get URL</button>
              </div>
            </div>
            <textarea id="rgbOutput" class="textarea code-input rgb-output" readonly></textarea>
            <div class="rgb-options">
              <label class="field"><span>Prefix</span><input id="rgbPrefix" class="input" placeholder="/nick $"></label>
              <label class="field"><span>Characters per color</span><input id="rgbCharsPerColor" class="input" type="number" min="1" max="8" value="1"></label>
              <label class="check-row"><input id="rgbTrimSpaces" type="checkbox" checked> Trim colors from spaces</label>
              <label class="check-row"><input id="rgbLowercase" type="checkbox"> Lowercase hex codes</label>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>`;
  bindRgbTextGenerator();
}

function rgbColorRow(color, index) {
  return `<div class="rgb-color-row">
    <span>${index + 1}</span>
    <input class="rgb-color-input" type="color" value="${escapeHtml(color)}">
    <input class="input rgb-hex-input" value="${escapeHtml(color.toUpperCase())}" maxlength="7">
    <button class="mini-button" type="button" data-rgb-delete="${index}">Delete</button>
  </div>`;
}

function bindRgbTextGenerator() {
  const update = () => updateRgbGenerator();
  $("#rgbPreviewInput")?.addEventListener("input", () => {
    const editor = $("#rgbPreviewInput");
    $("#rgbInput").value = rgbEditorText(editor).slice(0, 160);
    updateRgbGenerator({ preserveCaret: true });
  });
  $("#rgbPreviewInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });
  $("#rgbPreviewInput")?.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = (event.clipboardData || window.clipboardData).getData("text").replace(/\s+/g, " ").slice(0, 160);
    document.execCommand("insertText", false, text);
  });
  $("#rgbOutputFormat")?.addEventListener("change", update);
  $("#rgbPrefix")?.addEventListener("input", update);
  $("#rgbCharsPerColor")?.addEventListener("input", update);
  $("#rgbTrimSpaces")?.addEventListener("change", update);
  $("#rgbLowercase")?.addEventListener("change", update);
  $("#rgbFont")?.addEventListener("change", update);
  $$("[data-rgb-style]").forEach((button) => button.addEventListener("click", () => {
    button.classList.toggle("active");
    update();
  }));
  $("#rgbAddColor")?.addEventListener("click", () => {
    const colors = rgbColors();
    colors.push(colors[colors.length - 1] || "#ffffff");
    renderRgbColorRows(colors);
    update();
  });
  $("#rgbRemoveColor")?.addEventListener("click", () => {
    const colors = rgbColors();
    if (colors.length > 2) colors.pop();
    renderRgbColorRows(colors);
    update();
  });
  $$("[data-rgb-preset]").forEach((button) => button.addEventListener("click", () => {
    const presets = {
      rainbow: DEFAULT_RGB_STOPS,
      ice: ["#38bdf8", "#ffffff", "#8b5cf6"],
      icon: ["#8b5cf6", "#ec4899", "#38bdf8"]
    };
    renderRgbColorRows(presets[button.dataset.rgbPreset] || DEFAULT_RGB_STOPS);
    update();
  }));
  $("#rgbColorRows")?.addEventListener("input", (event) => {
    if (event.target.classList.contains("rgb-color-input")) {
      event.target.closest(".rgb-color-row").querySelector(".rgb-hex-input").value = event.target.value.toUpperCase();
    }
    if (event.target.classList.contains("rgb-hex-input")) {
      const color = normalizeHexColor(event.target.value);
      if (color) event.target.closest(".rgb-color-row").querySelector(".rgb-color-input").value = color;
    }
    update();
  });
  $("#rgbColorRows")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-rgb-delete]");
    if (!button) return;
    const colors = rgbColors();
    if (colors.length <= 2) return;
    colors.splice(Number(button.dataset.rgbDelete), 1);
    renderRgbColorRows(colors);
    update();
  });
  $("#rgbCopyOutput")?.addEventListener("click", async () => {
    await copyText($("#rgbOutput").value);
    toast("RGB text copied.");
  });
  $("#rgbShareUrl")?.addEventListener("click", async () => {
    const params = new URLSearchParams({ text: $("#rgbInput").value, colors: rgbColors().join(",") });
    const url = `${location.origin}${route("/tools/rgb-text-generator/")}?${params.toString()}`;
    history.replaceState(null, "", url);
    await copyText(url);
    toast("RGB generator link copied.");
  });
  update();
}

function renderRgbColorRows(colors) {
  $("#rgbColorRows").innerHTML = colors.map((color, index) => rgbColorRow(color, index)).join("");
}

function rgbColors() {
  const rows = $$(".rgb-color-row");
  const colors = rows.map((row) => normalizeHexColor(row.querySelector(".rgb-hex-input")?.value || row.querySelector(".rgb-color-input")?.value)).filter(Boolean);
  return colors.length >= 2 ? colors : DEFAULT_RGB_STOPS.slice(0, 2);
}

function updateRgbGenerator(options = {}) {
  const text = $("#rgbInput")?.value || "";
  const colors = rgbColors();
  const styles = rgbStyles();
  const lowercase = $("#rgbLowercase")?.checked;
  const format = $("#rgbOutputFormat")?.value || "amp";
  const prefix = $("#rgbPrefix")?.value || "";
  const gradient = gradientForText(text, colors, Number($("#rgbCharsPerColor")?.value || 1), $("#rgbTrimSpaces")?.checked !== false);
  $("#rgbColorCount").textContent = colors.length;
  $("#rgbGradientBar").style.background = `linear-gradient(90deg, ${colors.join(", ")})`;
  renderRgbEditor(gradient, styles, options.preserveCaret === true);
  $("#rgbOutput").value = prefix + rgbFormattedOutput(gradient, colors, format, styles, lowercase);
}

function rgbEditorText(editor = $("#rgbPreviewInput")) {
  return String(editor?.textContent || "").replace(/\u00a0/g, " ").replace(/\r?\n/g, " ");
}

function renderRgbEditor(gradient, styles, preserveCaret = false) {
  const editor = $("#rgbPreviewInput");
  if (!editor) return;
  const wasFocused = document.activeElement === editor;
  const caret = preserveCaret && wasFocused ? rgbCaretOffset(editor) : null;
  editor.innerHTML = gradient.length
    ? gradient.map((part) => `<span style="${rgbPreviewStyle(part.color, styles)}">${part.char === " " ? "&nbsp;" : escapeHtml(part.char)}</span>`).join("")
    : "";
  if (wasFocused && caret !== null) restoreRgbCaret(editor, Math.min(caret, rgbEditorText(editor).length));
}

function rgbCaretOffset(editor) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return rgbEditorText(editor).length;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.endContainer)) return rgbEditorText(editor).length;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.endContainer, range.endOffset);
  return prefix.toString().replace(/\u00a0/g, " ").length;
}

function restoreRgbCaret(editor, offset) {
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  let remaining = offset;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const length = node.nodeValue.length;
    if (remaining <= length) {
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function rgbStyles() {
  return Object.fromEntries($$("[data-rgb-style]").map((button) => [button.dataset.rgbStyle, button.classList.contains("active")]));
}

function gradientForText(text, colors, charsPerColor = 1, trimSpaces = true) {
  const chars = [...text];
  const colorTargets = trimSpaces ? chars.filter((char) => char !== " ") : chars;
  const total = Math.max(1, Math.ceil(colorTargets.length / Math.max(1, charsPerColor)));
  let visibleIndex = 0;
  return chars.map((char) => {
    if (trimSpaces && char === " ") return { char, color: "" };
    const colorIndex = Math.floor(visibleIndex / Math.max(1, charsPerColor));
    visibleIndex += 1;
    return { char, color: interpolateGradient(colors, total <= 1 ? 0 : colorIndex / (total - 1)) };
  });
}

function interpolateGradient(colors, ratio) {
  if (colors.length === 1) return colors[0];
  const scaled = Math.max(0, Math.min(1, ratio)) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const a = hexToRgb(colors[index]);
  const b = hexToRgb(colors[index + 1]);
  return rgbToHex({
    r: Math.round(a.r + (b.r - a.r) * local),
    g: Math.round(a.g + (b.g - a.g) * local),
    b: Math.round(a.b + (b.b - a.b) * local)
  });
}

function rgbFormattedOutput(gradient, colors, format, styles, lowercase = false) {
  const styleCodes = `${styles.bold ? "&l" : ""}${styles.italic ? "&o" : ""}${styles.underline ? "&n" : ""}${styles.strike ? "&m" : ""}`;
  const section = "\u00a7";
  if (format === "minimessage") {
    const tags = [styles.bold ? "bold" : "", styles.italic ? "italic" : "", styles.underline ? "underlined" : "", styles.strike ? "st" : ""].filter(Boolean);
    const open = tags.map((tag) => `<${tag}>`).join("");
    const close = tags.reverse().map((tag) => `</${tag}>`).join("");
    return `${open}<gradient:${colors.map((color) => colorForOutput(color, lowercase)).join(":")}>${$("#rgbInput")?.value || ""}</gradient>${close}`;
  }
  return gradient.map((part) => {
    if (!part.color) return part.char;
    const color = colorForOutput(part.color, lowercase).replace("#", "");
    if (format === "legacy") return `&x${[...color].map((char) => `&${char}`).join("")}${styleCodes}${part.char}`;
    if (format === "section") return `${section}x${[...color].map((char) => `${section}${char}`).join("")}${styleCodes.replace(/&/g, section)}${part.char}`;
    return `&#${color}${styleCodes}${part.char}`;
  }).join("");
}

function colorForOutput(color, lowercase = false) {
  const next = normalizeHexColor(color) || "#ffffff";
  return lowercase ? next.toLowerCase() : next.toUpperCase();
}

function rgbPreviewStyle(color, styles) {
  return [
    color ? `color:${color}` : "",
    styles.bold ? "font-weight:900" : "",
    styles.italic ? "font-style:italic" : "",
    styles.underline || styles.strike ? `text-decoration:${[styles.underline ? "underline" : "", styles.strike ? "line-through" : ""].filter(Boolean).join(" ")}` : ""
  ].filter(Boolean).join(";");
}

function normalizeHexColor(value = "") {
  const next = String(value || "").trim();
  const short = next.match(/^#?([a-f0-9]{3})$/i)?.[1];
  if (short) return `#${short.split("").map((char) => `${char}${char}`).join("")}`;
  const full = next.match(/^#?([a-f0-9]{6})$/i)?.[1];
  return full ? `#${full}`.toLowerCase() : "";
}

function hexToRgb(hex) {
  const cleanHex = normalizeHexColor(hex).replace("#", "") || "ffffff";
  return {
    r: parseInt(cleanHex.slice(0, 2), 16),
    g: parseInt(cleanHex.slice(2, 4), 16),
    b: parseInt(cleanHex.slice(4, 6), 16)
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

const FONT_GENERATOR_STYLES = [
  { id: "small-caps", label: "Small Caps", description: "Clean compact capitals for ranks, tags, and server names." },
  { id: "superscript", label: "Superscript", description: "Raised tiny text for suffixes and detail labels." },
  { id: "subscript", label: "Subscript", description: "Lower tiny text for detail labels and themed names." },
  { id: "bold", label: "Bold", description: "Heavy Unicode text for short labels." },
  { id: "italic", label: "Italic", description: "Slanted Unicode text for names and soft announcements." },
  { id: "monospace", label: "Monospace", description: "Even-width Unicode text for clean technical labels." },
  { id: "fullwidth", label: "Fullwidth", description: "Wide display text for titles and announcements." },
  { id: "plain", label: "Plain", description: "Normal text with spacing preserved." }
];

function renderFontsGenerator() {
  setSeoMeta({
    title: CONFIG.seo?.pages?.fontsGenerator?.title || "Minecraft Fonts Generator | Icon Listing",
    description: CONFIG.seo?.pages?.fontsGenerator?.description || "Generate Minecraft-friendly Unicode fonts including small caps, superscript, subscript, bold, monospace, and fullwidth text.",
    path: "/tools/fonts-generator/"
  });
  $("#app").innerHTML = `<div class="page fonts-page">
    <section class="tool-hero fonts-hero">
      <div class="tool-icon">Aa</div>
      <div>
        <h1 class="section-title">${escapeHtml(copy("tools.fontsTitle", "Fonts Generator"))}</h1>
        <p class="section-copy">${escapeHtml(copy("tools.fontsBody", "Convert plain text into Minecraft-friendly Unicode styles, including small caps, superscript, subscript, and clean display fonts."))}</p>
      </div>
    </section>
    <section class="font-generator">
      <div class="font-generator-bar">
        <label class="field">
          <span>Font</span>
          <select id="fontStyle" class="select">
            ${FONT_GENERATOR_STYLES.map((style) => `<option value="${escapeHtml(style.id)}">${escapeHtml(style.label)}</option>`).join("")}
          </select>
        </label>
        <button id="fontCopyOutput" class="button" type="button">Copy</button>
      </div>
      <div class="font-editor-grid">
        <label class="font-box">
          <span>Normal text</span>
          <textarea id="fontInput" class="textarea font-textarea" placeholder="Normal text goes here...">Iconic</textarea>
        </label>
        <label class="font-box">
          <span>Generated text</span>
          <textarea id="fontOutput" class="textarea font-textarea font-output" readonly placeholder="Generated text will appear here..."></textarea>
        </label>
      </div>
      <div id="fontPreview" class="font-preview" aria-live="polite"></div>
      <div id="fontDescription" class="fine-print"></div>
    </section>
  </div>`;
  bindFontsGenerator();
}

function bindFontsGenerator() {
  $("#fontInput")?.addEventListener("input", updateFontsGenerator);
  $("#fontStyle")?.addEventListener("change", updateFontsGenerator);
  $("#fontCopyOutput")?.addEventListener("click", async () => {
    await copyText($("#fontOutput")?.value || "");
    toast("Generated font copied.");
  });
  updateFontsGenerator();
}

function updateFontsGenerator() {
  const input = $("#fontInput")?.value || "";
  const style = $("#fontStyle")?.value || "small-caps";
  const output = transformFontText(input, style);
  const definition = FONT_GENERATOR_STYLES.find((item) => item.id === style) || FONT_GENERATOR_STYLES[0];
  if ($("#fontOutput")) $("#fontOutput").value = output;
  if ($("#fontPreview")) $("#fontPreview").textContent = output || "Generated text preview";
  if ($("#fontDescription")) $("#fontDescription").textContent = definition.description;
}

function transformFontText(value = "", style = "small-caps") {
  if (style === "small-caps") return mapByTable(value, SMALL_CAPS_MAP, { lowerFallback: true });
  if (style === "superscript") return mapByTable(value, SUPERSCRIPT_MAP, { lowerFallback: false });
  if (style === "subscript") return mapByTable(value, SUBSCRIPT_MAP, { lowerFallback: false });
  if (style === "bold") return mapMathRange(value, { upper: 0x1D400, lower: 0x1D41A, digit: 0x1D7CE });
  if (style === "italic") return mapMathRange(value, { upper: 0x1D434, lower: 0x1D44E, exceptions: { h: "ℎ" } });
  if (style === "monospace") return mapMathRange(value, { upper: 0x1D670, lower: 0x1D68A, digit: 0x1D7F6 });
  if (style === "fullwidth") return [...value].map((char) => {
    const code = char.codePointAt(0);
    if (char === " ") return " ";
    if (code >= 33 && code <= 126) return String.fromCodePoint(code + 0xFEE0);
    return char;
  }).join("");
  return value;
}

function mapMathRange(value = "", ranges = {}) {
  return [...value].map((char) => {
    if (ranges.exceptions?.[char]) return ranges.exceptions[char];
    const code = char.codePointAt(0);
    if (ranges.upper && code >= 65 && code <= 90) return String.fromCodePoint(ranges.upper + code - 65);
    if (ranges.lower && code >= 97 && code <= 122) return String.fromCodePoint(ranges.lower + code - 97);
    if (ranges.digit && code >= 48 && code <= 57) return String.fromCodePoint(ranges.digit + code - 48);
    return char;
  }).join("");
}

function mapByTable(value = "", table = {}, options = {}) {
  return [...value].map((char) => table[char] || (options.lowerFallback ? table[char.toLowerCase()] : "") || char).join("");
}

const SMALL_CAPS_MAP = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ", j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ",
  n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ", s: "ꜱ", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ"
};

const SUPERSCRIPT_MAP = {
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ", K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ", O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ᶦ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾"
};

const SUBSCRIPT_MAP = {
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
  0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎"
};

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    window.prompt("Copy", value);
  }
}

function renderVotifierTester() {
  setSeoMeta({
    title: CONFIG.seo?.pages?.votifierTester?.title || "Votifier Tester | NuVotifier & AzuVotifier Tool",
    description: CONFIG.seo?.pages?.votifierTester?.description || "Test Votifier, NuVotifier, and AzuVotifier settings with host, port, token or public key, and a Minecraft username.",
    path: "/tools/votifier-tester/"
  });
  $("#app").innerHTML = `<div class="page tool-page">
    <section class="tool-hero">
      <div class="tool-icon">V</div>
      <div>
        <h1 class="section-title">${escapeHtml(copy("tools.votifierTitle", "Votifier Tester"))}</h1>
        <p class="section-copy">${escapeHtml(copy("tools.votifierBody", "Check Votifier, NuVotifier, or AzuVotifier settings before connecting voting to a Minecraft server listing."))}</p>
      </div>
    </section>
    <section class="tool-card votifier-tool-card">
      <form id="votifierToolForm" class="form">
        <div class="form-grid">
          <div class="field"><label>Listener type</label><select id="toolVotifierType" class="select">
            <option value="auto">Auto detect</option>
            <option value="nuvotifier">NuVotifier</option>
            <option value="azuvotifier">AzuVotifier</option>
            <option value="votifier">Votifier / Classic</option>
          </select></div>
          <div class="field"><label>Test username</label><input id="toolVotifierUsername" class="input" value="${escapeHtml(CONFIG.votifier.testUsername || "IconListingTest")}" maxlength="16"></div>
          <div class="field"><label>Votifier host</label><input id="toolVotifierHost" class="input" placeholder="play.example.com" required></div>
          <div class="field"><label>Port</label><input id="toolVotifierPort" class="input" type="number" value="8192" required></div>
        </div>
        <div class="field"><label>Token / public key</label><textarea id="toolVotifierToken" class="textarea code-input" placeholder="NuVotifier/AzuVotifier token or Votifier public key" required></textarea></div>
        <div class="row-actions">
          <button class="button primary" type="submit">Test connection</button>
          <a class="button" href="${escapeHtml(CONFIG.votifier.documentationUrl || "https://github.com/NuVotifier/NuVotifier")}">Docs</a>
        </div>
        <div id="votifierToolResult" class="notice hidden"></div>
      </form>
    </section>
  </div>`;
  bindVotifierTester();
}

function bindVotifierTester() {
  $("#votifierToolForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = $("#votifierToolResult");
    result.classList.remove("hidden");
    result.textContent = "Testing...";
    try {
      const response = await request("votifierToolTest", {
        type: $("#toolVotifierType").value,
        host: $("#toolVotifierHost").value,
        port: $("#toolVotifierPort").value,
        token: $("#toolVotifierToken").value,
        minecraftUsername: $("#toolVotifierUsername").value
      });
      result.textContent = response.message || "Votifier test sent.";
    } catch (error) {
      result.textContent = publicRequestError("votifierToolTest", error);
    }
  });
}

function renderStatic(page) {
  const staticCopy = normalizeStaticPage(CONFIG.copy?.staticPages?.[page]);
  setSeoMeta({
    title: `${staticCopy.title} | ${CONFIG.site.name}`,
    description: staticCopy.description,
    path: `/${page}/`
  });
  $("#app").innerHTML = `<div class="page"><section class="section card policy-card">
    <h1 class="section-title">${escapeHtml(staticCopy.title)}</h1>
    <p class="section-copy">${escapeHtml(staticCopy.description)}</p>
    ${staticCopy.updated ? `<p class="policy-updated">Last updated: ${escapeHtml(staticCopy.updated)}</p>` : ""}
    <div class="policy-content">${staticCopy.sections.map(policySectionMarkup).join("")}</div>
  </section></div>`;
}

function normalizeStaticPage(value) {
  if (Array.isArray(value)) {
    return {
      title: value[0] || "Page",
      description: value[1] || "This page is ready to configure.",
      updated: "",
      sections: [{ body: value[1] || "This page is ready to configure." }]
    };
  }
  if (value && typeof value === "object") {
    return {
      title: value.title || "Page",
      description: value.description || "",
      updated: value.updated || "",
      sections: Array.isArray(value.sections) ? value.sections : []
    };
  }
  return normalizeStaticPage(["Page", "This page is ready to configure."]);
}

function policySectionMarkup(section = {}) {
  const bullets = Array.isArray(section.bullets) ? section.bullets : [];
  return `<section class="policy-section">
    ${section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : ""}
    ${section.body ? `<p>${escapeHtml(section.body)}</p>` : ""}
    ${bullets.length ? `<ul>${bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
  </section>`;
}

function publicBootState() {
  const cached = store.publicState;
  if (cached) return publicClientState(cached, { user: store.session?.user || null, apiHydrating: true });
  return publicClientState({}, { user: store.session?.user || null, apiHydrating: true });
}

function pageCanRenderBeforeApi(page) {
  return !["server", "vote", "dashboard", "admin"].includes(page);
}

function renderCurrentPage(page, state) {
  if (page === "home") renderHome(state);
  else if (page === "servers") renderServers(state);
  else if (page === "server") renderServerDetail(state);
  else if (page === "vote") renderVotePage(state);
  else if (page === "sponsored") renderSponsored(state);
  else if (page === "sponsored-clients") renderClients(state);
  else if (page === "sponsored-hosts") renderHosts(state);
  else if (page === "plans") renderPlans(state);
  else if (page === "motd-builder") renderMotdBuilder(state);
  else if (page === "votifier-tester") renderVotifierTester(state);
  else if (page === "rgb-text-generator") renderRgbTextGenerator(state);
  else if (page === "fonts-generator") renderFontsGenerator(state);
  else if (page === "login") renderLogin(state);
  else if (page === "dashboard") renderDashboard(state);
  else if (page === "admin") renderAdmin(state);
  else renderStatic(page);
}

function showBootFailure(page, error, seoFallbackHtml = "") {
  if (page === "server") {
    const cachedState = publicBootState();
    if (findServerFromLocation(cachedState.servers)) {
      renderServerDetail(cachedState);
      return;
    }
    if (!isNetworkAbort(error) && !isNetworkAbort(error?.originalError)) console.warn("Icon Listing server detail refresh failed", error);
    if (seoFallbackHtml) {
      $("#app").innerHTML = seoFallbackHtml;
      return;
    }
  }
  if (pageCanRenderBeforeApi(page)) {
    console.warn("Icon Listing state refresh failed", error);
    return;
  }
  const refreshing = scheduleNetworkRefresh(error);
  const message = refreshing ? networkApiMessage() : publicRequestError("state", error);
  $("#app").innerHTML = `<div class="page"><div class="notice">${escapeHtml(message)}</div></div>`;
}

async function boot() {
  clearLegacyLocalOverlays();
  const googleAuthResult = consumeGoogleAuthHash();
  const page = document.body.dataset.page || "home";
  const seoFallbackHtml = $(".seo-fallback")?.outerHTML || "";
  let liveStateRendered = false;
  if (!$("#app")) renderLayout();
  syncAuthUi(store.session?.user || null);
  if (pageCanRenderBeforeApi(page)) {
    renderCurrentPage(page, publicBootState());
  } else if (page === "server" && seoFallbackHtml) {
    $("#app").innerHTML = seoFallbackHtml;
  }
  if (pageCanRenderBeforeApi(page) || page === "server") {
    loadPublicSnapshotState().then((snapshotState) => {
      if (liveStateRendered || !snapshotState) return;
      if (page === "server" && !findServerFromLocation(snapshotState.servers)) return;
      renderCurrentPage(page, snapshotState);
    });
  }
  try {
    const state = await getState();
    liveStateRendered = true;
    syncAuthUi(state.user);
    renderCurrentPage(page, state);
    if (googleAuthResult?.message) toast(googleAuthResult.message);
  } catch (error) {
    showBootFailure(page, error, seoFallbackHtml);
  }
}

document.addEventListener("DOMContentLoaded", boot);
