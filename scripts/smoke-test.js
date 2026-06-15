const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");

const dbPath = path.join(os.tmpdir(), `icon-listing-smoke-${Date.now()}.json`);
process.env.ICON_LISTING_DB_PATH = dbPath;

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
    query: { action },
    body,
    headers: { authorization: token ? `Bearer ${token}` : "", ...headers }
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
          votifierToken: "token"
        }
      },
      login.json.token
    );
    assert(saved.code === 200 && saved.json.server.id, "server save should succeed");

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

    const finalState = await call("state", {}, "", "GET");
    const server = finalState.json.servers.find((item) => item.id === saved.json.server.id);
    const client = finalState.json.clients.find((item) => item.name === "Smoke Client");
    assert(server && server.votes === 1, "server should have one counted vote");
    assert(server.description.includes("\nLine two") && server.description.includes("\n\nLine four"), "server description should preserve line breaks");
    assert(server.analytics.ipCopiesLast30 === 1, "server should expose public IP copy analytics");
    assert(client && client.images.length === 2 && client.version === "both" && client.pricing === "paid", "sponsored client fields should be stored");
    assert(finalState.json.votes.length === 1, "monthly vote records should be stored");

    console.log("Smoke test passed: auth, empty state, profanity filter, mcstatus fallback, Votifier, voting, sponsored clients.");
  } finally {
    provider.close();
    await fs.rm(dbPath, { force: true });
  }
}

main().catch(async (error) => {
  await fs.rm(dbPath, { force: true });
  console.error(error);
  process.exit(1);
});
