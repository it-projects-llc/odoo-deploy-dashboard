import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.ts";
import { Providers, ProviderError } from "../server/providers.ts";
import { testSnapshot } from "../server/fixtures.ts";

function provider() {
  const config = loadConfig({
    work_env: "prod",
    DASHBOARD_SESSION_SECRET: "s".repeat(40),
    DASHBOARD_AUTO_DISCOVER: "false",
    KOMODO_URL: "https://komodo.example",
    FORGEJO_URL: "https://forge.example",
    FORGEJO_TOKEN: "fixture-token",
    DASHBOARD_PROJECTS_JSON: JSON.stringify([
      {
        id: "sample",
        name: "Sample",
        repository: "example/addons",
        infraRepository: "example/infra",
        environments: [
          {
            id: "staging",
            name: "Staging",
            branch: "19.0-staging",
            stage: "Staging",
            stack: "sample-stack",
          },
        ],
      },
    ]),
  });
  config.cacheMs = 0;
  const p = new Providers(config);
  let failure: (name: string, path: string) => void = () => {};
  p.request = async (name, path) => {
    failure(name, path);
    if (path === "/read/GetStack") return { _id: { $oid: "sample-stack" } };
    if (path === "/read/ListStackServices")
      return [{ service: "odoo", state: "Running", image: "odoo:19.0" }];
    if (path === "/read/ListUpdates") return { updates: [] };
    if (path.includes("/branches?")) return [];
    if (path.includes("/commits?"))
      return [
        {
          sha: "abc",
          commit: {
            message: "Update modules",
            author: { name: "Example", date: "2026-10-22" },
          },
        },
      ];
    if (path.endsWith("/status"))
      return { statuses: [{ context: "Tests", status: "success" }] };
    if (path.includes("/actions/runs?")) return { workflow_runs: [] };
    throw new Error("Unexpected mock request");
  };
  return {
    p,
    fail: (fn: typeof failure) => {
      failure = fn;
    },
  };
}

test("provider cards receive safe HTTP diagnostics for commit-check and service failures", async () => {
  const { p, fail } = provider();
  fail((name, path) => {
    if (path.endsWith("/status")) throw new ProviderError(name, 500);
    if (path === "/read/ListStackServices") throw new ProviderError(name, 403);
  });
  const snapshot = await p.snapshot("example");
  for (const [name, code] of [
    ["Forgejo", 500],
    ["Komodo", 403],
  ] as const) {
    const state = snapshot.providers.find((p) => p.name === name)!;
    assert.equal(state.state, "unavailable");
    assert.ok(state.issues?.some((issue) => issue.includes(`HTTP ${code}`)));
    assert.ok(state.issues?.every((issue) => issue.startsWith(`${name}:`)));
  }
  assert.equal(snapshot.projects[0].environments[0].commits.length, 1);
});

test("cached fallback retains the HTTP failure and a successful refresh clears it", async () => {
  const { p, fail } = provider();
  assert.equal((await p.snapshot("example")).stale, false);
  fail((name) => {
    if (name === "Forgejo") throw new ProviderError(name, 500);
  });
  const stale = await p.snapshot("example");
  assert.equal(
    stale.providers.find((p) => p.name === "Forgejo")?.state,
    "unavailable",
  );
  assert.ok(
    stale.providers
      .find((p) => p.name === "Forgejo")
      ?.issues?.some((issue) => issue.includes("HTTP 500")),
  );
  assert.equal(
    stale.providers.find((p) => p.name === "Komodo")?.state,
    "connected",
  );
  assert.equal(stale.projects[0].environments[0].commits.length, 1);
  fail(() => {});
  const recovered = await p.snapshot("example");
  assert.equal(recovered.stale, false);
  assert.ok(
    recovered.providers.every(
      (p) => p.state === "connected" && !p.issues?.length,
    ),
  );
});

test("connection and invalid-response diagnostics stay useful without leaking error bodies", async () => {
  const { p, fail } = provider();
  fail((name, path) => {
    if (path.includes("/actions/runs?"))
      throw new ProviderError(name, 502, "connection");
    if (path === "/read/ListStackServices")
      throw new ProviderError(name, 502, "response");
  });
  const snapshot = await p.snapshot("example");
  assert.match(
    snapshot.providers.find((p) => p.name === "Forgejo")!.issues!.join(" "),
    /could not connect/,
  );
  assert.match(
    snapshot.providers.find((p) => p.name === "Komodo")!.issues!.join(" "),
    /invalid API response/,
  );
  fail((_, path) => {
    if (path === "/read/ListStackServices")
      throw new Error("secret-token=never-expose");
  });
  const generic = await p.snapshot("example");
  assert.ok(generic.providers.find((p) => p.name === "Komodo")?.issues?.length);
  assert.ok(!JSON.stringify(generic).includes("never-expose"));
});

test("an integration with no applicable resources is not reported as healthy", async () => {
  const config = loadConfig({
    work_env: "prod",
    DASHBOARD_SESSION_SECRET: "s".repeat(40),
    KOMODO_URL: "https://komodo.example",
    FORGEJO_URL: "https://forge.example",
    FORGEJO_TOKEN: "fixture-token",
  });
  const p = new Providers(config);
  p.request = async (name, path) => {
    assert.equal(name, "Komodo");
    assert.equal(path, "/read/ListStacks");
    return [];
  };
  const snapshot = await p.snapshot("example");
  assert.equal(
    snapshot.providers.find((p) => p.name === "Forgejo")?.state,
    "unchecked",
  );
  assert.equal(
    snapshot.providers.find((p) => p.name === "Komodo")?.state,
    "connected",
  );
});

test("sample data exercises healthy and degraded integrations together", () => {
  const snapshot = testSnapshot();
  assert.equal(snapshot.workEnv, "test");
  assert.equal(snapshot.stale, true);
  assert.equal(
    snapshot.providers.find((p) => p.name === "Forgejo")?.state,
    "connected",
  );
  const failed = snapshot.providers.find((p) => p.name === "Komodo")!;
  assert.equal(failed.state, "unavailable");
  assert.match(failed.issues!.join(" "), /HTTP 500/);
});

test("one failed provider does not mark the other unhealthy, and recovery clears the error", async () => {
  const { p, fail } = provider();
  fail((name, path) => {
    if (path === "/read/ListStackServices") throw new ProviderError(name, 500);
  });
  const snapshot = await p.snapshot("example");
  assert.equal(
    snapshot.providers.find((p) => p.name === "Forgejo")?.state,
    "connected",
  );
  assert.deepEqual(
    snapshot.providers.find((p) => p.name === "Forgejo")?.issues,
    [],
  );
  assert.equal(
    snapshot.providers.find((p) => p.name === "Komodo")?.state,
    "unavailable",
  );
  assert.match(
    snapshot.providers.find((p) => p.name === "Komodo")!.issues!.join(" "),
    /HTTP 500/,
  );
  fail(() => {});
  const recovered = await p.snapshot("example");
  assert.equal(recovered.stale, false);
  assert.ok(
    recovered.providers.every(
      (p) => p.state === "connected" && !p.issues?.length,
    ),
  );
});
