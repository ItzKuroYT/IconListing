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
  const req = {
    method,
    url: `/api?action=${encodeURIComponent(action)}`,
    query: { action },
    body,
    headers: { authorization: token ? `Bearer ${token}` : "", ...headers }
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

async function main() {
  const received = [];
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

    const login = await call("login", {
      login: `smoke${suffix}@example.com`,
      password: "secret123"
    });
    assert(login.code === 200 && login.json.user.username.startsWith("Smoke"), "login should return the user");

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

    const repeatVote = await call("vote", {
      serverId: saved.json.server.id,
      minecraftUsername: `Alex_${String(suffix).slice(-4)}`
    });
    assert(repeatVote.code === 429, "repeat vote should be blocked for 24 hours");
    assert(received.length === 2, "blocked repeat vote should not call the Votifier provider");

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
    assert(sitemap.body.includes(`/server/?id=${saved.json.server.id}`), "sitemap should include saved server listing URLs");

    const finalState = await call("state", {}, "", "GET");
    const server = finalState.json.servers.find((item) => item.id === saved.json.server.id);
    const otherServer = finalState.json.servers.find((item) => item.id === secondServer.json.server.id);
    const bedrockSaved = finalState.json.servers.find((item) => item.id === bedrockServer.json.server.id);
    const realmSaved = finalState.json.servers.find((item) => item.id === bedrockRealm.json.server.id);
    const client = finalState.json.clients.find((item) => item.name === "Smoke Client");
    const host = finalState.json.hosts.find((item) => item.name === "Smoke Hosting");
    assert(server && server.votes === 1, "server should have one counted vote");
    assert(!server.iconListingVoteKey && !server.iconListingVoteQueue && !server.votifierToken, "public state should not expose private vote delivery keys or queues");
    assert(otherServer && otherServer.ownerId === server.ownerId, "same account should keep multiple unique listings");
    assert(bedrockSaved && bedrockSaved.edition === "bedrock" && bedrockSaved.bedrockHost === "bedrock.example.org", "bedrock server fields should be stored");
    assert(realmSaved && realmSaved.edition === "bedrock" && realmSaved.bedrockType === "realm" && realmSaved.realmCode === "abc123Realm", "bedrock realm fields should be stored");
    assert(server.description.includes("\nLine two") && server.description.includes("\n\nLine four"), "server description should preserve line breaks");
    assert(server.analytics.ipCopiesLast30 === 1, "server should expose public IP copy analytics");
    assert(client && client.images.length === 2 && client.version === "both" && client.pricing === "paid", "sponsored client fields should be stored");
    assert(host && host.images.length === 3 && host.pricing === "paid", "sponsored host fields should be stored");
    assert(finalState.json.votes.length === 1, "monthly vote records should be stored");
    const backup = JSON.parse(await fs.readFile(backupPath, "utf8"));
    assert(Array.isArray(backup.servers) && backup.servers.length >= 4, "backup JSON should preserve server listings");
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
    await fs.writeFile(recoveryPath, JSON.stringify({ version: 2, users: [], servers: [{ ...secondServer.json.server, description: "Deleted server recovery fixture that must not return after an intentional delete because deletion tombstones should block old recovery data from restoring it." }], clients: [], votes: [], voteIps: {} }));
    const afterDeleteRecovery = await call("state", {}, "", "GET");
    assert(!afterDeleteRecovery.json.servers.some((item) => item.id === secondServer.json.server.id), "deleted servers should not be restored from recovery JSON");
    const backupAfterDelete = JSON.parse(await fs.readFile(backupPath, "utf8"));
    assert(backupAfterDelete.deleted?.servers?.[secondServer.json.server.id], "backup JSON should preserve server deletion tombstones");

    console.log("Smoke test passed: auth, API method/origin/body hardening, login throttle, empty state, profanity filter, host blacklist, Java/Bedrock/Realm listings, duplicate listing checks, duplicate vote plugin keys, backup/recovery fill, deletion tombstones, multiple listings per account, sitemap XML, mcstatus fallback, Votifier, IconListing vote plugin polling, voting cooldown, sponsored clients, sponsored hosts.");
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
