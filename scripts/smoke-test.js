const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const dbPath = path.join(os.tmpdir(), `icon-listing-smoke-${Date.now()}.json`);
const backupPath = `${dbPath}.backup.json`;
const recoveryPath = `${dbPath}.recovery.json`;
process.env.ICON_LISTING_DB_PATH = dbPath;
process.env.ICON_LISTING_DB_BACKUP_PATH = backupPath;
process.env.ICON_LISTING_RECOVERY_DB_PATH = recoveryPath;

const CONFIG = require("../config.js");
const handler = require("../api/index.js");

function response() {
  return {
    code: 0,
    body: "",
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.code = code;
      return this;
    },
    end(body) {
      this.body = body;
      return this;
    }
  };
}

async function call(action, body = {}, token = "", method = "POST", headers = {}) {
  const query = { action };
  if (method === "GET") {
    Object.entries(body || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") query[key] = value;
    });
  }
  const params = new URLSearchParams(query);
  const req = {
    method,
    url: `/api?${params.toString()}`,
    query,
    body,
    headers: {
      authorization: token ? `Bearer ${token}` : "",
      ...(token ? { "x-iconlisting-token": token } : {}),
      ...headers
    }
  };
  const res = response();
  await handler(req, res);
  return { code: res.code, json: JSON.parse(res.body) };
}

async function callRaw(action, body = {}, method = "GET") {
  const req = {
    method,
    url: action === "sitemap" ? "/sitemap.xml" : `/api?action=${encodeURIComponent(action)}`,
    query: action === "sitemap" ? {} : { action },
    body,
    headers: {}
  };
  const res = response();
  await handler(req, res);
  return { code: res.code, body: res.body, headers: res.headers };
}

async function callPath(pathname, method = "GET") {
  const req = {
    method,
    url: pathname,
    query: {},
    body: {},
    headers: {}
  };
  const res = response();
  await handler(req, res);
  return { code: res.code, body: res.body, headers: res.headers };
}

async function callText(action, body = "", method = "POST", headers = {}) {
  const req = {
    method,
    url: `/api?action=${encodeURIComponent(action)}`,
    query: { action },
    body,
    headers
  };
  const res = response();
  await handler(req, res);
  return { code: res.code, json: JSON.parse(res.body) };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function serverSlug(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "server";
}

function parseNuVotifierFrame(chunk) {
  if (chunk.length < 4) throw new Error("NuVotifier frame is missing its header");
  const magic = chunk.readUInt16BE(0);
  const length = chunk.readUInt16BE(2);
  const rawMessage = chunk.subarray(4, 4 + length).toString("utf8");
  const message = JSON.parse(rawMessage);
  return {
    magic,
    length,
    packetBytes: chunk.length,
    message,
    payload: JSON.parse(message.payload),
    payloadIsJson: message.payload.trim().startsWith("{")
  };
}

function createNuVotifierFrameServer({ token, challenge, received, resolve }) {
  return net.createServer((socket) => {
    socket.write(`VOTIFIER 2 ${challenge}\n`);
    socket.on("data", (chunk) => {
      const frame = parseNuVotifierFrame(chunk);
      const signature = crypto.createHmac("sha256", token).update(frame.message.payload).digest("base64");
      received.push({
        packetBytes: frame.packetBytes,
        frameMagic: frame.magic,
        frameLength: frame.length,
        payloadIsJson: frame.payloadIsJson,
        signatureValid: signature === frame.message.signature,
        payload: frame.payload
      });
      resolve();
      socket.end();
    });
  });
}

async function main() {
  const received = [];
  const tcpServers = [];
  let providerStatus = 200;
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push(JSON.parse(body || "{}"));
      res.writeHead(providerStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: providerStatus >= 200 && providerStatus < 300 }));
    });
  });

  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  CONFIG.votifier.providerEndpoint = `http://127.0.0.1:${provider.address().port}/vote`;

  try {
    const firstState = await call("state", {}, "", "GET");
    assert(firstState.json.servers.length === 0, "initial server list should be empty");
    assert(firstState.json.clients.length === 0, "initial client list should be empty");
    assert(firstState.json.hosts.length === 0, "initial host list should be empty");

    const getLogin = await call("login", {}, "", "GET");
    assert(getLogin.code === 405, "login should reject GET requests");

    const invalidJson = await callText("login", "{bad json", "POST");
    assert(invalidJson.code === 400, "invalid JSON bodies should be rejected cleanly");

    const badOrigin = await call("register", {
      username: "BlockedOrigin",
      email: "blocked-origin@example.com",
      password: "secret123",
      termsAccepted: true
    }, "", "POST", { origin: "https://evil.example" });
    assert(badOrigin.code === 403, "write actions should reject unapproved browser origins");

    const suffix = Date.now();
    const previousGoogleClientId = process.env.GOOGLE_CLIENT_ID;
    const previousGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const previousFetch = global.fetch;
    process.env.GOOGLE_CLIENT_ID = "smoke-google-client";
    process.env.GOOGLE_CLIENT_SECRET = "smoke-google-secret";
    const googleStart = await callRaw("googleStart", {}, "GET");
    assert(googleStart.code === 302 && String(googleStart.headers.Location || "").includes("accounts.google.com"), "Google OAuth start should redirect to Google");
    const googleState = new URL(googleStart.headers.Location).searchParams.get("state");
    global.fetch = async (url) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return { ok: true, json: async () => ({ access_token: "smoke-google-access" }) };
      }
      if (String(url).includes("openidconnect.googleapis.com/v1/userinfo")) {
        return { ok: true, json: async () => ({ sub: `google-${suffix}`, email: `google${suffix}@example.com`, email_verified: true, name: "Google Smoke" }) };
      }
      return previousFetch(url);
    };
    const googleCallback = await callPath(`/api/google-callback?code=smoke-code&state=${encodeURIComponent(googleState)}`);
    global.fetch = previousFetch;
    if (previousGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousGoogleClientId;
    if (previousGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousGoogleClientSecret;
    assert(googleCallback.code === 302 && String(googleCallback.headers.Location || "").includes("googleToken="), "Google OAuth callback should create a signed session");
    const googleToken = new URL(googleCallback.headers.Location).hash.replace(/^#/, "");
    const googleSession = new URLSearchParams(googleToken).get("googleToken");
    const googleStateRead = await call("state", {}, googleSession, "GET");
    assert(googleStateRead.code === 200 && googleStateRead.json.user?.emailVerified === true, "Google OAuth users should have verified email status");

    const previousGithubToken = process.env.GITHUB_TOKEN;
    const previousGithubRepo = process.env.GITHUB_REPO;
    const previousGithubBranch = process.env.GITHUB_BRANCH;
    const previousGithubDbPath = process.env.GITHUB_DB_PATH;
    const previousGithubBackupPath = process.env.GITHUB_DB_BACKUP_PATH;
    process.env.GOOGLE_CLIENT_ID = "smoke-google-client";
    process.env.GOOGLE_CLIENT_SECRET = "smoke-google-secret";
    process.env.GITHUB_TOKEN = "smoke-github-token";
    process.env.GITHUB_REPO = "SmokeOwner/SmokeRepo";
    process.env.GITHUB_BRANCH = "main";
    process.env.GITHUB_DB_PATH = `data/smoke-google-${suffix}.json`;
    process.env.GITHUB_DB_BACKUP_PATH = `data/smoke-google-${suffix}.backup.json`;
    const githubFiles = new Map();
    const githubShas = new Map();
    const staleReads = new Map();
    const staleContents = new Map();
    const githubPathFromUrl = (url) => {
      const pathname = new URL(String(url)).pathname;
      const marker = "/contents/";
      return decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
    };
    global.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "smoke-google-stale-access" }) };
      }
      if (href.includes("openidconnect.googleapis.com/v1/userinfo")) {
        return { ok: true, status: 200, json: async () => ({ sub: `google-stale-${suffix}`, email: `googlestale${suffix}@example.com`, email_verified: true, name: "Google Stale Smoke" }) };
      }
      if (href.includes("api.github.com/repos/SmokeOwner/SmokeRepo/contents/")) {
        const filePath = githubPathFromUrl(url);
        if (options.method === "PUT") {
          const body = JSON.parse(options.body || "{}");
          staleContents.set(filePath, githubFiles.get(filePath));
          staleReads.set(filePath, 1);
          githubFiles.set(filePath, body.content);
          githubShas.set(filePath, `sha-${githubFiles.size}-${Date.now()}`);
          return { ok: true, status: 200, json: async () => ({ content: { sha: githubShas.get(filePath) } }) };
        }
        const shouldServeStale = Number(staleReads.get(filePath) || 0) > 0;
        if (shouldServeStale) staleReads.set(filePath, Number(staleReads.get(filePath)) - 1);
        const content = shouldServeStale ? staleContents.get(filePath) : githubFiles.get(filePath);
        if (!content) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ content, sha: githubShas.get(filePath) || "sha-0" }) };
      }
      return previousFetch(url, options);
    };
    const staleGoogleStart = await callRaw("googleStart", {}, "GET");
    const staleGoogleState = new URL(staleGoogleStart.headers.Location).searchParams.get("state");
    const staleGoogleCallback = await callPath(`/api/google-callback?code=smoke-stale-code&state=${encodeURIComponent(staleGoogleState)}`);
    global.fetch = previousFetch;
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousGithubRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = previousGithubRepo;
    if (previousGithubBranch === undefined) delete process.env.GITHUB_BRANCH;
    else process.env.GITHUB_BRANCH = previousGithubBranch;
    if (previousGithubDbPath === undefined) delete process.env.GITHUB_DB_PATH;
    else process.env.GITHUB_DB_PATH = previousGithubDbPath;
    if (previousGithubBackupPath === undefined) delete process.env.GITHUB_DB_BACKUP_PATH;
    else process.env.GITHUB_DB_BACKUP_PATH = previousGithubBackupPath;
    if (previousGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousGoogleClientId;
    if (previousGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousGoogleClientSecret;
    assert(staleGoogleCallback.code === 302 && String(staleGoogleCallback.headers.Location || "").includes("googleToken="), "Google OAuth should survive a stale GitHub read after saving the account");

    const missingTerms = await call("register", {
      username: `NoTerms${suffix}`,
      email: `noterms${suffix}@example.com`,
      password: "secret123"
    });
    assert(missingTerms.code === 400, "register should require terms acceptance");

    const sentVerificationEmails = [];
    const previousResendApiKey = process.env.RESEND_API_KEY;
    const previousResendFromEmail = process.env.RESEND_FROM_EMAIL;
    const previousResendReplyTo = process.env.RESEND_REPLY_TO;
    const previousResendFetch = global.fetch;
    process.env.RESEND_API_KEY = "smoke-resend-key";
    process.env.RESEND_FROM_EMAIL = "Icon Listing <verify@noreply.iconrealms.net>";
    process.env.RESEND_REPLY_TO = "support@example.com";
    global.fetch = async (url, options = {}) => {
      if (String(url).includes("api.resend.com/emails")) {
        sentVerificationEmails.push(JSON.parse(options.body || "{}"));
        return { ok: true, json: async () => ({ id: `email-${suffix}` }), text: async () => "" };
      }
      return previousResendFetch(url, options);
    };
    const register = await call("register", {
      username: `Smoke${suffix}`,
      email: `smoke${suffix}@example.com`,
      password: "secret123",
      emailOptIn: true,
      termsAccepted: true
    });
    assert(register.code === 200 && register.json.pendingVerification && register.json.verificationToken, "register should return a pending email verification token");
    assert(register.json.user.emailVerified === false && register.json.user.emailVerificationPending === true, "password signups should start with pending email verification");
    assert(sentVerificationEmails.length === 1, "register should send one verification email through Resend");
    const verificationCode = JSON.stringify(sentVerificationEmails[0]).match(/\b\d{6}\b/)?.[0];
    assert(verificationCode, "verification email should include a 6 digit code");
    const badVerificationCode = verificationCode === "000000" ? "999999" : "000000";
    const rejectedVerification = await call("verifyEmail", { code: badVerificationCode, verificationToken: register.json.verificationToken });
    assert(rejectedVerification.code === 400, "wrong email verification codes should be rejected");
    const resendReadyDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const resendReadyUser = resendReadyDb.users.find((item) => item.id === register.json.user.id);
    resendReadyUser.emailVerification.createdAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await fs.writeFile(dbPath, JSON.stringify(resendReadyDb));
    await fs.writeFile(backupPath, JSON.stringify(resendReadyDb));
    const resentVerification = await call("resendEmailVerification", { verificationToken: register.json.verificationToken });
    assert(resentVerification.code === 200 && resentVerification.json.verificationToken && sentVerificationEmails.length === 2, "pending signup should resend verification email without a logged-in session");
    const resentVerificationCode = JSON.stringify(sentVerificationEmails[1]).match(/\b\d{6}\b/)?.[0];
    assert(resentVerificationCode, "resent verification email should include a 6 digit code");
    const acceptedVerification = await call("verifyEmail", { code: resentVerificationCode, verificationToken: resentVerification.json.verificationToken });
    assert(acceptedVerification.code === 200 && acceptedVerification.json.user?.emailVerified === true && acceptedVerification.json.token, "emailed verification code should verify the account and return a session");
    const verifiedToken = acceptedVerification.json.token;
    const staleVerificationDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const staleVerificationUser = staleVerificationDb.users.find((item) => item.id === acceptedVerification.json.user.id);
    staleVerificationUser.emailVerified = false;
    staleVerificationUser.emailVerifiedAt = "";
    staleVerificationUser.emailVerification = { codeHash: "stale", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), attempts: 0 };
    await fs.writeFile(dbPath, JSON.stringify(staleVerificationDb));
    await fs.writeFile(backupPath, JSON.stringify(staleVerificationDb));
    const verifiedSessionState = await call("state", {}, verifiedToken, "GET");
    assert(verifiedSessionState.code === 200 && verifiedSessionState.json.user?.emailVerified === true, "verified session token should hide stale dashboard verification prompts");
    const repairedVerificationDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const repairedVerificationUser = repairedVerificationDb.users.find((item) => item.id === acceptedVerification.json.user.id);
    assert(repairedVerificationUser?.emailVerified === true && !repairedVerificationUser.emailVerification, "verified session state should repair stale stored verification status");
    const restoredSignup = await call("register", {
      username: `Restore${suffix}`,
      email: `restore${suffix}@example.com`,
      password: "secret123",
      termsAccepted: true
    });
    const restoredSignupCode = JSON.stringify(sentVerificationEmails[sentVerificationEmails.length - 1] || {}).match(/\b\d{6}\b/)?.[0];
    assert(restoredSignup.code === 200 && restoredSignupCode, "restore signup fixture should receive a verification code");
    const hiddenPendingDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    hiddenPendingDb.users = hiddenPendingDb.users.filter((item) => item.id !== restoredSignup.json.user.id);
    await fs.writeFile(dbPath, JSON.stringify(hiddenPendingDb));
    await fs.writeFile(backupPath, JSON.stringify(hiddenPendingDb));
    const restoredVerification = await call("verifyEmail", { code: restoredSignupCode, verificationToken: restoredSignup.json.verificationToken });
    assert(restoredVerification.code === 200 && restoredVerification.json.user?.emailVerified === true && restoredVerification.json.token, "email verification should restore a pending signup when storage reads stale");
    global.fetch = previousResendFetch;
    if (previousResendApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendApiKey;
    if (previousResendFromEmail === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = previousResendFromEmail;
    if (previousResendReplyTo === undefined) delete process.env.RESEND_REPLY_TO;
    else process.env.RESEND_REPLY_TO = previousResendReplyTo;

    const registeredDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const registeredUser = registeredDb.users.find((item) => item.id === register.json.user.id);
    assert(registeredUser, "registered user should be stored");
    const staleRegisteredDb = { ...registeredDb, users: registeredDb.users.filter((item) => item.id !== registeredUser.id) };
    await fs.writeFile(dbPath, JSON.stringify(staleRegisteredDb));
    await fs.writeFile(backupPath, JSON.stringify(staleRegisteredDb));
    const staleSessionState = await call("state", {}, verifiedToken, "GET");
    assert(staleSessionState.code === 200 && staleSessionState.json.user?.id === registeredUser.id, "fresh signup session should survive a stale user read");
    const staleSessionSave = await call(
      "saveServer",
      {
        server: {
          name: "Fresh Session SMP",
          edition: "java",
          javaHost: "fresh-session.example.org",
          javaPort: 25565,
          country: "United States",
          description: "A fresh signup listing created while the stored user record is temporarily stale, proving new accounts can still save a server before GitHub read-after-write catches up. This protects the real dashboard flow where a user signs up, immediately submits a server, and expects the saved listing to appear without waiting for remote JSON propagation.",
          tags: ["SMP"]
        }
      },
      verifiedToken
    );
    assert(staleSessionSave.code === 200 && staleSessionSave.json.server.ownerId === registeredUser.id, "fresh signup session should create listings during a stale user read");
    const afterStaleSessionSave = JSON.parse(await fs.readFile(dbPath, "utf8"));
    if (!afterStaleSessionSave.users.some((item) => item.id === registeredUser.id)) afterStaleSessionSave.users.push(registeredUser);
    await fs.writeFile(dbPath, JSON.stringify(afterStaleSessionSave));

    const githubSyncEnv = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GITHUB_REPO: process.env.GITHUB_REPO,
      GITHUB_BRANCH: process.env.GITHUB_BRANCH,
      GITHUB_DB_PATH: process.env.GITHUB_DB_PATH,
      GITHUB_DB_BACKUP_PATH: process.env.GITHUB_DB_BACKUP_PATH
    };
    const githubSyncFetch = global.fetch;
    const githubSyncMainPath = `data/smoke-sync-${suffix}.json`;
    const githubSyncBackupPath = `data/smoke-sync-${suffix}.backup.json`;
    process.env.GITHUB_TOKEN = "smoke-sync-github-token";
    process.env.GITHUB_REPO = "SmokeOwner/SmokeRepo";
    process.env.GITHUB_BRANCH = "main";
    process.env.GITHUB_DB_PATH = githubSyncMainPath;
    process.env.GITHUB_DB_BACKUP_PATH = githubSyncBackupPath;
    const githubSyncPublicStatePath = "data/public-state.json";
    const githubSyncAdminUser = { ...registeredUser, username: "ItzKuroYT" };
    const githubSyncInitialDb = {
      version: 2,
      users: [githubSyncAdminUser],
      servers: [
        {
          id: `github-refresh-${suffix}`,
          ownerId: githubSyncAdminUser.id,
          ownerName: githubSyncAdminUser.username,
          name: `GitHub Refresh Fixture ${suffix}`,
          javaHost: `github-refresh-${suffix}.example.org`,
          javaPort: 25565,
          country: "United States",
          description: "An older listing that needs a ping refresh so a later state read performs a shared storage write while GitHub is still serving a stale database snapshot.",
          tags: ["SMP"],
          lastPingAt: "",
          votes: 0
        }
      ],
      clients: [],
      hosts: [],
      votes: [],
      voteIps: {},
      deleted: { users: {}, servers: {}, clients: {}, hosts: {} }
    };
    const githubSyncFiles = new Map([[githubSyncMainPath, Buffer.from(JSON.stringify(githubSyncInitialDb)).toString("base64")]]);
    const githubSyncShas = new Map([[githubSyncMainPath, "sync-sha-0"]]);
    const githubSyncStaleReads = new Map();
    const githubSyncStaleContents = new Map();
    const githubSyncPathFromUrl = (url) => {
      const pathname = new URL(String(url)).pathname;
      const marker = "/contents/";
      return decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
    };
    global.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href.includes("api.github.com/repos/SmokeOwner/SmokeRepo/contents/")) {
        const filePath = githubSyncPathFromUrl(url);
        if (options.method === "PUT") {
          const body = JSON.parse(options.body || "{}");
          githubSyncFiles.set(filePath, body.content);
          githubSyncShas.set(filePath, `sync-sha-${githubSyncShas.size}-${Date.now()}`);
          return { ok: true, status: 200, json: async () => ({ content: { sha: githubSyncShas.get(filePath) } }) };
        }
        const shouldServeStale = Number(githubSyncStaleReads.get(filePath) || 0) > 0;
        if (shouldServeStale) githubSyncStaleReads.set(filePath, Number(githubSyncStaleReads.get(filePath)) - 1);
        const content = shouldServeStale ? githubSyncStaleContents.get(filePath) : githubSyncFiles.get(filePath);
        if (!content) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ content, sha: githubSyncShas.get(filePath) || "sync-sha-0" }) };
      }
      return githubSyncFetch(url, options);
    };
    const githubSaved = await call(
      "saveServer",
      {
        server: {
          name: `GitHub Sync New SMP ${suffix}`,
          javaHost: `github-sync-new-${suffix}.example.org`,
          javaPort: 25565,
          country: "United States",
          description: "A listing saved to the fake GitHub database, then protected through a stale read and a later ping-refresh write. This reproduces the production bug where a server appears briefly across browsers and then disappears after the next API save.",
          tags: ["SMP", "Survival"]
        }
      },
      verifiedToken
    );
    assert(githubSaved.code === 200 && githubSaved.json.server.id, "GitHub-backed server save should succeed");
    assert(githubSyncFiles.has(githubSyncBackupPath), "GitHub-backed save should write a backup snapshot");
    assert(githubSyncFiles.has(githubSyncPublicStatePath), "GitHub-backed server save should update the public listing snapshot");
    const githubPublicStateAfterSave = JSON.parse(Buffer.from(githubSyncFiles.get(githubSyncPublicStatePath), "base64").toString("utf8"));
    assert(githubPublicStateAfterSave.servers.some((item) => item.id === githubSaved.json.server.id), "public listing snapshot should include newly saved GitHub-backed servers");
    assert(!JSON.stringify(githubPublicStateAfterSave).includes("passwordHash"), "public listing snapshot should not include private user fields");
    const githubSponsor = await call("admin", { command: "toggleSponsor", value: { id: githubSaved.json.server.id } }, verifiedToken);
    assert(githubSponsor.code === 200 && githubSponsor.json.servers.find((item) => item.id === githubSaved.json.server.id)?.sponsored === true, "GitHub-backed admin sponsor toggles should succeed");
    const githubPublicStateAfterSponsor = JSON.parse(Buffer.from(githubSyncFiles.get(githubSyncPublicStatePath), "base64").toString("utf8"));
    assert(githubPublicStateAfterSponsor.servers.find((item) => item.id === githubSaved.json.server.id)?.sponsored === true, "admin sponsor toggles should update the public listing snapshot");
    githubSyncFiles.delete(githubSyncBackupPath);
    githubSyncShas.delete(githubSyncBackupPath);
    githubSyncStaleContents.set(githubSyncMainPath, Buffer.from(JSON.stringify(githubSyncInitialDb)).toString("base64"));
    githubSyncStaleReads.set(githubSyncMainPath, 2);
    const githubStaleVote = await call("vote", {
      serverId: githubSaved.json.server.id,
      minecraftUsername: `Gh_${String(suffix).slice(-6)}`
    }, "", "POST", {
      "x-forwarded-for": "198.51.100.77",
      "user-agent": "IconListingGithubStaleVoteSmoke"
    });
    assert(githubStaleVote.code === 200, "voting for a newly saved GitHub listing should survive stale GitHub reads");
    const githubStoredAfterStaleVote = JSON.parse(Buffer.from(githubSyncFiles.get(githubSyncMainPath), "base64").toString("utf8"));
    assert(githubStoredAfterStaleVote.servers.some((item) => item.id === githubSaved.json.server.id), "stale GitHub vote writes must not erase the voted listing");
    assert(githubStoredAfterStaleVote.votes.some((item) => item.serverId === githubSaved.json.server.id), "stale GitHub vote writes must keep the vote row");
    githubSyncStaleContents.set(githubSyncMainPath, Buffer.from(JSON.stringify(githubSyncInitialDb)).toString("base64"));
    githubSyncStaleReads.set(githubSyncMainPath, 2);
    const githubStaleState = await call("state", {}, "", "GET");
    assert(githubStaleState.code === 200, "state should survive a stale GitHub read after a listing save");
    const githubStoredAfterStaleWrite = JSON.parse(Buffer.from(githubSyncFiles.get(githubSyncMainPath), "base64").toString("utf8"));
    assert(githubStoredAfterStaleWrite.servers.some((item) => item.id === githubSaved.json.server.id), "later API writes must not erase cache-only listings when GitHub serves stale JSON");
    global.fetch = githubSyncFetch;
    for (const [key, value] of Object.entries(githubSyncEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    const login = await call("login", {
      login: `smoke${suffix}@example.com`,
      password: "secret123"
    });
    assert(login.code === 200 && login.json.user.username.startsWith("Smoke"), "login should return the user");
    const planReadyDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const planReadyUser = planReadyDb.users.find((item) => item.id === login.json.user.id);
    assert(planReadyUser, "smoke user should exist before plan fixture update");
    planReadyUser.plan = "iconic";
    await fs.writeFile(dbPath, JSON.stringify(planReadyDb));
    await fs.writeFile(backupPath, JSON.stringify(planReadyDb));

    const storageHealth = await call("health", {}, "", "GET", { host: "icon-listing.vercel.app" });
    assert(storageHealth.code === 200 && storageHealth.json.durable === false, "health should report missing durable storage in local smoke");
    const fakeProductionWrite = await call("saveServer", { server: { name: "Should Not Save", javaHost: "no-storage.example.org", country: "United States", description: "This listing should be rejected in a production-like request when GitHub storage is not configured, preventing Vercel temporary storage from pretending the listing was saved across browsers.", tags: ["SMP"] } }, login.json.token, "POST", { host: "icon-listing.vercel.app" });
    assert(fakeProductionWrite.code === 500, "production-like writes without GitHub storage should fail instead of saving locally");

    let throttledLogin = null;
    for (let index = 0; index < 9; index += 1) {
      throttledLogin = await call("login", {
        login: `smoke${suffix}@example.com`,
        password: "wrong-password"
      });
    }
    assert(throttledLogin.code === 429, "repeated bad logins should be rate limited");

    const badListing = await call(
      "saveServer",
      {
        server: {
          name: "shit server",
          javaHost: "example.org",
          country: "United States",
          description: "A".repeat(220),
          tags: ["SMP"]
        }
      },
      login.json.token
    );
    assert(badListing.code === 400, "blocked words should reject a listing");

    const blockedHostListing = await call(
      "saveServer",
      {
        server: {
          name: "Blocked Host SMP",
          javaHost: "example.aternos.me",
          country: "United States",
          description: "A".repeat(220),
          tags: ["SMP"]
        }
      },
      login.json.token
    );
    assert(blockedHostListing.code === 400, "FalixSrv and Aternos hosts should be rejected");

    const description =
      "A real listing created by the smoke test to verify account login, listing creation, mcstatus fallback, Votifier forwarding, vote recording, and monthly vote totals without using premade seed content.\nLine two should keep its line break.\n\nLine four should still be separated after saving.";
    const discordNotifications = [];
    const previousDiscordWebhook = process.env["discord-webhook"];
    const previousDiscordWebhookUpper = process.env.DISCORD_WEBHOOK;
    const previousDiscordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    const previousDiscordFetch = global.fetch;
    process.env["discord-webhook"] = "https://discord.example/webhook";
    global.fetch = async (url, options = {}) => {
      if (String(url) === "https://discord.example/webhook") {
        discordNotifications.push(JSON.parse(options.body || "{}"));
        return { ok: true, status: 204, text: async () => "" };
      }
      return previousDiscordFetch(url, options);
    };
    const saved = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Test SMP",
          javaHost: "example.org",
          javaPort: 25565,
          country: "United States",
          description,
          tags: ["SMP", "Survival"],
          votifierEnabled: true,
          votifierHost: "127.0.0.1",
          votifierPort: 8192,
          votifierToken: "token",
          iconListingPluginEnabled: true,
          iconListingVoteKey: `smoke-key-${suffix}`
        }
      },
      login.json.token
    );
    global.fetch = previousDiscordFetch;
    if (previousDiscordWebhook === undefined) delete process.env["discord-webhook"];
    else process.env["discord-webhook"] = previousDiscordWebhook;
    if (previousDiscordWebhookUpper === undefined) delete process.env.DISCORD_WEBHOOK;
    else process.env.DISCORD_WEBHOOK = previousDiscordWebhookUpper;
    if (previousDiscordWebhookUrl === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = previousDiscordWebhookUrl;
    assert(saved.code === 200 && saved.json.server.id, "server save should succeed");
    assert(saved.json.server.iconListingVoteKey === `smoke-key-${suffix}`, "server owner should receive the IconListing vote plugin key");
    assert(discordNotifications.length === 1, "new server saves should send one Discord webhook notification");
    assert(discordNotifications[0].content.includes("View Smoke Test SMP on iconlisting"), "Discord webhook should include the server name");
    assert(discordNotifications[0].content.includes(`/server/${serverSlug(saved.json.server.name)}`), "Discord webhook should include the server slug URL");

    const duplicateName = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Test SMP",
          javaHost: "name-dupe.example.org",
          javaPort: 25565,
          country: "United States",
          description: "This smoke listing has a new address and a new description, but it reuses the server name so the duplicate-name protection should reject it.".repeat(2),
          tags: ["SMP", "Survival"]
        }
      },
      login.json.token
    );
    assert(duplicateName.code === 409, "duplicate server names should be rejected");

    const duplicateIp = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Test Duplicate IP",
          javaHost: "example.org",
          javaPort: 25565,
          country: "United States",
          description: "This smoke listing has a different name and different words, but it reuses the same server address so duplicate IP protection should reject it.".repeat(2),
          tags: ["SMP", "Survival"]
        }
      },
      login.json.token
    );
    assert(duplicateIp.code === 409, "duplicate server IPs should be rejected");

    const duplicateDescription = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Test Duplicate Description",
          javaHost: "description-dupe.example.org",
          javaPort: 25565,
          country: "United States",
          description,
          tags: ["SMP", "Survival"]
        }
      },
      login.json.token
    );
    assert(duplicateDescription.code === 409, "duplicate descriptions should be rejected");

    const duplicateVoteKey = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Test Duplicate Vote Key",
          javaHost: "vote-key-dupe.example.org",
          javaPort: 25565,
          country: "United States",
          description: "This smoke listing has unique public fields, but it reuses the IconListing vote plugin key so duplicate key protection should reject it before a plugin can claim another server's votes. The extra sentence keeps this fixture above the listing description length requirement.",
          tags: ["SMP", "Survival"],
          iconListingPluginEnabled: true,
          iconListingVoteKey: `smoke-key-${suffix}`
        }
      },
      login.json.token
    );
    assert(duplicateVoteKey.code === 409, "duplicate IconListing vote plugin keys should be rejected");

    const secondServer = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Test Network",
          javaHost: "network.example.org",
          javaPort: 25565,
          country: "United States",
          description: "A second unique listing from the same account to verify users can own multiple server listings as long as the name, address, and description are not duplicates. This should stay saved beside the first listing without replacing it.",
          tags: ["SMP", "Survival"]
        }
      },
      login.json.token
    );
    assert(secondServer.code === 200 && secondServer.json.server.id !== saved.json.server.id, "same account should save multiple unique servers");

    const bedrockServer = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Bedrock Server",
          edition: "bedrock",
          bedrockType: "server",
          bedrockHost: "bedrock.example.org",
          bedrockPort: 19132,
          country: "United States",
          description: "A Bedrock-only smoke listing that uses a Bedrock server address instead of a Java host. This verifies Bedrock servers can be listed, saved, pinged through the Bedrock status path, and shown beside Java listings without requiring Java fields.",
          tags: ["Bedrock", "Survival"]
        }
      },
      login.json.token
    );
    assert(bedrockServer.code === 200 && bedrockServer.json.server.edition === "bedrock", "bedrock server listings should save without Java host");

    const bedrockRealm = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Bedrock Realm",
          edition: "bedrock",
          bedrockType: "realm",
          realmCode: "abc123Realm",
          country: "United States",
          description: "A Bedrock Realm smoke listing that uses a realm code instead of a server IP. This verifies realm codes can be stored, displayed, copied, and kept separate from normal Bedrock server address listings safely.",
          tags: ["Bedrock", "SMP"]
        }
      },
      login.json.token
    );
    assert(bedrockRealm.code === 200 && bedrockRealm.json.server.bedrockType === "realm", "bedrock realm listings should save with a realm code");

    const testVote = await call(
      "testVote",
      { host: "127.0.0.1", port: 8192, token: "token" },
      login.json.token
    );
    assert(testVote.code === 200, "test vote should call the configured Votifier provider");

    const directToken = `direct-token-${suffix}`;
    const directReceived = [];
    let resolveDirectReceived;
    const directReceivedReady = new Promise((resolve) => {
      resolveDirectReceived = resolve;
    });
    const directVotifier = net.createServer((socket) => {
      socket.write("VOTIFIER 2 smoke-challenge\n");
      socket.on("data", (chunk) => {
        const frame = parseNuVotifierFrame(chunk);
        const signature = crypto.createHmac("sha256", directToken).update(frame.message.payload).digest("base64");
        directReceived.push({
          packetBytes: frame.packetBytes,
          frameMagic: frame.magic,
          frameLength: frame.length,
          payloadIsJson: frame.payloadIsJson,
          signatureValid: signature === frame.message.signature,
          payload: frame.payload
        });
        resolveDirectReceived();
        socket.end();
      });
    });
    tcpServers.push(directVotifier);
    await new Promise((resolve) => directVotifier.listen(0, "127.0.0.1", resolve));
    const providerEndpoint = CONFIG.votifier.providerEndpoint;
    CONFIG.votifier.providerEndpoint = "";
    const directVotifierTest = await call("votifierToolTest", {
      type: "auto",
      host: "127.0.0.1",
      port: directVotifier.address().port,
      token: directToken,
      minecraftUsername: "DirectTest"
    });
    CONFIG.votifier.providerEndpoint = providerEndpoint;
    assert(directVotifierTest.code === 200 && directVotifierTest.json.protocol === "nuvotifier", "auto-detected NuVotifier testing should send through the API without a provider endpoint");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("direct NuVotifier listener did not receive a packet")), 1000);
      directReceivedReady.then(() => {
        clearTimeout(timeout);
        resolve();
      }, reject);
    });
    assert(directReceived.length === 1 && directReceived[0].signatureValid, "direct NuVotifier payload should be HMAC signed with the token");
    assert(directReceived[0].payloadIsJson && directReceived[0].frameMagic === 0x733A && directReceived[0].packetBytes === directReceived[0].frameLength + 4, "direct NuVotifier payload should use the v2 binary frame header");
    assert(directReceived[0].payload.challenge === "smoke-challenge" && directReceived[0].payload.username === "DirectTest", "direct NuVotifier payload should include challenge and username");
    assert(typeof directReceived[0].payload.timestamp === "number", "direct NuVotifier payload should send timestamp as a number");

    const azuToken = `azu-token-${suffix}`;
    const azuReceived = [];
    let resolveAzuReceived;
    const azuReceivedReady = new Promise((resolve) => {
      resolveAzuReceived = resolve;
    });
    const azuVotifier = net.createServer((socket) => {
      socket.write("VOTIFIER 2 azu-challenge\n");
      socket.on("data", (chunk) => {
        const frame = parseNuVotifierFrame(chunk);
        const signature = crypto.createHmac("sha256", azuToken).update(frame.message.payload).digest("base64");
        azuReceived.push({
          frameMagic: frame.magic,
          signatureValid: signature === frame.message.signature,
          payload: frame.payload
        });
        resolveAzuReceived();
        socket.end();
      });
    });
    tcpServers.push(azuVotifier);
    await new Promise((resolve) => azuVotifier.listen(0, "127.0.0.1", resolve));
    CONFIG.votifier.providerEndpoint = "";
    const azuVotifierTest = await call("votifierToolTest", {
      type: "azuvotifier",
      host: "127.0.0.1",
      port: azuVotifier.address().port,
      token: azuToken,
      minecraftUsername: "AzuTest"
    });
    CONFIG.votifier.providerEndpoint = providerEndpoint;
    assert(azuVotifierTest.code === 200 && azuVotifierTest.json.protocol === "nuvotifier", "AzuVotifier testing should route through the NuVotifier v2 token sender");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("AzuVotifier listener did not receive a packet")), 1000);
      azuReceivedReady.then(() => {
        clearTimeout(timeout);
        resolve();
      }, reject);
    });
    assert(azuReceived.length === 1 && azuReceived[0].frameMagic === 0x733A && azuReceived[0].signatureValid, "AzuVotifier payload should be a signed NuVotifier v2 frame");
    assert(azuReceived[0].payload.challenge === "azu-challenge" && azuReceived[0].payload.username === "AzuTest", "AzuVotifier payload should include challenge and username");

    const directVoteNuToken = `direct-vote-nu-${suffix}`;
    const directVoteNuReceived = [];
    let resolveDirectVoteNuReceived;
    const directVoteNuReady = new Promise((resolve) => {
      resolveDirectVoteNuReceived = resolve;
    });
    const directVoteNuVotifier = createNuVotifierFrameServer({
      token: directVoteNuToken,
      challenge: "direct-vote-nu-challenge",
      received: directVoteNuReceived,
      resolve: resolveDirectVoteNuReceived
    });
    tcpServers.push(directVoteNuVotifier);
    await new Promise((resolve) => directVoteNuVotifier.listen(0, "127.0.0.1", resolve));
    const directVoteNuServer = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Direct NuVotifier Vote",
          javaHost: "direct-nu.example.org",
          javaPort: 25565,
          country: "United States",
          description: "A direct NuVotifier smoke listing that verifies the actual public vote endpoint can deliver a v2 token vote to the configured listener without using the external relay provider. The description is intentionally long enough to pass listing validation while keeping the test focused on reward delivery.",
          tags: ["SMP", "Survival"],
          votifierEnabled: true,
          votifierType: "nuvotifier",
          votifierHost: "127.0.0.1",
          votifierPort: directVoteNuVotifier.address().port,
          votifierToken: directVoteNuToken
        }
      },
      login.json.token
    );
    assert(directVoteNuServer.code === 200 && directVoteNuServer.json.server.votifierType === "nuvotifier", "NuVotifier listing should save its listener type");
    CONFIG.votifier.providerEndpoint = "";
    const directVoteNu = await call("vote", {
      serverId: directVoteNuServer.json.server.id,
      minecraftUsername: `Nu_${String(suffix).slice(-4)}`
    });
    CONFIG.votifier.providerEndpoint = providerEndpoint;
    assert(directVoteNu.code === 200 && directVoteNu.json.deliveries.votifier === "sent", "actual NuVotifier vote should be delivered directly");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("actual NuVotifier vote listener did not receive a packet")), 1000);
      directVoteNuReady.then(() => {
        clearTimeout(timeout);
        resolve();
      }, reject);
    });
    assert(directVoteNuReceived.length === 1 && directVoteNuReceived[0].signatureValid && directVoteNuReceived[0].frameMagic === 0x733A, "actual NuVotifier vote should send a signed v2 frame");

    const directVoteAzuToken = `direct-vote-azu-${suffix}`;
    const directVoteAzuReceived = [];
    let resolveDirectVoteAzuReceived;
    const directVoteAzuReady = new Promise((resolve) => {
      resolveDirectVoteAzuReceived = resolve;
    });
    const directVoteAzuVotifier = createNuVotifierFrameServer({
      token: directVoteAzuToken,
      challenge: "direct-vote-azu-challenge",
      received: directVoteAzuReceived,
      resolve: resolveDirectVoteAzuReceived
    });
    tcpServers.push(directVoteAzuVotifier);
    await new Promise((resolve) => directVoteAzuVotifier.listen(0, "127.0.0.1", resolve));
    const directVoteAzuServer = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Direct AzuVotifier Vote",
          javaHost: "direct-azu.example.org",
          javaPort: 25565,
          country: "United States",
          description: "A direct AzuVotifier smoke listing that verifies the actual public vote endpoint can deliver a v2 token vote to an AzuVotifier-compatible listener without using the relay provider. The description is intentionally long enough to pass listing validation while keeping the test focused on reward delivery.",
          tags: ["SMP", "Survival"],
          votifierEnabled: true,
          votifierType: "azuvotifier",
          votifierHost: "127.0.0.1",
          votifierPort: directVoteAzuVotifier.address().port,
          votifierToken: directVoteAzuToken
        }
      },
      login.json.token
    );
    assert(directVoteAzuServer.code === 200 && directVoteAzuServer.json.server.votifierType === "azuvotifier", "AzuVotifier listing should save its listener type");
    CONFIG.votifier.providerEndpoint = "";
    const directVoteAzu = await call("vote", {
      serverId: directVoteAzuServer.json.server.id,
      minecraftUsername: `Azu_${String(suffix).slice(-4)}`
    });
    CONFIG.votifier.providerEndpoint = providerEndpoint;
    assert(directVoteAzu.code === 200 && directVoteAzu.json.deliveries.votifier === "sent", "actual AzuVotifier vote should be delivered directly");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("actual AzuVotifier vote listener did not receive a packet")), 1000);
      directVoteAzuReady.then(() => {
        clearTimeout(timeout);
        resolve();
      }, reject);
    });
    assert(directVoteAzuReceived.length === 1 && directVoteAzuReceived[0].signatureValid && directVoteAzuReceived[0].frameMagic === 0x733A, "actual AzuVotifier vote should send a signed v2 frame");

    const legacyKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const legacyReceived = [];
    let resolveLegacyReceived;
    const legacyReceivedReady = new Promise((resolve) => {
      resolveLegacyReceived = resolve;
    });
    const legacyVotifier = net.createServer((socket) => {
      socket.write("VOTIFIER 1\n");
      socket.on("data", (chunk) => {
        legacyReceived.push(
          {
            packetBytes: chunk.length,
            body: crypto.privateDecrypt(
              {
                key: legacyKeys.privateKey,
                padding: crypto.constants.RSA_PKCS1_PADDING
              },
              chunk
            ).toString("utf8")
          }
        );
        resolveLegacyReceived();
        socket.end();
      });
    });
    tcpServers.push(legacyVotifier);
    await new Promise((resolve) => legacyVotifier.listen(0, "127.0.0.1", resolve));
    CONFIG.votifier.providerEndpoint = "";
    const legacyVotifierTest = await call("votifierToolTest", {
      type: "votifier",
      host: "127.0.0.1",
      port: legacyVotifier.address().port,
      token: legacyKeys.publicKey.export({ type: "spki", format: "pem" }),
      minecraftUsername: "LegacyTest"
    });
    CONFIG.votifier.providerEndpoint = providerEndpoint;
    assert(legacyVotifierTest.code === 200, "direct legacy Votifier testing should send through the API without a provider endpoint");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("legacy Votifier listener did not receive a packet")), 1000);
      legacyReceivedReady.then(() => {
        clearTimeout(timeout);
        resolve();
      }, reject);
    });
    assert(legacyReceived.length === 1 && legacyReceived[0].packetBytes === 256 && legacyReceived[0].body.includes("LegacyTest"), "direct legacy Votifier payload should be a 256-byte encrypted packet with the public key");

    const autoKeyReceived = [];
    let resolveAutoKeyReceived;
    const autoKeyReceivedReady = new Promise((resolve) => {
      resolveAutoKeyReceived = resolve;
    });
    const autoKeyVotifier = net.createServer((socket) => {
      socket.write("VOTIFIER 2 auto-key-challenge\n");
      socket.on("data", (chunk) => {
        autoKeyReceived.push({
          packetBytes: chunk.length,
          firstByte: chunk[0],
          body: crypto.privateDecrypt(
            {
              key: legacyKeys.privateKey,
              padding: crypto.constants.RSA_PKCS1_PADDING
            },
            chunk
          ).toString("utf8")
        });
        resolveAutoKeyReceived();
        socket.end();
      });
    });
    tcpServers.push(autoKeyVotifier);
    await new Promise((resolve) => autoKeyVotifier.listen(0, "127.0.0.1", resolve));
    CONFIG.votifier.providerEndpoint = "";
    const autoKeyVotifierTest = await call("votifierToolTest", {
      type: "auto",
      host: "127.0.0.1",
      port: autoKeyVotifier.address().port,
      token: legacyKeys.publicKey.export({ type: "spki", format: "pem" }),
      minecraftUsername: "AutoKeyTest"
    });
    const forcedNuWithPublicKey = await call("votifierToolTest", {
      type: "nuvotifier",
      host: "127.0.0.1",
      port: autoKeyVotifier.address().port,
      token: legacyKeys.publicKey.export({ type: "spki", format: "pem" }),
      minecraftUsername: "BadKeyTest"
    });
    CONFIG.votifier.providerEndpoint = providerEndpoint;
    assert(autoKeyVotifierTest.code === 200 && autoKeyVotifierTest.json.protocol === "votifier", "auto-detect should use classic Votifier when a public key is pasted");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("auto public-key Votifier listener did not receive a packet")), 1000);
      autoKeyReceivedReady.then(() => {
        clearTimeout(timeout);
        resolve();
      }, reject);
    });
    assert(autoKeyReceived.length === 1 && autoKeyReceived[0].packetBytes === 256 && autoKeyReceived[0].firstByte !== 123 && autoKeyReceived[0].body.includes("AutoKeyTest"), "auto public-key mode should send a 256-byte RSA packet instead of JSON");
    assert(forcedNuWithPublicKey.code === 400, "forced NuVotifier mode should reject public keys before sending a JSON packet");

    const vote = await call("vote", {
      serverId: saved.json.server.id,
      minecraftUsername: `Alex_${String(suffix).slice(-4)}`
    });
    assert(vote.code === 200, "vote should be accepted");
    assert(received.length === 2, "Votifier provider should receive test vote and real vote");

    const pluginPoll = await call("pluginPoll", { key: `smoke-key-${suffix}` });
    assert(pluginPoll.code === 200 && pluginPoll.json.votes.length === 1, "IconListing vote plugin should receive queued votes");
    assert(pluginPoll.json.votes[0].minecraftUsername === `Alex_${String(suffix).slice(-4)}`, "IconListing plugin vote should include the Minecraft username");
    const pluginAck = await call("pluginPoll", { key: `smoke-key-${suffix}`, ackIds: [pluginPoll.json.votes[0].id] });
    assert(pluginAck.code === 200 && pluginAck.json.votes.length === 0, "IconListing vote plugin should acknowledge delivered votes");

    const pluginTest = await call(
      "testPluginVote",
      { serverId: saved.json.server.id, minecraftUsername: `Test_${String(suffix).slice(-4)}` },
      login.json.token
    );
    assert(pluginTest.code === 200, "server owner should be able to queue an IconListing plugin test vote");
    const pluginTestPoll = await call("pluginPoll", { key: `smoke-key-${suffix}` });
    assert(pluginTestPoll.code === 200 && pluginTestPoll.json.votes.length === 1, "IconListing plugin should receive queued test votes");
    assert(pluginTestPoll.json.votes[0].minecraftUsername === `Test_${String(suffix).slice(-4)}`, "IconListing plugin test vote should include the Minecraft username");
    await call("pluginPoll", { key: `smoke-key-${suffix}`, ackIds: [pluginTestPoll.json.votes[0].id] });

    const repeatVote = await call("vote", {
      serverId: saved.json.server.id,
      minecraftUsername: `Alex_${String(suffix).slice(-4)}`
    });
    assert(repeatVote.code === 429, "repeat vote should be blocked for 24 hours");
    assert(received.length === 2, "blocked repeat vote should not call the Votifier provider");

    const cooldownDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const oldVoteAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    for (const key of Object.keys(cooldownDb.voteIps?.[saved.json.server.id] || {})) {
      cooldownDb.voteIps[saved.json.server.id][key] = oldVoteAt;
    }
    await fs.writeFile(dbPath, JSON.stringify(cooldownDb));
    const nextDayVote = await call("vote", {
      serverId: saved.json.server.id,
      minecraftUsername: `Alex_${String(suffix).slice(-4)}`
    });
    assert(nextDayVote.code === 200, "same player should be able to vote again after 24 hours");
    assert(received.length === 3, "next-day vote should call the Votifier provider");

    const failingDeliveryServer = await call(
      "saveServer",
      {
        server: {
          name: "Smoke Failing Votifier",
          javaHost: "failing-votifier.example.org",
          javaPort: 25565,
          country: "United States",
          description: "This smoke listing verifies the website still counts a vote even when a Votifier delivery provider rejects the reward delivery. The vote should be stored, cooldown should be recorded, and the API should return success.",
          tags: ["SMP", "Survival"],
          votifierEnabled: true,
          votifierHost: "127.0.0.1",
          votifierPort: 8192,
          votifierToken: "token"
        }
      },
      login.json.token
    );
    assert(failingDeliveryServer.code === 200, "failing delivery fixture should save");
    providerStatus = 500;
    const deliveryFailureVote = await call("vote", {
      serverId: failingDeliveryServer.json.server.id,
      minecraftUsername: `Fail_${String(suffix).slice(-4)}`
    });
    providerStatus = 200;
    assert(deliveryFailureVote.code === 200, "Votifier delivery failure should not block vote counting");
    assert(deliveryFailureVote.json.deliveries.votifier === "failed", "delivery status should report failed Votifier delivery");

    const copy = await call("trackCopy", { serverId: saved.json.server.id }, "", "POST", {
      "x-forwarded-for": "203.0.113.10",
      "user-agent": "IconListingSmoke"
    });
    assert(copy.code === 200 && copy.json.analytics.ipCopiesLast30 === 1, "IP copy analytics should count one unique copy");

    const adminSentEmails = [];
    const adminPreviousFetch = global.fetch;
    const adminPreviousResendApiKey = process.env.RESEND_API_KEY;
    const adminPreviousResendFromEmail = process.env.RESEND_FROM_EMAIL;
    process.env.RESEND_API_KEY = "smoke-resend-key";
    process.env.RESEND_FROM_EMAIL = "Icon Listing <verify@noreply.iconrealms.net>";
    global.fetch = async (url, options = {}) => {
      if (String(url).includes("api.resend.com/emails")) {
        adminSentEmails.push(JSON.parse(options.body || "{}"));
        return { ok: true, json: async () => ({ id: `admin-email-${suffix}` }), text: async () => "" };
      }
      return adminPreviousFetch(url, options);
    };
    const admin = await call("register", {
      username: "ItzKuroYT",
      email: `admin${suffix}@example.com`,
      password: "secret123",
      emailOptIn: true,
      termsAccepted: true
    });
    assert(admin.code === 200 && admin.json.user.admin && admin.json.pendingVerification, "configured admin should register as pending admin");
    const adminVerificationCode = JSON.stringify(adminSentEmails[0] || {}).match(/\b\d{6}\b/)?.[0];
    assert(adminVerificationCode, "admin verification email should include a code");
    const adminVerify = await call("verifyEmail", { code: adminVerificationCode, verificationToken: admin.json.verificationToken });
    assert(adminVerify.code === 200 && adminVerify.json.token, "admin email verification should return an admin session");
    const adminToken = adminVerify.json.token;
    global.fetch = adminPreviousFetch;
    if (adminPreviousResendApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = adminPreviousResendApiKey;
    if (adminPreviousResendFromEmail === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = adminPreviousResendFromEmail;

    const adminDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const adminUser = adminDb.users.find((item) => item.id === admin.json.user.id);
    const staleAdminDb = { ...adminDb, users: adminDb.users.filter((item) => item.id !== adminUser.id) };
    await fs.writeFile(dbPath, JSON.stringify(staleAdminDb));
    await fs.writeFile(backupPath, JSON.stringify(staleAdminDb));
    const staleAdmin = await call("admin", { command: "saveHost", value: { name: "Blocked Stale Admin", url: "https://example.com", description: "A stale snapshot admin attempt should not be able to save paid host listings because admin power must come from the stored account record." } }, adminToken);
    assert(staleAdmin.code === 403, "token snapshot fallback should not grant admin access");
    const restoredAdminDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    if (!restoredAdminDb.users.some((item) => item.id === adminUser.id)) restoredAdminDb.users.push(adminUser);
    await fs.writeFile(dbPath, JSON.stringify(restoredAdminDb));

    const beforeUserListRead = await fs.readFile(dbPath, "utf8");
    const adminUsers = await call("admin", { command: "listUsers" }, adminToken);
    const afterUserListRead = await fs.readFile(dbPath, "utf8");
    assert(adminUsers.code === 200 && adminUsers.json.users.some((item) => item.email === `smoke${suffix}@example.com`), "admin should be able to view created user emails through the API");
    assert(beforeUserListRead === afterUserListRead, "admin user email lookup should not write to shared storage");

    const clientDescription =
      "A sponsored client listing created by the smoke test to verify admins can save Minecraft client advertisements with a website download link, YouTube video, long description, two showcase images, version targeting, and paid/free metadata. This sentence keeps the description beyond the minimum length.";
    const clientSave = await call(
      "admin",
      {
        command: "saveClient",
        value: {
          name: "Smoke Client",
          url: "https://example.com/download",
          youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          description: clientDescription,
          images: ["https://example.com/one.png", "https://example.com/two.png"],
          version: "both",
          pricing: "paid"
        }
      },
      adminToken
    );
    assert(clientSave.code === 200 && clientSave.json.clients.length === 1, "admin should save a sponsored client");

    const hostDescription =
      "A sponsored Minecraft hosting listing created by the smoke test to verify admins can save paid host advertisements with a website link, optional YouTube video, three showcase images, and enough detail for server owners to compare the provider before clicking through.";
    const hostSave = await call(
      "admin",
      {
        command: "saveHost",
        value: {
          name: "Smoke Hosting",
          url: "https://example.com/minecraft-hosting",
          youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          description: hostDescription,
          images: ["https://example.com/host-one.png", "https://example.com/host-two.png", "https://example.com/host-three.png"]
        }
      },
      adminToken
    );
    assert(hostSave.code === 200 && hostSave.json.hosts.length === 1, "admin should save a sponsored host");

    const adminSponsor = await call("admin", { command: "toggleSponsor", value: { id: saved.json.server.id } }, adminToken);
    const sponsoredServer = adminSponsor.json.servers.find((item) => item.id === saved.json.server.id);
    assert(adminSponsor.code === 200 && sponsoredServer?.sponsored === true, "admin should be able to sponsor a server listing");
    const afterSponsorDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert(afterSponsorDb.servers.find((item) => item.id === saved.json.server.id)?.sponsored === true, "sponsored server flag should persist to storage");

    const adminDeleteFixture = await call(
      "saveServer",
      {
        server: {
          name: `Admin Delete SMP ${String(suffix).slice(-5)}`,
          javaHost: `admin-delete-${suffix}.example.org`,
          country: "United States",
          description: "A temporary server listing owned by a normal account so the admin deletion flow can prove cross-owner moderation deletes are marked as intentional storage changes and do not get blocked by protection.",
          tags: ["SMP"]
        }
      },
      login.json.token
    );
    assert(adminDeleteFixture.code === 200 && adminDeleteFixture.json.server.id, "admin delete fixture should save");
    const adminDelete = await call("deleteServer", { id: adminDeleteFixture.json.server.id }, adminToken);
    assert(adminDelete.code === 200, "admin should delete a server listing without storage protection blocking it");
    assert(!adminDelete.json.servers.some((item) => item.id === adminDeleteFixture.json.server.id), "admin delete response should omit the deleted listing");
    const afterAdminDeleteDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert(afterAdminDeleteDb.deleted?.servers?.[adminDeleteFixture.json.server.id], "admin-deleted listings should be tombstoned");

    const sitemap = await callRaw("sitemap");
    assert(sitemap.code === 200 && sitemap.headers["Content-Type"]?.includes("application/xml"), "sitemap should return XML");
    assert(sitemap.body.includes("https://minecraft-listing.iconrealms.net/"), "sitemap should include the canonical homepage");
    assert(sitemap.body.includes("https://minecraft-listing.iconrealms.net/sponsored-hosts/"), "sitemap should include sponsored hosts");
    const savedSlug = serverSlug(saved.json.server.name);
    assert(sitemap.body.includes(`/server/${savedSlug}`), "sitemap should include saved server listing slug URLs");
    assert(!sitemap.body.includes(`/server/?id=${saved.json.server.id}`), "sitemap should not use query-string server URLs");

    const serverPage = await callPath(`/server/${savedSlug}`);
    assert(serverPage.code === 200 && serverPage.headers["Content-Type"]?.includes("text/html"), "slug server page should return HTML");
    assert(serverPage.body.includes(`${saved.json.server.name} Minecraft Server`), "slug server page should include a server-specific title");
    assert(serverPage.body.includes(`<meta property="og:image"`), "slug server page should include share image metadata");
    assert(serverPage.body.includes("Server IP") && serverPage.body.includes(`Vote for ${saved.json.server.name}`), "slug server page should include real server details before JavaScript hydrates");

    const finalState = await call("state", {}, "", "GET");
    const server = finalState.json.servers.find((item) => item.id === saved.json.server.id);
    const otherServer = finalState.json.servers.find((item) => item.id === secondServer.json.server.id);
    const bedrockSaved = finalState.json.servers.find((item) => item.id === bedrockServer.json.server.id);
    const realmSaved = finalState.json.servers.find((item) => item.id === bedrockRealm.json.server.id);
    const client = finalState.json.clients.find((item) => item.name === "Smoke Client");
    const host = finalState.json.hosts.find((item) => item.name === "Smoke Hosting");
    assert(server && server.votes === 2, "server should have two counted votes after the next-day vote");
    assert(!server.iconListingVoteKey && !server.iconListingVoteQueue && !server.votifierToken, "public state should not expose private vote delivery keys or queues");
    assert(otherServer && otherServer.ownerId === server.ownerId, "same account should keep multiple unique listings");
    assert(bedrockSaved && bedrockSaved.edition === "bedrock" && bedrockSaved.bedrockHost === "bedrock.example.org", "bedrock server fields should be stored");
    assert(realmSaved && realmSaved.edition === "bedrock" && realmSaved.bedrockType === "realm" && realmSaved.realmCode === "abc123Realm", "bedrock realm fields should be stored");
    assert(server.description.includes("\nLine two") && server.description.includes("\n\nLine four"), "server description should preserve line breaks");
    assert(server.analytics.ipCopiesLast30 === 1, "server should expose public IP copy analytics");
    assert(!server.analytics.ipCopyDaily && !server.analytics.playerHistory, "list state should not include full analytics arrays");
    assert(client && client.images.length === 2 && client.version === "both" && client.pricing === "paid", "sponsored client fields should be stored");
    assert(host && host.images.length === 3 && host.pricing === "paid", "sponsored host fields should be stored");
    assert(finalState.json.votes.length === 0, "list state should not include raw vote records");

    const detailState = await call("state", { serverId: saved.json.server.id }, "", "GET");
    const detailServer = detailState.json.servers.find((item) => item.id === saved.json.server.id);
    assert(Array.isArray(detailServer.analytics.ipCopyDaily) && Array.isArray(detailServer.analytics.playerHistory), "detail state should include full analytics for the requested server");
    assert(detailState.json.votes.length === 2, "detail state should include current-month votes for only the requested server");
    const votePageState = await call("state", { server: saved.json.server.id }, "", "GET");
    assert(votePageState.json.votes.length === 2, "vote page state should accept the server query parameter used by vote links");
    const slugDetailState = await call("state", { serverSlug: savedSlug }, "", "GET");
    const slugDetailServer = slugDetailState.json.servers.find((item) => item.id === saved.json.server.id);
    assert(Array.isArray(slugDetailServer.analytics.ipCopyDaily), "detail state should accept server slugs for full analytics");

    const preCounterDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const preCounterServer = preCounterDb.servers.find((item) => item.id === saved.json.server.id);
    preCounterServer.votes = 7;
    preCounterDb.votes = preCounterDb.votes.filter((item) => item.serverId !== saved.json.server.id).slice(0, 1);
    await fs.writeFile(dbPath, JSON.stringify(preCounterDb));
    const counterState = await call("state", {}, "", "GET");
    const counterStateServer = counterState.json.servers.find((item) => item.id === saved.json.server.id);
    assert(counterStateServer.votes === 7, "state should not undercount when the stored vote counter is higher than vote records");
    const counterVote = await call("vote", { serverId: saved.json.server.id, minecraftUsername: `Cnt_${String(suffix).slice(-8)}` }, "", "POST", {
      "x-forwarded-for": "203.0.113.77",
      "user-agent": "IconListingCounterSmoke"
    });
    assert(counterVote.code === 200 && counterVote.json.server.votes === 8, "vote should increment from the stored counter when raw vote rows are incomplete");

    const backup = JSON.parse(await fs.readFile(backupPath, "utf8"));
    assert(Array.isArray(backup.servers) && backup.servers.length >= 5, "backup JSON should preserve server listings");
    await fs.writeFile(recoveryPath, JSON.stringify({ version: 2, users: [], servers: [{ ...saved.json.server, id: "recovery-server", name: "Recovery SMP", javaHost: "recovery.example.org", description: "Recovery server listing used to verify bundled JSON recovery merges into an incomplete API state without replacing existing listings." }], clients: [], votes: [], voteIps: {} }));
    const recoveredState = await call("state", {}, "", "GET");
    assert(recoveredState.json.servers.some((item) => item.id === "recovery-server"), "state should merge bundled recovery servers");

    await fs.writeFile(dbPath, JSON.stringify({ version: 2, users: [], servers: [], clients: [], hosts: [], votes: [], voteIps: {} }));
    const restoredFromBackup = await call("state", {}, "", "GET");
    assert(restoredFromBackup.json.servers.some((item) => item.id === saved.json.server.id), "backup JSON should refill accidental blank API state");
    assert(restoredFromBackup.json.clients.some((item) => item.name === "Smoke Client"), "backup JSON should refill sponsored clients");
    assert(restoredFromBackup.json.hosts.some((item) => item.name === "Smoke Hosting"), "backup JSON should refill sponsored hosts");

    const deleteSecond = await call("deleteServer", { id: secondServer.json.server.id }, login.json.token);
    assert(deleteSecond.code === 200, "intentional server delete should succeed");
    assert(!deleteSecond.json.servers.some((item) => item.id === secondServer.json.server.id), "delete response should omit the deleted server");
    assert(deleteSecond.json.servers.every((item, index) => item.rank === index + 1), "delete response should rerank remaining servers");
    await fs.writeFile(recoveryPath, JSON.stringify({ version: 2, users: [], servers: [{ ...secondServer.json.server, description: "Deleted server recovery fixture that must not return after an intentional delete because deletion tombstones should block old recovery data from restoring it." }], clients: [], votes: [], voteIps: {} }));
    const afterDeleteRecovery = await call("state", {}, "", "GET");
    assert(!afterDeleteRecovery.json.servers.some((item) => item.id === secondServer.json.server.id), "deleted servers should not be restored from recovery JSON");
    const voteDeletedServer = await call("vote", { serverId: secondServer.json.server.id, minecraftUsername: `Gone_${String(suffix).slice(-4)}` });
    assert(voteDeletedServer.code === 404 || voteDeletedServer.code === 409, "stale votes must not resurrect deleted listings");
    const afterDeletedVote = await call("state", {}, "", "GET");
    assert(!afterDeletedVote.json.servers.some((item) => item.id === secondServer.json.server.id), "deleted server should stay deleted after a stale vote attempt");
    const backupAfterDelete = JSON.parse(await fs.readFile(backupPath, "utf8"));
    assert(backupAfterDelete.deleted?.servers?.[secondServer.json.server.id], "backup JSON should preserve server deletion tombstones");

    const deleteAccountEmails = [];
    const deleteAccountPreviousFetch = global.fetch;
    const deleteAccountPreviousResendApiKey = process.env.RESEND_API_KEY;
    const deleteAccountPreviousResendFromEmail = process.env.RESEND_FROM_EMAIL;
    process.env.RESEND_API_KEY = "smoke-resend-key";
    process.env.RESEND_FROM_EMAIL = "Icon Listing <verify@noreply.iconrealms.net>";
    global.fetch = async (url, options = {}) => {
      if (String(url).includes("api.resend.com/emails")) {
        deleteAccountEmails.push(JSON.parse(options.body || "{}"));
        return { ok: true, json: async () => ({ id: `delete-email-${suffix}` }), text: async () => "" };
      }
      return deleteAccountPreviousFetch(url, options);
    };
    const deleteAccountRegister = await call("register", {
      username: `DeleteMe${String(suffix).slice(-6)}`,
      email: `deleteme${suffix}@example.com`,
      password: "secret123",
      termsAccepted: true
    });
    const deleteAccountCode = JSON.stringify(deleteAccountEmails[0] || {}).match(/\b\d{6}\b/)?.[0];
    assert(deleteAccountRegister.code === 200 && deleteAccountCode, "delete-account fixture should register and receive a verification code");
    const deleteAccountVerify = await call("verifyEmail", { code: deleteAccountCode, verificationToken: deleteAccountRegister.json.verificationToken });
    assert(deleteAccountVerify.code === 200 && deleteAccountVerify.json.token, "delete-account fixture should verify email");
    const deleteAccountServer = await call(
      "saveServer",
      {
        server: {
          name: `Delete Account SMP ${String(suffix).slice(-5)}`,
          javaHost: `delete-account-${suffix}.example.org`,
          country: "United States",
          description: "A temporary listing owned by the account deletion smoke test. It verifies that deleting an account also removes the user's server listings from shared storage without leaving stale records behind. The extra detail keeps this fixture above the public listing description minimum.",
          tags: ["SMP"]
        }
      },
      deleteAccountVerify.json.token
    );
    assert(deleteAccountServer.code === 200 && deleteAccountServer.json.server.id, "delete-account fixture should save a listing");
    const deleteAccountResult = await call("deleteAccount", {
      username: ` ${deleteAccountRegister.json.user.username.toLowerCase()} `,
      email: ` ${deleteAccountRegister.json.user.email.toUpperCase()} `,
      password: "secret123"
    }, deleteAccountVerify.json.token);
    assert(deleteAccountResult.code === 200, "account deletion should accept matching username/email case-insensitively");
    const afterAccountDeleteDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert(!afterAccountDeleteDb.users.some((item) => item.id === deleteAccountRegister.json.user.id), "deleted account should be removed from storage");
    assert(!afterAccountDeleteDb.servers.some((item) => item.ownerId === deleteAccountRegister.json.user.id), "deleted account listings should be removed from storage");
    global.fetch = deleteAccountPreviousFetch;
    if (deleteAccountPreviousResendApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = deleteAccountPreviousResendApiKey;
    if (deleteAccountPreviousResendFromEmail === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = deleteAccountPreviousResendFromEmail;

    console.log("Smoke test passed: auth, Google OAuth, email verification, account deletion, API method/origin/body hardening, login throttle, empty state, profanity filter, host blacklist, Java/Bedrock/Realm listings, duplicate listing checks, duplicate vote plugin keys, backup/recovery fill, deletion tombstones, stale delete protection, multiple listings per account, sitemap XML, mcstatus fallback, Votifier, NuVotifier/AzuVotifier, IconListing vote plugin polling, voting cooldown, next-day voting, delivery-failure-safe voting, sponsored clients, sponsored hosts.");
  } finally {
    provider.close();
    tcpServers.forEach((server) => server.close());
    await fs.rm(dbPath, { force: true });
    await fs.rm(backupPath, { force: true });
    await fs.rm(recoveryPath, { force: true });
  }
}

main().catch(async (error) => {
  await fs.rm(dbPath, { force: true });
  await fs.rm(backupPath, { force: true });
  await fs.rm(recoveryPath, { force: true });
  console.error(error);
  process.exit(1);
});
