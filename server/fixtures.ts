import { createHash } from "node:crypto";
import type {
  Snapshot,
  Environment,
  Commit,
  Attempt,
  Logs,
  Result,
} from "../src/types.ts";
const now = Date.now();
const date = (minutes: number) =>
  new Date(now - minutes * 60_000).toISOString();
const sha = (i: number) =>
  createHash("sha1").update(`sample-commit-${i}`).digest("hex");
const infraSha = (i: number) =>
  createHash("sha1").update(`sample-infrastructure-${i}`).digest("hex");
function commits(state: Result): Commit[] {
  return [
    "[IMP] Improve search filters",
    "[FIX] Handle empty configuration",
    "Merge pull request #42: application refinements",
    "[IMP] Refresh application dependencies",
    "[REF] Simplify module initialization",
  ].map((message, i) => ({
    sha: sha(i),
    message,
    author: i === 3 ? "Sam Example" : "Alex Example",
    date: date(26 + i * 130),
    result: i === 0 ? state : i === 2 ? "failed" : "passed",
    checks: [
      { name: "ci / build-images", state: "passed" },
      {
        name: "ci / test-odoo",
        state: i === 0 ? state : i === 2 ? "failed" : "passed",
        description:
          i === 2
            ? "One test failed during module installation"
            : "Module test suite",
      },
      { name: "ci / scan-image", state: "passed" },
    ],
  }));
}
function attempts(id: string): Attempt[] {
  return Array.from({ length: 4 }, (_, i) => ({
    id: `${id}-attempt-${i}`,
    state: i === 1 ? "failed" : "passed",
    date: date(35 + i * 160),
    end: date(33 + i * 160),
    operation: "DeployStack",
    actor: "deployment-bot",
    infraSha: infraSha(i),
  }));
}
const image =
  "registry.example.com/example/odoo@sha256:" + "a1b2c3d4".repeat(8);
function env(
  id: string,
  name: string,
  stage: Environment["stage"],
  branch: string,
): Environment {
  return {
    id,
    name,
    stage,
    branch,
    version: "19.0",
    stack: `odoo-${id}`,
    health: "healthy",
    commits: commits(stage === "Staging" ? "warning" : "passed"),
    runs: [
      { id: 42, name: "ci", sha: sha(0), state: "passed", date: date(26) },
    ],
    attempts: attempts(id),
    services: [
      { name: "odoo", state: "Running", image },
      { name: "postgres", state: "Running", image: "postgres:16" },
      { name: "migrate", state: "Exited", image },
      { name: "neutralize", state: "Exited", image },
    ],
    deployedInfraSha: infraSha(0),
    desiredImage: image,
    deployedImage: image,
    observedImage: image,
    terminal: false,
    issues: [],
  };
}
export function testSnapshot(): Snapshot {
  return {
    workEnv: "test",
    fetchedAt: new Date().toISOString(),
    stale: true,
    pollMs: 15000,
    terminalEnabled: false,
    providers: [
      {
        name: "Forgejo",
        state: "connected",
        checkedAt: new Date().toISOString(),
        issues: [],
      },
      {
        name: "Komodo",
        state: "unavailable",
        checkedAt: date(5),
        issues: [
          "Komodo: Stack services failed (HTTP 500). Check provider availability and API compatibility.",
        ],
      },
    ],
    projects: [
      {
        id: "sample",
        name: "Example project",
        repository: "example/odoo-addons",
        environments: [
          env("prod", "production", "Production", "main"),
          env("staging", "staging", "Staging", "staging"),
          {
            ...env(
              "feature",
              "search-filters",
              "Development",
              "feature/search-filters",
            ),
            stack: undefined,
            health: "not deployed",
            services: [],
            attempts: [],
            desiredImage: undefined,
            deployedImage: undefined,
            observedImage: undefined,
            deployedInfraSha: undefined,
          },
        ],
      },
    ],
  };
}
export function testLogs(source: string): Logs {
  const runtime = Array.from({ length: 55 }, (_, i) => ({
    stage: "odoo",
    text: `${new Date(now - (55 - i) * 1200).toISOString()} ${i === 22 ? "WARNING" : "INFO"} odoo.${i === 22 ? "modules.module" : "http"}: ${i === 22 ? "Optional cache configuration is not set; using defaults." : "GET /web/health HTTP/1.1 200 - 42 0.012 0.038"}`,
  }));
  return {
    title:
      source === "runtime" ? "odoo · current container" : "Deployment output",
    fetchedAt: new Date().toISOString(),
    note: "Output is bounded to the selected log source.",
    entries:
      source === "runtime"
        ? runtime
        : [
            {
              stage: "pre-deploy",
              text: "Backing up database…\nRestored rehearsal copy.\nMigration rehearsal completed.",
              success: true,
            },
            {
              stage: "compose up",
              text: "postgres  Healthy\nmigrate  Exited (0)\nneutralize  Exited (0)\nkeep-neutralized  Exited (0)\nodoo  Started",
              success: true,
            },
            {
              stage: "post-deploy",
              text: "Deployment finished successfully.",
              success: true,
            },
          ],
  };
}
