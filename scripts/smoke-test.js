const fs = require("fs/promises");
const http = require("http");
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

async function main() {
  const received = [];
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
      password: "secret123"
    }, "", "POST", { origin: "https://evil.example" });
    assert(badOrigin.code === 403, "write actions should reject unapproved browser origins");

    const suffix = Date.now();
    const register = await call("register", {
      username: `Smoke${suffix}`,
      email: `smoke${suffix}@example.com`,
      password: "secret123"
    });
    assert(register.code === 200 && register.json.token, "register should return a session token");

    const registeredDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const registeredUser = registeredDb.users.find((item) => item.id === register.json.user.id);
    assert(registeredUser, "registered user should be stored");
    const staleRegisteredDb = { ...registeredDb, users: registeredDb.users.filter((item) => item.id !== registeredUser.id) };
    await fs.writeFile(dbPath, JSON.stringify(staleRegisteredDb));
    await fs.writeFile(backupPath, JSON.stringify(staleRegisteredDb));
    const staleSessionState = await call("state", {}, register.json.token, "GET");
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
      register.json.token
    );
    assert(staleSessionSave.code === 200 && staleSessionSave.json.server.ownerId === registeredUser.id, "fresh signup session should create listings during a stale user read");
    const afterStaleSessionSave = JSON.parse(await fs.readFile(dbPath, "utf8"));
    if (!afterStaleSessionSave.users.some((item) => item.id === registeredUser.id)) afterStaleSessionSave.users.push(registeredUser);
    await fs.writeFile(dbPath, JSON.stringify(afterStaleSessionSave));

    const login = await call("login", {
      login: `smoke${suffix}@example.com`,
      password: "secret123"
    });
    assert(login.code === 200 && login.json.user.username.startsWith("Smoke"), "login should return the user");

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
    assert(saved.code === 200 && saved.json.server.id, "server save should succeed");
    assert(saved.json.server.iconListingVoteKey === `smoke-key-${suffix}`, "server owner should receive the IconListing vote plugin key");

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

    const admin = await call("register", {
      username: "ItzKuroYT",
      email: `admin${suffix}@example.com`,
      password: "secret123"
    });
    assert(admin.code === 200 && admin.json.user.admin, "configured admin should register as admin");

    const adminDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const adminUser = adminDb.users.find((item) => item.id === admin.json.user.id);
    const staleAdminDb = { ...adminDb, users: adminDb.users.filter((item) => item.id !== adminUser.id) };
    await fs.writeFile(dbPath, JSON.stringify(staleAdminDb));
    await fs.writeFile(backupPath, JSON.stringify(staleAdminDb));
    const staleAdmin = await call("admin", { command: "saveHost", value: { name: "Blocked Stale Admin", url: "https://example.com", description: "A stale snapshot admin attempt should not be able to save paid host listings because admin power must come from the stored account record." } }, admin.json.token);
    assert(staleAdmin.code === 403, "token snapshot fallback should not grant admin access");
    const restoredAdminDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    if (!restoredAdminDb.users.some((item) => item.id === adminUser.id)) restoredAdminDb.users.push(adminUser);
    await fs.writeFile(dbPath, JSON.stringify(restoredAdminDb));

    const beforeUserListRead = await fs.readFile(dbPath, "utf8");
    const adminUsers = await call("admin", { command: "listUsers" }, admin.json.token);
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
      admin.json.token
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
      admin.json.token
    );
    assert(hostSave.code === 200 && hostSave.json.hosts.length === 1, "admin should save a sponsored host");

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

    console.log("Smoke test passed: auth, API method/origin/body hardening, login throttle, empty state, profanity filter, host blacklist, Java/Bedrock/Realm listings, duplicate listing checks, duplicate vote plugin keys, backup/recovery fill, deletion tombstones, stale delete protection, multiple listings per account, sitemap XML, mcstatus fallback, Votifier, IconListing vote plugin polling, voting cooldown, next-day voting, delivery-failure-safe voting, sponsored clients, sponsored hosts.");
  } finally {
    provider.close();
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
