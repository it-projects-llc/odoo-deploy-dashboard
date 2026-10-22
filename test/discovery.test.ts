import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.ts";
import { Providers, ProviderError } from "../server/providers.ts";
import { discoveredProject } from "../server/discovery.ts";
import { canTerminal } from "../server/auth.ts";
const live = {
  work_env: "prod",
  DASHBOARD_SESSION_SECRET: "s".repeat(40),
  KOMODO_URL: "https://komodo.example",
  FORGEJO_URL: "https://forge.example",
  FORGEJO_TOKEN: "read-token",
};
const stack = (id: string, provider = "forge.example") => ({
  id,
  name: `Stack ${id}`,
  info: {
    repo: "example/deployments",
    branch: "main",
    git_provider: provider,
    services: [{ service: "app", image: "odoo:19.0" }],
  },
});
function mock(p: Providers, visible: () => ReturnType<typeof stack>[]) {
  const calls: { provider: string; path: string; body: any }[] = [];
  p.request = async (provider, path, body) => {
    calls.push({ provider, path, body });
    if (path === "/read/ListStacks") {
      const page = (body as { page: number }).page;
      return visible().slice(page * 100, (page + 1) * 100);
    }
    if (path === "/read/GetStack") {
      const id = (body as { stack: string }).stack;
      if (!visible().some((s) => s.id === id))
        throw new ProviderError("Komodo", 403);
      return {
        _id: { $oid: id },
        config: {
          links: ["https://odoo.example/"],
          environment: "DB_PASSWORD=private-secret",
        },
        info: {
          deployed_hash: "deployed-sha",
          deployed_contents: [{ contents: "PASSWORD=private-secret" }],
        },
      };
    }
    if (path === "/read/ListStackServices")
      return [{ service: "app", state: "Running", image: "odoo:19.0" }];
    if (path === "/read/ListUpdates") return { updates: [] };
    if (path === "/read/GetStackLog")
      return { stdout: "Application ready", stderr: "" };
    if (provider === "Forgejo") return [];
    throw new Error("Unexpected mock request");
  };
  return calls;
}
test("production starts with automatic discovery and no project JSON", () => {
  const config = loadConfig(live);
  assert.equal(config.autoDiscover, true);
  assert.deepEqual(config.projects, []);
  assert.throws(
    () => loadConfig({ ...live, DASHBOARD_AUTO_DISCOVER: "false" }),
    /at least one project/,
  );
  assert.equal(
    loadConfig({ work_env: "test", DASHBOARD_AUTO_DISCOVER: "true" })
      .autoDiscover,
    false,
  );
});
test("discovery retrieves every page, uses stable IDs and makes no false stage or application claims", async () => {
  const c = loadConfig(live),
    p = new Providers(c, "alice-token");
  let visible = Array.from({ length: 101 }, (_, i) => stack(`s${i}`));
  const calls = mock(p, () => visible);
  const snapshot = await p.snapshot("alice");
  assert.equal(snapshot.projects.length, 101);
  assert.equal(snapshot.stale, false);
  assert.deepEqual(
    calls.filter((c) => c.path === "/read/ListStacks").map((c) => c.body.page),
    [0, 1],
  );
  const first = snapshot.projects[0],
    e = first.environments[0];
  assert.equal(first.sourceKind, "infrastructure");
  assert.equal(e.stage, "Unknown");
  assert.equal(e.version, "Unknown");
  assert.equal(e.terminalService, "app");
  assert.equal(e.url, "https://odoo.example/");
  assert.equal(e.health, "running");
  assert.ok(!JSON.stringify(snapshot).includes("private-secret"));
  assert.ok(!JSON.stringify(snapshot).includes("alice-token"));
  assert.ok(!calls.some((c) => c.path.includes("/branches?")));
  const stable = first.id;
  visible = [stack("s0")];
  visible[0].name = "Renamed";
  assert.equal((await p.snapshot("alice")).projects[0].id, stable);
});
test("each user sees their own inventory and revoked membership blocks direct logs before Forgejo access", async () => {
  const root = new Providers(loadConfig(live)),
    a = root.forSession("alice-token"),
    b = root.forSession("bob-token");
  let visible = [stack("allowed")];
  const calls = mock(a, () => visible);
  mock(b, () => [stack("other")]);
  const sa = await a.snapshot("alice"),
    sb = await b.snapshot("bob");
  assert.notEqual(sa.projects[0].id, sb.projects[0].id);
  const id = sa.projects[0].id;
  await a.authorizedMapping(id, "instance");
  assert.equal(
    (await a.logs(id, "instance", "runtime")).entries[0].text,
    "Application ready",
  );
  const before = calls.filter((c) => c.provider === "Forgejo").length;
  visible = [];
  await assert.rejects(a.authorizedMapping(id, "instance"), /403/);
  assert.equal(calls.filter((c) => c.provider === "Forgejo").length, before);
  assert.deepEqual((await a.snapshot("alice")).projects, []);
});
test("stacks without a matching Forgejo repository remain visible and never fetch a guessed repo", async () => {
  const p = new Providers(loadConfig(live), "alice-token");
  const calls = mock(p, () => [
    stack("external", "github.com"),
    {
      ...stack("no-source"),
      info: { repo: "", branch: "", git_provider: "", services: [] },
    },
  ]);
  const snapshot = await p.snapshot("alice");
  assert.equal(snapshot.projects.length, 2);
  assert.ok(
    snapshot.projects.every((p) => !p.repoUrl && p.sourceKind === "none"),
  );
  assert.ok(!calls.some((c) => c.provider === "Forgejo"));
});
test("manual overrides replace their matching stack while other visible stacks are still discovered", async () => {
  const config = loadConfig({
    ...live,
    DASHBOARD_PROJECTS_JSON: JSON.stringify([
      {
        id: "custom",
        name: "Custom",
        repository: "example/addons",
        infraRepository: "example/deployments",
        environments: [
          {
            id: "staging",
            name: "Staging",
            branch: "staging",
            stage: "Staging",
            stack: "Stack s1",
          },
        ],
      },
    ]),
  });
  const p = new Providers(config, "alice-token");
  const calls = mock(p, () => [stack("s1"), stack("s2")]);
  // Explicit stack names are accepted by Komodo, like IDs.
  const request = p.request.bind(p);
  p.request = async (provider, path, body, text) =>
    path === "/read/GetStack" && (body as any).stack === "Stack s1"
      ? { _id: { $oid: "s1" }, info: {} }
      : request(provider, path, body, text);
  const snapshot = await p.snapshot("alice");
  assert.equal(snapshot.projects.length, 2);
  assert.equal(snapshot.projects[0].id, "custom");
  assert.equal(snapshot.projects[0].environments[0].stage, "Staging");
  assert.equal(snapshot.projects[1].name, "Stack s2");
  assert.ok(calls.some((c) => c.path.includes("/branches?")));
});
test("failed discovery clears stale membership and concurrent refreshes share one request", async () => {
  const p = new Providers(loadConfig(live), "alice-token");
  let release!: () => void;
  let calls = 0;
  p.request = async () => {
    calls++;
    await new Promise<void>((r) => (release = r));
    return [stack("one")];
  };
  const a = p.discover(),
    b = p.discover();
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.ok(
    p.mapping(discoveredProject(p.config, stack("one"))!.id, "instance"),
  );
  p.request = async () => {
    throw new ProviderError("Komodo", 500);
  };
  await assert.rejects(p.discover());
  assert.throws(
    () => p.mapping(discoveredProject(p.config, stack("one"))!.id, "instance"),
    /Unknown/,
  );
});
test("unknown stages require the production terminal switch and services must be unambiguous", () => {
  const config = loadConfig({ ...live, DASHBOARD_TERMINAL_ENABLED: "true" });
  const project = discoveredProject(config, stack("one"))!,
    e = project.environments[0];
  assert.equal(canTerminal(config, "alice", e), false);
  assert.equal(
    canTerminal({ ...config, terminalProduction: true }, "alice", e),
    true,
  );
  const unknown = discoveredProject(config, {
    ...stack("two"),
    info: { services: [{ service: "db" }, { service: "cache" }] },
  })!;
  assert.equal(unknown.environments[0].terminal, false);
  assert.equal(
    discoveredProject(config, stack("../secret"))!.environments[0].stack,
    "../secret",
  );
  const traversal = discoveredProject(config, {
    ...stack("three"),
    info: { repo: "../secret", git_provider: "forge.example" },
  })!;
  assert.equal(traversal.repository, "");
});
