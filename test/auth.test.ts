import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../server/config.ts";
import { Providers, ProviderError } from "../server/providers.ts";
import { Authentication } from "../server/session.ts";
import { createApp } from "../server/app.ts";
import { installTerminal } from "../server/terminal.ts";

const projects = [
  {
    id: "example",
    name: "Example",
    repository: "example/addons",
    infraRepository: "example/infra",
    environments: [
      {
        id: "staging",
        name: "Staging",
        branch: "staging",
        stage: "Staging",
        stack: "allowed",
        terminal: true,
      },
      {
        id: "private",
        name: "Private",
        branch: "private",
        stage: "Production",
        stack: "denied",
      },
    ],
  },
];
const env = {
  work_env: "prod",
  DASHBOARD_AUTO_DISCOVER: "false",
  DASHBOARD_SESSION_SECRET: "s".repeat(40),
  DASHBOARD_PROJECTS_JSON: JSON.stringify(projects),
  FORGEJO_URL: "https://forge.example",
  FORGEJO_TOKEN: "forge-token",
  KOMODO_URL: "https://komodo.example",
};
const token = (name: string, exp = Math.floor(Date.now() / 1000) + 3600) =>
  `header.${Buffer.from(JSON.stringify({ sub: name, exp })).toString("base64url")}.signature`;
const cookies = (r: Response) =>
  r.headers
    .getSetCookie()
    .filter((v) => !v.includes("Max-Age=0"))
    .map((v) => v.split(";", 1)[0])
    .join("; ");
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture(t: { after: (fn: () => void) => void }) {
  const state = {
    enabled: true,
    allowed: true,
    forge: 0,
    auth: [] as string[],
    jwt: [] as string[],
    mfaCookie: "",
    expired: false,
    endAuth: "",
    stackFailure: "" as "" | "http" | "html" | "connection",
  };
  const upstreamApp = express();
  upstreamApp.use(express.json());
  upstreamApp.post("/auth/login/LoginLocalUser", (req, res) => {
    state.auth.push(req.body.username);
    if (req.body.password !== "correct") {
      res.status(401).json({ error: "secret internal details" });
      return;
    }
    if (req.body.username === "totp") {
      res.setHeader(
        "Set-Cookie",
        "komodo_challenge=private-challenge; Path=/auth; HttpOnly",
      );
      res.json({ type: "Totp", data: {} });
      return;
    }
    if (req.body.username === "passkey") {
      res.json({ type: "Passkey", data: {} });
      return;
    }
    res.json({
      type: "Jwt",
      data: { jwt: token(req.body.username, state.expired ? 1 : undefined) },
    });
  });
  upstreamApp.post("/auth/login/CompleteTotpLogin", (req, res) => {
    state.mfaCookie = req.headers.cookie ?? "";
    if (
      state.mfaCookie !== "komodo_challenge=private-challenge" ||
      req.body.code !== "123456"
    ) {
      res.status(401).json({});
      return;
    }
    res.json({ jwt: token("totp") });
  });
  upstreamApp.get("/user", (req, res) => {
    const jwt = req.headers.authorization ?? "";
    state.jwt.push(jwt);
    if (!jwt.startsWith("header.")) {
      res.status(401).json({});
      return;
    }
    const name = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString(),
    ).sub;
    res.json({ username: name, enabled: state.enabled });
  });
  upstreamApp.post("/read/GetStack", (req, res) => {
    assert.ok(req.headers.authorization?.startsWith("header."));
    assert.equal(req.headers["x-api-key"], undefined);
    if (req.body.stack === "broken" || state.stackFailure === "http") {
      res
        .status(500)
        .json({ error: "private upstream credential=do-not-leak" });
      return;
    }
    if (state.stackFailure === "html") {
      res
        .type("html")
        .send("<html>private upstream credential=do-not-leak</html>");
      return;
    }
    if (state.stackFailure === "connection") {
      req.socket.destroy();
      return;
    }
    if (!state.allowed || req.body.stack === "denied") {
      res.status(403).json({});
      return;
    }
    res.json({ _id: { $oid: "allowed-id" }, info: {} });
  });
  upstreamApp.post("/read/ListStackServices", (_req, res) =>
    res.json([{ service: "odoo", state: "Running" }]),
  );
  upstreamApp.post("/read/ListUpdates", (_req, res) =>
    res.json({ updates: [] }),
  );
  upstreamApp.use("/api/v1", (_req, res) => {
    state.forge++;
    res.json([]);
  });
  upstreamApp.post("/write/DeleteTerminal", (req, res) => {
    state.endAuth = req.headers.authorization ?? "";
    res.json({});
  });
  const upstream = createServer(upstreamApp);
  const upstreamUrl = await listen(upstream);
  const config = loadConfig({
    ...env,
    KOMODO_URL: upstreamUrl,
    FORGEJO_URL: upstreamUrl,
    DASHBOARD_TERMINAL_ENABLED: "true",
  });
  const providers = new Providers(config),
    auth = new Authentication(config);
  const app = createApp(config, providers, auth);
  const server = createServer(app);
  const url = await listen(server);
  t.after(() => {
    server.close();
    server.closeAllConnections();
    upstream.close();
    upstream.closeAllConnections();
  });
  const post = (
    path: string,
    body: object = {},
    cookie = "",
    origin = config.origin,
  ) =>
    fetch(url + "/api/auth/" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
  const login = (username = "alice") =>
    post("login", { username, password: "correct" });
  const get = (path: string, cookie = "") =>
    fetch(url + path, { headers: { Cookie: cookie } });
  return {
    state,
    config,
    auth,
    providers,
    server,
    upstream,
    url,
    login,
    post,
    get,
  };
}

test("Komodo auth is the production default and needs no shared Komodo credentials or user allowlist", () => {
  const c = loadConfig({ ...env, DASHBOARD_TERMINAL_ENABLED: "true" });
  assert.equal(c.authMode, "komodo");
  assert.equal(c.komodoKey, "");
  assert.deepEqual(c.terminalUsers, []);
  assert.throws(
    () => loadConfig({ ...env, DASHBOARD_SESSION_SECRET: "" }),
    /SESSION_SECRET/,
  );
});
test("any enabled account can login; cookies are encrypted, signed and revoked on logout or disable", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get("/api/snapshot")).status, 401);
  const spoof = await fetch(f.url + "/api/snapshot", {
    headers: {
      "X-Dashboard-User": "admin",
      "X-Dashboard-Proxy-Secret": "s".repeat(40),
    },
  });
  assert.equal(spoof.status, 401);
  const bad = await f.post("login", { username: "alice", password: "wrong" });
  assert.equal(bad.status, 401);
  assert.ok(!(await bad.text()).includes("secret internal"));
  const response = await f.login("someone-not-on-an-allowlist");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    authenticated: true,
    user: "someone-not-on-an-allowlist",
  });
  const cookie = cookies(response);
  assert.ok(cookie);
  assert.ok(!cookie.includes("header."));
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(response.headers.get("set-cookie")!, /SameSite=Strict/);
  assert.equal(
    (await f.get("/api/auth/session", cookie)).headers.get("cache-control"),
    "no-store",
  );
  assert.equal((await f.get("/api/snapshot", cookie)).status, 200);
  const badCookie = cookie.slice(0, -12) + "aaaaaaaaaaaa";
  assert.equal((await f.get("/api/snapshot", badCookie)).status, 401);
  assert.equal((await f.post("logout", {}, cookie)).status, 200);
  assert.equal((await f.get("/api/snapshot", cookie)).status, 401);
  const second = cookies(await f.login("bob"));
  f.state.enabled = false;
  assert.equal((await f.get("/api/snapshot", second)).status, 401);
  assert.equal((await f.login("disabled")).status, 401);
});
test("password authentication enforces same origin, input limits, rate limits and has no signup endpoint", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.post(
        "login",
        { username: "alice", password: "correct" },
        "",
        "https://evil.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.post("login", { username: "alice", password: "correct" }, "", ""))
      .status,
    403,
  );
  assert.equal((await f.post("signup")).status, 404);
  assert.equal((await f.post("login", { username: "alice" })).status, 400);
  for (let i = 0; i < 8; i++)
    await f.post("login", { username: "alice", password: "wrong" });
  const limited = await f.login();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal((await f.post("logout")).status, 200);
});
test("TOTP is completed on the same upstream session and passkey challenges cannot bypass MFA", async (t) => {
  const f = await fixture(t);
  const start = await f.login("totp");
  assert.deepEqual(await start.json(), { challenge: "totp" });
  const challenge = cookies(start);
  assert.ok(!challenge.includes("private-challenge"));
  assert.equal((await f.get("/api/snapshot", challenge)).status, 401);
  assert.equal((await f.post("totp", { code: "123456" })).status, 401);
  const finish = await f.post("totp", { code: "123456" }, challenge);
  assert.equal(finish.status, 200);
  assert.equal(f.state.mfaCookie, "komodo_challenge=private-challenge");
  assert.equal((await f.get("/api/snapshot", cookies(finish))).status, 200);
  const passkey = await f.login("passkey");
  assert.equal(passkey.status, 400);
  assert.ok(!cookies(passkey));
  f.state.expired = true;
  assert.equal((await f.login()).status, 401);
});
test("stack permissions filter snapshots before Forgejo access and cannot be bypassed with discovered branch IDs", async (t) => {
  const f = await fixture(t);
  const cookie = cookies(await f.login());
  const snapshot = await (await f.get("/api/snapshot", cookie)).json();
  assert.deepEqual(
    snapshot.projects[0].environments.map((e: { id: string }) => e.id),
    ["staging"],
  );
  assert.ok(!JSON.stringify(snapshot).includes("header."));
  assert.equal(
    (
      await f.get(
        "/api/commits?project=example&environment=private&page=1",
        cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.get(
        "/api/logs?project=example&environment=private&source=ci&id=1",
        cookie,
      )
    ).status,
    403,
  );
  const forgeCalls = f.state.forge;
  f.state.allowed = false;
  const denied = await (await f.get("/api/snapshot", cookie)).json();
  assert.deepEqual(denied.projects, []);
  assert.equal(f.state.forge, forgeCalls);
  const first = f.providers.forSession(token("alice")),
    second = f.providers.forSession(token("bob"));
  assert.notEqual(first, second);
  await first.cached("private", async () => 42);
  assert.equal(await second.cached("private", async () => 7), 7);
  const p = new Providers(f.config, token("alice"));
  p.request = async (provider, path, body) => {
    if (provider === "Komodo") {
      if ((body as { stack: string })?.stack === "denied")
        throw new ProviderError("Komodo", 403);
      return { _id: { $oid: "allowed-id" } };
    }
    if (path.includes("branches?")) return [{ name: "private" }];
    return [];
  };
  const s = await p.snapshot("alice");
  assert.ok(!s.projects[0].environments.some((e) => e.branch === "private"));
  assert.throws(
    () =>
      p.mapping(
        "example",
        "branch-" + Buffer.from("private").toString("base64url"),
      ),
    /Unknown/,
  );
});
test("sessions use secure cookies on HTTPS, expire, and cannot survive a dashboard restart", async (t) => {
  const f = await fixture(t);
  f.config.origin = "https://dashboard.example";
  const response = await f.login();
  assert.match(response.headers.get("set-cookie")!, /; Secure/);
  const cookie = cookies(response);
  const request = {
    headers: { cookie },
  } as import("node:http").IncomingMessage;
  assert.ok(f.auth.session(request));
  assert.equal(new Authentication(f.config).session(request), undefined);
  const active = f.auth as unknown as { active: Map<string, number> };
  active.active.clear();
  assert.equal(f.auth.session(request), undefined);
});
test("terminal relay authenticates and ends sessions with the caller JWT and isolates logins", async (t) => {
  const f = await fixture(t);
  const wss = new WebSocketServer({
    server: f.upstream,
    verifyClient: ({ req }: { req: import("node:http").IncomingMessage }) => {
      const query = req.url?.split("?", 2)[1] ?? "";
      return (
        query.includes("target[type]=Stack") &&
        query.includes("init[mode]=exec") &&
        !query.includes("target%5B")
      );
    },
  });
  const relay = installTerminal(f.server, f.config, f.providers, f.auth);
  let loginFrame: { type: string; params: { jwt: string } };
  wss.on("connection", (ws) =>
    ws.once("message", (data) => {
      loginFrame = JSON.parse(data.toString());
      ws.send("LOGGED_IN");
    }),
  );
  const cookie = cookies(await f.login("alice"));
  const sockets: WebSocket[] = [];
  t.after(() => {
    sockets.forEach((s) => s.terminate());
    relay.clients.forEach((s) => s.terminate());
    wss.clients.forEach((s) => s.terminate());
    relay.close();
    wss.close();
  });
  const connect = (cookie: string, session = "") => {
    const ws = new WebSocket(
      f.url.replace("http:", "ws:") +
        `/api/terminal?project=example&environment=staging&session=${session}`,
      { origin: f.config.origin, headers: { Cookie: cookie } },
    );
    sockets.push(ws);
    return ws;
  };
  const ws = connect(cookie);
  const [raw] = await once(ws, "message");
  const ready = JSON.parse(raw.toString());
  assert.equal(ready.type, "ready");
  assert.equal(loginFrame!.type, "Jwt");
  assert.ok(loginFrame!.params.jwt.startsWith("header."));
  const second = cookies(await f.login("alice"));
  await assert.rejects(once(connect(second, ready.session), "open"), /403/);
  const ended = once(ws, "message");
  ws.send(JSON.stringify({ type: "end" }));
  assert.equal(JSON.parse((await ended)[0].toString()).type, "ended");
  assert.equal(f.state.endAuth, loginFrame!.params.jwt);
});

test("a failed stack access check preserves readable deployments and returns safe actionable diagnostics", async (t) => {
  const f = await fixture(t);
  f.config.projects[0].environments.push({
    ...f.config.projects[0].environments[0],
    id: "broken",
    branch: "broken",
    stack: "broken",
  });
  const cookie = cookies(await f.login());
  const response = await f.get("/api/snapshot", cookie);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.stale, true);
  assert.deepEqual(
    snapshot.projects[0].environments.map((e: { id: string }) => e.id),
    ["staging"],
  );
  assert.match(
    snapshot.issues.join(" "),
    /Komodo: Stack access check failed \(HTTP 500\)/,
  );
  assert.ok(!JSON.stringify(snapshot).includes("do-not-leak"));
  assert.equal(
    snapshot.providers.find((p: { name: string }) => p.name === "Komodo").state,
    "unavailable",
  );
});
test("failed stack checks never grant repository access and distinguish connection and invalid API response failures", async (t) => {
  for (const mode of ["http", "html", "connection"] as const) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      f.state.stackFailure = mode;
      const cookie = cookies(await f.login());
      const response = await f.get("/api/snapshot", cookie);
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.deepEqual(snapshot.projects, []);
      assert.equal(f.state.forge, 0);
      assert.equal(snapshot.stale, true);
      const diagnostic = snapshot.issues.join(" ");
      assert.match(
        diagnostic,
        mode === "http"
          ? /HTTP 500/
          : mode === "html"
            ? /invalid API response/
            : /could not connect/,
      );
      assert.ok(!JSON.stringify(snapshot).includes("do-not-leak"));
    });
  }
});
