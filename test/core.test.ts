import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.ts";
import { identity, canTerminal } from "../server/auth.ts";
import {
  aggregate,
  cleanLog,
  result,
  updateState,
  digest,
  sourceMatch,
} from "../server/normalize.ts";
import {
  terminalFrame,
  installTerminal,
  terminalQuery,
  terminalFailureMessage,
} from "../server/terminal.ts";
import { createApp } from "../server/app.ts";
import { testSnapshot } from "../server/fixtures.ts";
import { Providers, ProviderError } from "../server/providers.ts";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
const projects = [
  {
    id: "example",
    name: "Test project",
    repository: "team/addons",
    infraRepository: "team/infra",
    environments: [
      {
        id: "staging",
        name: "Staging",
        branch: "staging",
        stage: "Staging",
        stack: "stack-1",
        imagePath: "stacks/staging.image.env",
        terminal: true,
      },
    ],
  },
];
const live = {
  work_env: "prod",
  DASHBOARD_AUTO_DISCOVER: "false",
  DASHBOARD_AUTH_MODE: "proxy",
  DASHBOARD_PROJECTS_JSON: JSON.stringify(projects),
  FORGEJO_URL: "https://forge.example",
  FORGEJO_TOKEN: "forge-token",
  KOMODO_URL: "https://komodo.example",
  KOMODO_API_KEY: "read-key",
  KOMODO_API_SECRET: "read-secret",
  DASHBOARD_PROXY_SECRET: "a".repeat(32),
};
const headers = (extra: Record<string, string>) =>
  ({ headers: extra }) as IncomingMessage;
test("live configuration and terminal policy fail closed", () => {
  assert.equal(loadConfig({}).workEnv, "test");
  assert.throws(
    () => loadConfig({ ...live, DASHBOARD_PROXY_SECRET: "" }),
    /PROXY_SECRET/,
  );
  assert.throws(
    () => loadConfig({ ...live, DASHBOARD_TERMINAL_ENABLED: "true" }),
    /Terminal requires/,
  );
  assert.throws(() =>
    loadConfig({ ...live, DASHBOARD_PROJECTS_JSON: "not JSON" }),
  );
  assert.throws(() =>
    loadConfig({ ...live, FORGEJO_URL: "file:///etc/passwd" }),
  );
  assert.throws(
    () => loadConfig({ ...live, work_env: "invalid" }),
    /test|prod/,
  );
});
test("view access requires a trusted proxy; terminal has separate identity and target policy", () => {
  const c = loadConfig({
    ...live,
    DASHBOARD_TERMINAL_ENABLED: "true",
    DASHBOARD_TERMINAL_USERS: "alice",
  });
  assert.equal(
    identity(headers({ "x-dashboard-user": "alice" }), c),
    undefined,
  );
  assert.equal(
    identity(
      headers({
        "x-dashboard-user": "alice",
        "x-dashboard-proxy-secret": "wrong",
      }),
      c,
    ),
    undefined,
  );
  assert.equal(
    identity(
      headers({
        "x-dashboard-user": "alice",
        "x-dashboard-proxy-secret": c.proxySecret,
      }),
      c,
    ),
    "alice",
  );
  assert.ok(canTerminal(c, "alice", c.projects[0].environments[0]));
  assert.ok(!canTerminal(c, "bob", c.projects[0].environments[0]));
  assert.ok(
    !canTerminal(c, "alice", {
      ...c.projects[0].environments[0],
      stage: "Production",
    }),
  );
  assert.ok(
    !canTerminal(c, "alice", {
      ...c.projects[0].environments[0],
      terminal: false,
    }),
  );
});
test("missing checks, mutable image tags and running attempts do not imply success or correlation", () => {
  assert.equal(aggregate([]), "unknown");
  assert.equal(aggregate(["passed", "unknown"]), "unknown");
  assert.equal(aggregate(["passed", "failed"]), "failed");
  assert.equal(updateState({ status: "InProgress", success: true }), "running");
  assert.equal(updateState({ status: "Complete", success: false }), "failed");
  assert.equal(result("skipped"), "skipped");
  assert.ok(!sourceMatch(undefined, "abcde12"));
  assert.ok(!digest("repo:mutable-tag"));
  assert.equal(
    digest("repo@sha256:" + "a".repeat(64)),
    "@sha256:" + "a".repeat(64),
  );
});
test("logs strip Komodo UI spans and known secrets; HTML remains plain text", () => {
  const s = cleanLog(
    '<span class="ok">ok</span> token=abc known-secret <script>test</script>',
    ["known-secret"],
  );
  assert.ok(!s.includes("<span"));
  assert.ok(!s.includes("abc"));
  assert.ok(!s.includes("known-secret"));
  assert.ok(s.includes("<script>"));
});
test("terminal wire frames validate input and resize, preserving UTF-8", () => {
  assert.deepEqual(
    terminalFrame({ type: "input", data: "Привет\r" }),
    Buffer.concat([Buffer.from("Привет\r"), Buffer.from([1])]),
  );
  const resize = terminalFrame({ type: "resize", rows: 30, cols: 100 });
  assert.equal(resize.at(-1), 255);
  assert.deepEqual(JSON.parse(resize.subarray(0, -1).toString()), {
    rows: 30,
    cols: 100,
  });
  assert.throws(() =>
    terminalFrame({ type: "Jwt", params: { jwt: "malicious" } }),
  );
  assert.throws(() => terminalFrame({ type: "resize", rows: -1, cols: 200 }));
  assert.throws(() => terminalFrame({ type: "input", data: "x".repeat(9000) }));
});
test("provider projection separates failed attempt from deployed image and ignores one-shot exits", async () => {
  const p = new Providers(loadConfig(live));
  const calls: string[] = [];
  p.request = async (provider, path) => {
    calls.push(`${provider}:${path}`);
    if (path.includes("/branches?")) return [];
    if (path.includes("/commits?"))
      return [
        {
          sha: "a".repeat(40),
          commit: {
            message: "Test commit",
            author: { name: "A", date: "2026-10-20T10:00:00Z" },
          },
        },
      ];
    if (path.endsWith("/status"))
      return { statuses: [{ context: "tests", status: "success" }] };
    if (path.includes("/actions/runs?"))
      return {
        workflow_runs: [
          {
            id: 7,
            title: "CI",
            commit_sha: "a".repeat(40),
            status: "success",
            created: "2026-10-20T10:00:00Z",
          },
        ],
      };
    if (path.includes("/contents/"))
      return {
        content: Buffer.from("ODOO_IMAGE=registry/odoo:next").toString(
          "base64",
        ),
      };
    if (path === "/read/GetStack")
      return {
        _id: { $oid: "s1" },
        config: { environment: "DB_PASSWORD=secret" },
        info: {
          deployed_hash: "oldsha123",
          deployed_contents: [
            {
              path: "staging.image.env",
              contents: "ODOO_IMAGE=registry/odoo:old",
            },
          ],
        },
      };
    if (path === "/read/ListStackServices")
      return [
        { service: "odoo", state: "Running", image: "registry/odoo:old" },
        { service: "migrate", state: "Exited", image: "registry/odoo:old" },
      ];
    if (path === "/read/ListUpdates")
      return {
        updates: [
          {
            id: "failed",
            status: "Complete",
            success: false,
            start_ts: 10,
            operation: "DeployStack",
            target: { type: "Stack", id: "s1" },
          },
        ],
        next_page: 1,
      };
    throw new Error(`Unexpected ${path}`);
  };
  const snapshot = await p.snapshot("viewer"),
    e = snapshot.projects[0].environments[0];
  assert.equal(e.health, "running");
  assert.equal(e.attempts[0].state, "failed");
  assert.equal(e.deployedInfraSha, "oldsha123");
  assert.equal(e.deployedImage, "registry/odoo:old");
  assert.equal(e.desiredImage, "registry/odoo:next");
  assert.equal(e.runs[0].sha, "a".repeat(40));
  assert.ok(!JSON.stringify(snapshot).includes("DB_PASSWORD"));
  assert.ok(
    calls.every((x) => !x.includes("/write") && !x.includes("/execute")),
  );
});
test("failed reads retain cached data without mutating its successful timestamp", async () => {
  const p = new Providers(loadConfig(live));
  assert.equal(await p.cached("forge:test", async () => 7), 7);
  (
    p as unknown as { cache: Map<string, { value: unknown; at: number }> }
  ).cache.get("forge:test")!.at = 0;
  assert.equal(
    await p.cached("forge:test", async () => {
      throw new Error("offline");
    }),
    7,
  );
  assert.equal(
    (p as unknown as { cache: Map<string, { at: number }> }).cache.get(
      "forge:test",
    )!.at,
    0,
  );
});
test("deployment log IDs cannot cross stack boundaries", async () => {
  const p = new Providers(loadConfig(live));
  p.read = async (name) =>
    name === "GetStack"
      ? { _id: { $oid: "s1" } }
      : {
          target: { type: "Stack", id: "other" },
          operation: "DeployStack",
          logs: [{ stdout: "private" }],
        };
  await assert.rejects(
    p.logs("example", "staging", "deploy", "other"),
    /does not belong/,
  );
});
test("CI logs check selected branch and pin job attempt", async () => {
  const p = new Providers(loadConfig(live));
  let pathRead = "";
  p.forge = async (path) =>
    path.endsWith("/jobs")
      ? [{ id: 9, name: "Tests", attempt: 2 }]
      : { prettyref: "staging" };
  p.request = async (_provider, path) => {
    pathRead = path;
    return "INFO tests passed";
  };
  const logs = await p.logs("example", "staging", "ci", "7");
  assert.match(pathRead, /jobs\/9\/logs\?attempt=2/);
  assert.match(logs.entries[0].stage, /attempt 2/);
  p.forge = async () => ({ prettyref: "production" });
  await assert.rejects(
    p.logs("example", "staging", "ci", "7"),
    /does not belong/,
  );
});
test("relay uses server credentials, rejects foreign origins/viewers, and isolates named sessions", async (t) => {
  const upstreamServer = createServer(),
    upstream = new WebSocketServer({
      server: upstreamServer,
      verifyClient: ({ req }: { req: import("node:http").IncomingMessage }) => {
        const query = req.url?.split("?", 2)[1] ?? "";
        return (
          query.includes("target[type]=Stack") &&
          query.includes("init[mode]=exec") &&
          !query.includes("target%5B")
        );
      },
    });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  const upPort = (upstreamServer.address() as { port: number }).port;
  const c = loadConfig({
    ...live,
    KOMODO_URL: `http://127.0.0.1:${upPort}`,
    DASHBOARD_TERMINAL_ENABLED: "true",
    DASHBOARD_TERMINAL_USERS: "alice,bob",
  });
  const requests: string[] = [],
    frames: Buffer[] = [];
  let endedBody: Record<string, any> | undefined;
  upstreamServer.on("request", async (req, res) => {
    assert.equal(req.url, "/write/DeleteTerminal");
    assert.equal(req.headers["x-api-key"], "read-key");
    let body = "";
    for await (const chunk of req) body += chunk;
    endedBody = JSON.parse(body);
    upstream.clients.forEach((s) => s.close());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });

  upstream.on("connection", (ws, req) => {
    requests.push(req.url!);
    let logged = false;
    ws.on("message", (data, binary) => {
      if (!logged) {
        assert.equal(binary, false);
        assert.deepEqual(JSON.parse(data.toString()), {
          type: "ApiKeys",
          params: { key: "read-key", secret: "read-secret" },
        });
        logged = true;
        ws.send("LOGGED_IN");
      } else {
        frames.push(Buffer.from(data as Buffer));
        ws.send(Buffer.from("hello"), { binary: true });
      }
    });
  });
  const server = createServer(),
    p = new Providers(c),
    relay = installTerminal(server, c, p);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  t.after(() => {
    sockets.forEach((s) => s.terminate());
    relay.clients.forEach((s) => s.terminate());
    upstream.clients.forEach((s) => s.terminate());
    relay.close();
    upstream.close();
    server.close();
    upstreamServer.close();
  });
  const connect = (user: string, origin = c.origin, session = "") => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/terminal?project=example&environment=staging${session ? `&session=${session}` : ""}`,
      {
        origin,
        headers: {
          "x-dashboard-user": user,
          "x-dashboard-proxy-secret": c.proxySecret,
        },
      },
    );
    sockets.push(ws);
    return ws;
  };
  const ws = connect("alice");
  const [readyRaw] = await once(ws, "message");
  const ready = JSON.parse(readyRaw.toString());
  assert.equal(ready.type, "ready");
  assert.ok(ready.session);
  assert.match(requests[0], /target\[params\]\[stack\]=stack-1/);
  assert.ok(!requests[0].includes("read-secret"));
  ws.send(JSON.stringify({ type: "input", data: "pwd\r" }));
  const [output, binary] = await once(ws, "message");
  assert.equal(binary, true);
  assert.equal(output.toString(), "hello");
  assert.deepEqual(
    frames[0],
    Buffer.concat([Buffer.from("pwd\r"), Buffer.from([1])]),
  );
  await assert.rejects(
    once(connect("bob", c.origin, ready.session), "open"),
    /403/,
  );
  await assert.rejects(
    once(connect("alice", "https://evil.example"), "open"),
    /403/,
  );
  await assert.rejects(once(connect("viewer"), "open"), /403/);
  const endingMessage = once(ws, "message");
  ws.send(
    JSON.stringify({
      type: "end",
      target: { stack: "other" },
      terminal: "someone-else",
    }),
  );
  const [ended] = await endingMessage;
  assert.equal(JSON.parse(ended.toString()).type, "ended");
  assert.equal(endedBody?.target.params.stack, "stack-1");
  assert.equal(endedBody?.target.params.service, "odoo");
  assert.ok(String(endedBody?.terminal).startsWith("dash-"));
});

test("HTTP boundary rejects spoofed identities and mutations; authenticated reads are not cached by browsers", async (t) => {
  const config = loadConfig(live),
    providers = new Providers(config);
  let reads = 0;
  providers.snapshot = async () => {
    reads++;
    return testSnapshot();
  };
  const server = createServer(createApp(config, providers));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(url + "/api/snapshot")).status, 401);
  assert.equal(
    (
      await fetch(url + "/api/snapshot", {
        headers: { "X-Dashboard-User": "alice" },
      })
    ).status,
    401,
  );
  const headers = {
    "X-Dashboard-User": "alice",
    "X-Dashboard-Proxy-Secret": config.proxySecret,
  };
  const read = await fetch(url + "/api/snapshot", { headers });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.equal(reads, 1);
  assert.equal(
    (await fetch(url + "/api/snapshot", { method: "POST", headers })).status,
    405,
  );
  assert.equal(
    (await fetch(url + "/api/execute/DeployStack", { headers })).status,
    404,
  );
  assert.equal((await fetch(url + "/healthz")).status, 200);
});

test("permission revocation evicts old cached data instead of serving it stale", async () => {
  const p = new Providers(loadConfig(live));
  await p.cached("forge:private", async () => ({ private: "data" }));
  (p as unknown as { cache: Map<string, { at: number }> }).cache.get(
    "forge:private",
  )!.at = 0;
  await assert.rejects(
    p.cached("forge:private", async () => {
      throw new ProviderError("Forgejo", 403);
    }),
  );
  assert.ok(
    !(p as unknown as { cache: Map<string, unknown> }).cache.has(
      "forge:private",
    ),
  );
});

test("work_env uses exactly test|prod and rejects the retired toggle", () => {
  assert.equal(loadConfig({ work_env: "test" }).workEnv, "test");
  assert.equal(loadConfig(live).workEnv, "prod");
  for (const work_env of ["production", "development", "TEST", "", "false"]) {
    assert.throws(() => loadConfig({ work_env }));
  }
  assert.throws(
    () => loadConfig({ work_env: "test", DASHBOARD_DEMO: "true" }),
    /replaced by work_env/,
  );
  assert.throws(() => loadConfig({ work_env: "prod" }), /work_env=prod/);
});

// All credentials and identities in this test are synthetic, intentionally unused fixtures.
test("test work environment ignores live settings and never calls upstream APIs", async () => {
  const config = loadConfig({
    ...live,
    work_env: "test",
    DASHBOARD_PROJECTS_JSON: "invalid production configuration",
    DASHBOARD_TERMINAL_ENABLED: "true",
    DASHBOARD_TERMINAL_USERS: "production-operator",
    KOMODO_API_KEY: "production-key",
    KOMODO_API_SECRET: "production-secret",
  });
  assert.deepEqual(config.projects, []);
  assert.deepEqual(config.terminalUsers, []);
  assert.equal(config.terminalEnabled, false);
  for (const key of [
    "forgejo",
    "forgejoToken",
    "komodo",
    "komodoKey",
    "komodoSecret",
    "proxySecret",
  ] as const) {
    assert.equal(config[key], "");
  }
  const providers = new Providers(config);
  providers.request = async () => {
    throw new Error("Test environment must not contact upstream APIs");
  };
  const snapshot = await providers.snapshot("test-viewer");
  assert.equal(snapshot.workEnv, "test");
  assert.equal(snapshot.projects[0].repository, "example/odoo-addons");
  assert.equal(snapshot.projects[0].id, "sample");
  assert.ok(
    snapshot.projects.flatMap((p) => p.environments).every((e) => !e.terminal),
  );
  assert.ok(
    snapshot.projects[0].environments[0].commits.every((c) =>
      /Example$/.test(c.author),
    ),
  );
  const fixtures = JSON.stringify([
    snapshot,
    await providers.logs("sample", "staging", "runtime"),
  ]);
  for (const value of [
    "production-operator",
    "production-key",
    "production-secret",
    "forge-token",
    "read-secret",
    "forge.example",
  ])
    assert.ok(!fixtures.includes(value));
});

test("terminal permission denial is reported to the page without exposing upstream details", async (t) => {
  for (const phase of ["before-login", "after-login", "http-denied"]) {
    await t.test(phase, async (t) => {
      const upstreamServer = createServer();
      const upstream = new WebSocketServer({ noServer: true });
      upstreamServer.on("upgrade", (req, socket, head) => {
        if (phase === "http-denied") {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        upstream.handleUpgrade(req, socket, head, (ws) => {
          ws.once("message", (data) => {
            assert.deepEqual(JSON.parse(data.toString()), {
              type: "ApiKeys",
              params: { key: "read-key", secret: "read-secret" },
            });
            if (phase === "after-login") ws.send("LOGGED_IN");
            ws.send(
              "ERROR: User does not have required Terminal permission; internal-sensitive-details",
            );
          });
        });
      });
      upstreamServer.listen(0, "127.0.0.1");
      await once(upstreamServer, "listening");
      const c = loadConfig({
        ...live,
        KOMODO_URL: `http://127.0.0.1:${(upstreamServer.address() as { port: number }).port}`,
        DASHBOARD_TERMINAL_ENABLED: "true",
        DASHBOARD_TERMINAL_USERS: "alice",
      });
      const server = createServer();
      const relay = installTerminal(server, c, new Providers(c));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const ws = new WebSocket(
        `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/terminal?project=example&environment=staging`,
        {
          origin: c.origin,
          headers: {
            "x-dashboard-user": "alice",
            "x-dashboard-proxy-secret": c.proxySecret,
          },
        },
      );
      t.after(() => {
        ws.terminate();
        relay.clients.forEach((s) => s.terminate());
        upstream.clients.forEach((s) => s.terminate());
        relay.close();
        upstream.close();
        server.close();
        upstreamServer.close();
      });
      const messages: { type: string; message?: string }[] = [];
      ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
      await once(ws, "close");
      const error = messages.find((m) => m.type === "error");
      assert.match(
        error?.message ?? "",
        /denied terminal access.*Terminal permission/,
      );
      assert.ok(
        !JSON.stringify(messages).includes("internal-sensitive-details"),
      );
      assert.ok(!JSON.stringify(messages).includes("read-secret"));
    });
  }
});

test("Komodo query encoding preserves nested keys while isolating special characters in values", () => {
  const command = "/bin/bash -lc 'echo [ok] & printf hello'";
  const query = terminalQuery({
    "target[type]": "Stack",
    "target[params][stack]": "stack & other",
    "init[mode]": "exec",
    "init[command]": command,
  });
  assert.match(query, /target\[params\]\[stack\]=stack%20%26%20other/);
  assert.ok(!query.includes("target%5B"));
  assert.ok(query.includes("%5Bok%5D"));
  const parsed = new URLSearchParams(query);
  assert.equal(parsed.get("init[command]"), command);
  assert.equal(parsed.get("init[mode]"), "exec");
  assert.equal(parsed.size, 4);
  assert.match(
    terminalFailureMessage(400),
    /connection parameters \(HTTP 400\)/,
  );
});
