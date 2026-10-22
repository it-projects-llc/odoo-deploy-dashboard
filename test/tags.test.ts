import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.ts";
import { Providers, ProviderError } from "../server/providers.ts";
import { discoveredProject } from "../server/discovery.ts";
const config = () =>
  loadConfig({
    work_env: "prod",
    DASHBOARD_SESSION_SECRET: "s".repeat(40),
    KOMODO_URL: "https://komodo.example",
    FORGEJO_URL: "https://forge.example",
    FORGEJO_TOKEN: "read-token",
  });
function fixture() {
  const p = new Providers(config(), "user-token"),
    names = new Map<string, string>();
  const tagged = (
    id: string,
    branch: string,
    stage?: string,
    project = "sample",
    repo = "example/addons",
  ) => {
    const tags = [
      `odoo.project=${project}`,
      `odoo.repository=${repo}`,
      `odoo.branch=${branch}`,
      "odoo.version=19.0",
      "odoo.service=odoo",
      ...(stage ? [`odoo.stage=${stage}`] : []),
    ].map((name, i) => {
      const key = `${id}-tag-${i}`;
      names.set(key, name);
      return key;
    });
    return {
      id,
      name: `Odoo ${id}`,
      tags,
      info: {
        repo: "example/infra",
        branch: "19.0",
        git_provider: "forge.example",
        services: [{ service: "odoo", image: "odoo:19.0" }],
      },
    };
  };
  const state = {
    items: [
      tagged("prod", "19.0", "production"),
      tagged("stage", "19.0-staging", "staging"),
      tagged("dev", "feature/search"),
    ],
    branches: ["19.0", "19.0-staging", "feature/search", "feature/unbuilt"],
    failTags: false,
  };
  const calls: { provider: string; path: string; body: any }[] = [];
  p.request = async (provider, path, body) => {
    calls.push({ provider, path, body });
    if (path === "/read/ListStacks")
      return (body as any).page === 0 ? state.items : [];
    if (path === "/read/ListTags") {
      if (state.failTags) throw new ProviderError("Komodo", 403);
      return [...names].map(([id, name]) => ({ _id: { $oid: id }, name }));
    }
    if (path === "/read/GetStack") {
      const id = (body as any).stack;
      if (!state.items.some((s) => s.id === id))
        throw new ProviderError("Komodo", 403);
      return {
        _id: { $oid: id },
        config: { environment: "TOKEN=never-return" },
        info: { deployed_hash: "infra-sha" },
      };
    }
    if (path === "/read/ListStackServices")
      return [{ service: "odoo", image: "odoo:19.0", state: "Running" }];
    if (path === "/read/ListUpdates") return { updates: [] };
    if (provider === "Forgejo") {
      if (path.includes("/branches?")) {
        const url = new URL(path, "https://forge.example");
        const page = Number(url.searchParams.get("page"));
        return state.branches
          .slice((page - 1) * 100, page * 100)
          .map((name) => ({ name }));
      }
      return [];
    }
    throw new Error("Unexpected request");
  };
  return { p, state, calls, names, tagged };
}
test("native tag IDs group application stacks and classify only explicit production/staging roles", async () => {
  const f = fixture(),
    snapshot = await f.p.snapshot("alice");
  assert.equal(snapshot.projects.length, 1);
  const project = snapshot.projects[0];
  assert.equal(project.name, "sample");
  assert.equal(project.repository, "example/addons");
  assert.equal(project.sourceKind, "application");
  assert.deepEqual(
    project.environments.map((e) => [e.branch, e.stage, e.stack]),
    [
      ["19.0", "Production", "prod"],
      ["19.0-staging", "Staging", "stage"],
      ["feature/search", "Development", "dev"],
      ["feature/unbuilt", "Development", undefined],
    ],
  );
  assert.equal(project.environments[3].health, "not deployed");
  assert.equal(project.environments[3].terminal, false);
  assert.equal(project.environments[0].version, "19.0");
  assert.ok(
    f.calls.some((c) =>
      c.path.includes("/repos/example/addons/commits?sha=19.0-staging"),
    ),
  );
  assert.ok(
    !f.calls.some((c) => c.path.includes("/repos/example/infra/commits")),
  );
  assert.equal(
    (await f.p.authorizedMapping(project.id, project.environments[1].id)).e
      .infraBranch,
    "19.0",
  );
  assert.ok(!JSON.stringify(snapshot).includes("never-return"));
});
test("every application branch is listed across pages, beyond the manual discovery limit", async () => {
  const f = fixture();
  f.state.branches = Array.from({ length: 101 }, (_, i) => `feature/${i}`);
  const snapshot = await f.p.snapshot("alice"),
    project = snapshot.projects[0];
  assert.equal(project.environments.length, 104);
  assert.deepEqual(
    f.calls
      .filter((c) => c.path.includes("/branches?"))
      .map((c) =>
        new URL(c.path, "https://forge.example").searchParams.get("page"),
      ),
    ["1", "2"],
  );
  const last = project.environments.at(-1)!;
  assert.equal(last.branch, "feature/100");
  assert.equal(last.stage, "Development");
  assert.equal(
    (await f.p.authorizedMapping(project.id, last.id)).e.branch,
    "feature/100",
  );
});
test("losing the last stack removes grouped project and blocks old branch URLs before Forgejo reads", async () => {
  const f = fixture(),
    snapshot = await f.p.snapshot("alice"),
    project = snapshot.projects[0],
    branch = project.environments.at(-1)!;
  f.state.items = [];
  const before = f.calls.filter((c) => c.provider === "Forgejo").length;
  await assert.rejects(f.p.authorizedMapping(project.id, branch.id), /403/);
  assert.equal(f.calls.filter((c) => c.provider === "Forgejo").length, before);
  assert.deepEqual((await f.p.snapshot("alice")).projects, []);
});
test("tag conflicts and unresolved tag IDs cannot turn a production resource into a development shell", async () => {
  for (const mode of ["conflict", "missing", "failure"]) {
    const f = fixture();
    f.state.items = [f.state.items[0]];
    if (mode === "conflict") {
      f.names.set("conflict", "odoo.stage=staging");
      f.state.items[0].tags.push("conflict");
    }
    if (mode === "missing") f.state.items[0].tags.push("unknown-id");
    if (mode === "failure") f.state.failTags = true;
    const snapshot = await f.p.snapshot("alice");
    assert.equal(snapshot.projects[0].sourceKind, "infrastructure");
    assert.equal(snapshot.projects[0].environments[0].stage, "Unknown");
    assert.ok(!f.calls.some((c) => c.path.includes("/repos/example/addons/")));
  }
});
test("a shared project tag cannot merge different application repositories", async () => {
  const f = fixture();
  f.state.items = [
    f.state.items[0],
    f.tagged("other", "main", "production", "sample", "example/other-addons"),
  ];
  const snapshot = await f.p.snapshot("alice");
  assert.equal(snapshot.projects.length, 2);
  assert.notEqual(snapshot.projects[0].id, snapshot.projects[1].id);
});
test("branch and service tags override infrastructure metadata; unsafe or missing application branches are never inferred", () => {
  const item = {
    id: "one",
    name: "Odoo",
    info: {
      branch: "19.0",
      repo: "example/infra",
      git_provider: "forge.example",
      services: [],
    },
  };
  const base = ["odoo.project=sample", "odoo.repository=example/addons"];
  const missing = discoveredProject(config(), item, [
    ...base,
    "odoo.stage=production",
  ])!;
  assert.equal(missing.environments[0].branch, "Unknown");
  assert.match(missing.environments[0].metadataIssue!, /branch tag is missing/);
  const dev = discoveredProject(config(), item, [
    ...base,
    "odoo.branch=feature/upgrade",
    "odoo.stage=qa",
    "odoo.service=web",
  ])!;
  assert.equal(dev.environments[0].stage, "Development");
  assert.equal(dev.environments[0].terminalService, "web");
  const invalid = discoveredProject(config(), item, [
    ...base,
    "odoo.branch=../secrets",
  ])!;
  assert.equal(invalid.sourceKind, "infrastructure");
  assert.equal(invalid.environments[0].stage, "Unknown");
});

test("OCA development branches infer version from the leading series in snapshots and direct mappings", async () => {
  const f = fixture();
  f.state.branches = [
    "19.0",
    "19.0-staging",
    "19.0-ci-improvs",
    "19.0-ci-cloud-port",
    "18.0-dev",
    "feature/no-version",
  ];
  const project = (await f.p.snapshot("alice")).projects[0];
  for (const [name, version] of [
    ["19.0-ci-improvs", "19.0"],
    ["19.0-ci-cloud-port", "19.0"],
    ["18.0-dev", "18.0"],
    ["feature/no-version", "Unknown"],
  ]) {
    const env = project.environments.find((e) => e.branch === name)!;
    assert.equal(env.stage, "Development");
    assert.equal(env.version, version);
    assert.equal(
      (await f.p.authorizedMapping(project.id, env.id)).e.version,
      version,
    );
  }
  const item = {
    id: "dev",
    name: "Development",
    info: { branch: "19.0", services: [] },
  };
  const base = [
    "odoo.project=sample",
    "odoo.repository=example/addons",
    "odoo.branch=18.0-feature",
  ];
  assert.equal(
    discoveredProject(config(), item, base)!.environments[0].version,
    "18.0",
  );
  assert.equal(
    discoveredProject(config(), item, [...base, "odoo.version=19.0"])!
      .environments[0].version,
    "19.0",
  );
  assert.equal(
    discoveredProject(config(), item, [
      "odoo.project=sample",
      "odoo.repository=example/addons",
      "odoo.branch=19.0invalid",
    ])!.environments[0].version,
    "Unknown",
  );
});
