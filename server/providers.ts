import {
  discoveredProject,
  stackLink,
  validBranch,
  branchOdooVersion,
} from "./discovery.ts";
import type { Config, ProjectConfig, EnvironmentConfig } from "./config.ts";
import type {
  Snapshot,
  Environment,
  Commit,
  Run,
  Logs,
  LogEntry,
  ProviderState,
} from "../src/types.ts";
import {
  aggregate,
  result,
  iso,
  normalizeAttempt,
  imageFromFile,
  safeUrl,
  cleanLog,
} from "./normalize.ts";
import { canTerminal } from "./auth.ts";
import { testSnapshot, testLogs } from "./fixtures.ts";
// These adapters intentionally never return raw provider configurations.
type Obj = Record<string, any>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const array = (v: unknown): Obj[] =>
  Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
export class ProviderError extends Error {
  constructor(
    public provider: string,
    public status: number,
    public kind: "http" | "connection" | "response" = "http",
  ) {
    super(
      `${provider} request unavailable (HTTP ${status}). Check permissions and installed API support.`,
    );
  }
}
// Only fixed diagnostics are returned: upstream bodies may contain secrets.
export function providerDiagnostic(
  error: unknown,
  operation = "Provider read",
) {
  if (!(error instanceof ProviderError))
    return `${operation} failed. Check provider availability and configuration.`;
  const prefix = `${error.provider}: ${operation}`;
  if (error.kind === "connection")
    return `${prefix} could not connect. Check the provider URL, DNS, TLS certificate, and network access from the dashboard container.`;
  if (error.kind === "response")
    return `${prefix} returned an invalid API response. Check the provider base URL and reverse-proxy routing.`;
  if (error.status === 401)
    return `${prefix} was rejected (HTTP 401). Check the current account or API credentials.`;
  if (error.status === 403)
    return `${prefix} was denied (HTTP 403). Check the current account's resource permissions.`;
  if (operation === "Stack access check")
    return `${prefix} failed (HTTP ${error.status}). Check that each configured stack name or ID exists in Komodo and that the account can read it.`;
  return `${prefix} failed (HTTP ${error.status}). Check provider availability and API compatibility.`;
}
export class Providers {
  private cache = new Map<
    string,
    { value: unknown; at: number; bytes: number }
  >();
  private cacheBytes = 0;
  private dropCache(key: string) {
    const old = this.cache.get(key);
    if (old) this.cacheBytes -= old.bytes;
    this.cache.delete(key);
    this.stale.delete(key);
    this.staleReasons.delete(key);
  }
  private pending = new Map<string, Promise<unknown>>();
  private stale = new Set<string>();
  private staleReasons = new Map<string, string>();
  private active = 0;
  private queue: (() => void)[] = [];
  private viewers = new Map<string, Providers>();
  private discovered: ProjectConfig[] = [];
  private discoveryIssues: string[] = [];
  private isDiscovered(project: ProjectConfig) {
    return this.discovered.some((p) => p.id === project.id);
  }
  private projects() {
    return [...this.config.projects, ...this.discovered];
  }
  private discoveryPending?: Promise<void>;
  async discover() {
    if (!this.config.autoDiscover || this.config.workEnv === "test") return;
    if (!this.discoveryPending)
      this.discoveryPending = this.loadDiscovery()
        .catch((error) => {
          this.discovered = [];
          throw error;
        })
        .finally(() => {
          this.discoveryPending = undefined;
        });
    return this.discoveryPending;
  }
  private async loadDiscovery() {
    // Fresh, caller-authenticated membership is required; do not serve stale discovery after revocation.
    const projects: ProjectConfig[] = [];
    const items: Obj[] = [];
    const seen = new Set<string>();
    this.discoveryIssues = [];
    for (let page = 0; page < 100; page++) {
      const raw = await this.request("Komodo", "/read/ListStacks", {
        query: {},
        page,
        limit: 100,
      });
      if (!Array.isArray(raw))
        throw new ProviderError("Komodo", 502, "response");
      items.push(...array(raw));
      if (raw.length < 100) {
        const tagIds = [
          ...new Set(
            items.flatMap((item) =>
              Array.isArray(item.tags)
                ? item.tags.filter(
                    (tag: unknown): tag is string => typeof tag === "string",
                  )
                : [],
            ),
          ),
        ];
        const names = new Map<string, string>();
        if (tagIds.length) {
          try {
            const tags = await this.request("Komodo", "/read/ListTags", {});
            if (!Array.isArray(tags))
              throw new ProviderError("Komodo", 502, "response");
            for (const tag of array(tags)) {
              const id = tag._id?.$oid ?? tag.id;
              if (typeof id === "string" && typeof tag.name === "string")
                names.set(id, tag.name);
            }
          } catch (error) {
            this.discoveryIssues.push(
              providerDiagnostic(error, "Odoo tag discovery"),
            );
          }
          if (tagIds.some((id) => !names.has(id)))
            this.discoveryIssues.push(
              "Some Komodo tag IDs could not be resolved. Resources with incomplete Odoo metadata remain unclassified.",
            );
        }
        for (const item of items) {
          if (typeof item.id !== "string" || seen.has(item.id)) continue;
          seen.add(item.id);
          const ids: string[] = Array.isArray(item.tags)
            ? item.tags.filter(
                (tag: unknown): tag is string => typeof tag === "string",
              )
            : [];
          // Missing tag names may conceal a conflicting stage; ignore all metadata for that stack.
          const resolved = ids.every((id) => names.has(id))
            ? ids.map((id) => names.get(id)!)
            : [];
          const project = discoveredProject(this.config, item, resolved);
          if (!project) continue;
          if (
            this.config.projects.some(
              (p) =>
                p.id === project.id ||
                p.environments.some(
                  (e) =>
                    e.stack === project.environments[0].stack ||
                    e.stack === item.name,
                ),
            )
          )
            continue;
          const group =
            project.sourceKind === "application"
              ? projects.find((p) => p.id === project.id)
              : undefined;
          if (group) group.environments.push(...project.environments);
          else projects.push(project);
        }
        this.discovered = projects;
        return;
      }
    }
    // Never silently truncate a large inventory or loop on an incompatible pagination response.
    throw new ProviderError("Komodo", 502, "response");
  }
  constructor(
    public config: Config,
    private jwt = "",
  ) {}
  forSession(jwt: string) {
    if (!jwt) return this;
    // Each login has its own provider cache. No response can cross user sessions.
    let provider = this.viewers.get(jwt);
    if (!provider) {
      while (this.viewers.size >= 16)
        this.viewers.delete(this.viewers.keys().next().value!);
      provider = new Providers(this.config, jwt);
      this.viewers.set(jwt, provider);
    }
    return provider;
  }
  async allowed(p: ProjectConfig, e?: EnvironmentConfig) {
    if (!this.jwt) return true;
    const targets = e?.stack ? [e] : p.environments.filter((e) => e.stack);
    for (const target of targets) {
      try {
        await this.request("Komodo", "/read/GetStack", { stack: target.stack });
        return true;
      } catch (error) {
        if (
          error instanceof ProviderError &&
          [401, 403, 404].includes(error.status)
        )
          continue;
        throw error;
      }
    }
    return false;
  }
  async authorizedMapping(project: string, environment: string) {
    await this.discover();
    const owner = this.projects().find((p) => p.id === project);
    if (
      owner &&
      environment.startsWith("branch-") &&
      this.isDiscovered(owner) &&
      owner.sourceKind === "application"
    ) {
      if (!(await this.allowed(owner))) throw new ProviderError("Komodo", 403);
      await this.applicationBranches(owner);
    }
    let mapping;
    try {
      mapping = this.mapping(project, environment);
    } catch {
      throw new ProviderError("Komodo", 403);
    }
    if (!(await this.allowed(mapping.p, mapping.e)))
      throw new ProviderError("Komodo", 403);
    return mapping;
  }
  async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const old = this.cache.get(key);
    if (old && Date.now() - old.at < this.config.cacheMs) return old.value as T;
    if (this.pending.has(key)) return this.pending.get(key) as Promise<T>;
    const promise = fn()
      .then((value) => {
        this.dropCache(key);
        const bytes = Buffer.byteLength(JSON.stringify(value) ?? "null");
        if (bytes <= 4_000_000) {
          while (
            this.cache.size >= (this.jwt ? 50 : 300) ||
            this.cacheBytes + bytes > (this.jwt ? 4_000_000 : 32_000_000)
          )
            this.dropCache(this.cache.keys().next().value!);
          this.cache.set(key, { value, at: Date.now(), bytes });
          this.cacheBytes += bytes;
        }
        return value;
      })
      .catch((error) => {
        if (
          error instanceof ProviderError &&
          [401, 403].includes(error.status)
        ) {
          this.dropCache(key);
          throw error;
        }
        if (old && this.cache.has(key)) {
          this.stale.add(key);
          this.staleReasons.set(key, providerDiagnostic(error));
          return old.value as T;
        }
        throw error;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  async request(
    provider: "Forgejo" | "Komodo",
    path: string,
    body?: unknown,
    text = false,
  ): Promise<any> {
    if (this.active >= 8) {
      if (this.queue.length >= 150)
        throw new Error("Provider request queue is full");
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      const c = this.config;
      const response = await fetch(
        (provider === "Forgejo" ? `${c.forgejo}/api/v1` : c.komodo) + path,
        {
          method: body ? "POST" : "GET",
          headers:
            provider === "Forgejo"
              ? {
                  Authorization: `token ${c.forgejoToken}`,
                  Accept: text ? "text/plain" : "application/json",
                }
              : {
                  "Content-Type": "application/json",
                  ...(this.jwt
                    ? { Authorization: this.jwt }
                    : {
                        "X-Api-Key": c.komodoKey,
                        "X-Api-Secret": c.komodoSecret,
                      }),
                },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        },
      );
      if (!response.ok) throw new ProviderError(provider, response.status);
      // Bound payloads before parsing. Do not follow signed external redirects with provider credentials.
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderError(provider, 502);
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 8_000_000)
            throw new ProviderError(provider, 502, "response");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const content = Buffer.concat(chunks).toString("utf8");
      try {
        return text ? content : JSON.parse(content);
      } catch {
        throw new ProviderError(provider, 502, "response");
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(provider, 502, "connection");
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
  forge(path: string) {
    return this.cached(`forge:${path}`, () => this.request("Forgejo", path));
  }
  read(name: string, body: Obj) {
    return this.cached(`komodo:${name}:${JSON.stringify(body)}`, () =>
      this.request("Komodo", `/read/${name}`, body),
    );
  }
  async applicationBranches(p: ProjectConfig): Promise<Obj[]> {
    return this.cached(`branches:${p.repository}`, async () => {
      const branches: Obj[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= 100; page++) {
        const raw = await this.forge(
          `/repos/${this.repo(p.repository)}/branches?limit=100&page=${page}`,
        );
        if (!Array.isArray(raw))
          throw new ProviderError("Forgejo", 502, "response");
        for (const b of array(raw))
          if (
            typeof b.name === "string" &&
            validBranch(b.name) &&
            !seen.has(b.name)
          ) {
            seen.add(b.name);
            branches.push({ name: b.name });
          }
        if (raw.length < 100) return branches;
      }
      throw new ProviderError("Forgejo", 502, "response");
    });
  }
  repo(repo: string) {
    return repo.split("/").map(encodeURIComponent).join("/");
  }
  async commits(
    p: ProjectConfig,
    e: EnvironmentConfig,
    page = 1,
  ): Promise<Commit[]> {
    if (!p.repository || !this.config.forgejo || e.branch === "Unknown")
      return [];
    const repo = this.repo(p.repository),
      base = `${this.config.forgejo}/${repo}`;
    const commits = array(
      await this.forge(
        `/repos/${repo}/commits?sha=${encodeURIComponent(e.branch)}&limit=10&page=${page}`,
      ),
    );
    return Promise.all(
      commits.map(async (raw) => {
        const sha = String(raw.sha ?? "");
        const c = obj(raw.commit),
          author = obj(c.author),
          account = obj(raw.author);
        let checks: Commit["checks"] = [];
        try {
          const statuses = obj(
            await this.forge(
              `/repos/${repo}/commits/${encodeURIComponent(sha)}/status`,
            ),
          );
          checks = array(statuses.statuses).map((s) => ({
            name: String(s.context ?? "Check"),
            state: result(s.status),
            url: safeUrl(s.target_url, this.config.forgejo),
            description: String(s.description ?? ""),
          }));
        } catch (error) {
          checks = [
            {
              name: "Commit statuses unavailable",
              state: "unknown",
              description: providerDiagnostic(error, "Commit checks"),
            },
          ];
        }
        return {
          sha,
          message: String(c.message ?? "No commit message").split("\n")[0],
          author: String(author.name ?? account.login ?? "Unknown"),
          date: iso(author.date ?? c.committer?.date),
          url: safeUrl(raw.html_url, base),
          checks,
          result: aggregate(checks.map((c) => c.state)),
        };
      }),
    );
  }
  async runs(p: ProjectConfig, e: EnvironmentConfig): Promise<Run[]> {
    if (!p.repository || !this.config.forgejo || e.branch === "Unknown")
      return [];
    const raw = await this.forge(
      `/repos/${this.repo(p.repository)}/actions/runs?ref=${encodeURIComponent(`refs/heads/${e.branch}`)}&limit=20`,
    );
    return array(raw.workflow_runs ?? raw.runs ?? raw).map((r) => ({
      id: Number(r.id),
      name: String(
        r.title ?? r.display_title ?? r.name ?? r.workflow_id ?? "Workflow",
      ),
      sha: String(r.commit_sha ?? r.head_sha ?? ""),
      state: result(r.conclusion ?? r.status),
      url: safeUrl(r.html_url, this.config.forgejo),
      date: iso(r.created ?? r.created_at),
    }));
  }
  async environment(
    p: ProjectConfig,
    e: EnvironmentConfig,
    providerIssues: Set<string>,
  ): Promise<Environment> {
    const out: Environment = {
      id: e.id,
      name: e.name,
      branch: e.branch,
      stage: e.stage,
      version: e.version,
      stack: e.stack,
      url: e.url,
      health: e.stack ? "unknown" : "not deployed",
      commits: [],
      runs: [],
      attempts: [],
      services: [],
      terminal: false,
      terminalService: e.terminalService,
      komodoTerminalsUrl: e.stack
        ? `${this.config.komodo}/terminals`
        : undefined,
      issues: [],
    };
    if (e.metadataIssue) out.issues.push(e.metadataIssue);
    if (this.isDiscovered(p) && p.sourceKind !== "application")
      out.issues.push(
        p.repository
          ? "The application repository is not identified, so application commit history is unavailable. Stage and Odoo version are not reported by Komodo."
          : "No matching Forgejo repository is reported for this stack. Deployment status and Komodo logs are available; stage and Odoo version are unknown.",
      );
    const capture = async (
      name: "Forgejo" | "Komodo",
      operation: string,
      fn: () => Promise<void>,
    ) => {
      try {
        await fn();
      } catch (error) {
        providerIssues.add(name);
        const diagnostic = providerDiagnostic(error, operation);
        out.issues.push(
          diagnostic.startsWith(`${name}:`)
            ? diagnostic
            : `${name}: ${diagnostic}`,
        );
      }
    };
    await Promise.all([
      capture("Forgejo", "Application commits", async () => {
        out.commits = await this.commits(p, e);
        for (const commit of out.commits)
          for (const check of commit.checks)
            if (
              check.name === "Commit statuses unavailable" &&
              check.description
            ) {
              providerIssues.add("Forgejo");
              out.issues.push(check.description);
            }
        if (out.commits.length === 10) out.nextCommitPage = 2;
      }),
      capture("Forgejo", "Workflow runs", async () => {
        out.runs = await this.runs(p, e);
      }),
      ...(e.stack
        ? [
            capture("Komodo", "Stack deployment history", async () => {
              const stack = obj(
                await this.read("GetStack", { stack: e.stack }),
              );
              const id = String(stack._id?.$oid ?? stack.id ?? "");
              if (!id) throw new Error("Missing stack ID");
              if (!out.url && Array.isArray(stack.config?.links))
                out.url = stack.config.links
                  .map((link: unknown) => stackLink(link))
                  .find((link: string | undefined) => !!link);
              const info = obj(stack.info);
              out.deployedInfraSha =
                typeof info.deployed_hash === "string"
                  ? info.deployed_hash
                  : undefined;
              const imageFile = array(info.deployed_contents).find(
                (f) =>
                  e.imagePath &&
                  String(f.path).endsWith(e.imagePath.split("/").pop()!),
              );
              if (imageFile)
                out.deployedImage = imageFromFile(
                  String(imageFile.contents ?? ""),
                );
              const history = await this.updates(e);
              out.attempts = history.attempts;
              out.nextUpdatePage = history.nextPage;
            }),
            capture("Komodo", "Stack services", async () => {
              out.services = array(
                await this.read("ListStackServices", { stack: e.stack }),
              ).map((s) => ({
                name: String(s.service),
                state: String(s.state),
                image: String(s.image ?? ""),
              }));
              const app = out.services.find(
                (s) => s.name === e.terminalService,
              );
              out.observedImage = app?.image;
              out.health =
                app?.state === "Healthy"
                  ? "healthy"
                  : app?.state === "Running"
                    ? "running"
                    : app &&
                        ["Stopped", "Exited", "Down", "Paused"].includes(
                          app.state,
                        )
                      ? "stopped"
                      : app?.state === "Unknown"
                        ? "unknown"
                        : app
                          ? "unhealthy"
                          : "unknown";
            }),
            ...(e.imagePath
              ? [
                  capture("Forgejo", "Image configuration", async () => {
                    const file = obj(
                      await this.forge(
                        `/repos/${this.repo(e.infraRepository ?? p.infraRepository)}/contents/${e.imagePath!.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(e.infraBranch ?? p.infraBranch)}`,
                      ),
                    );
                    out.desiredImage = imageFromFile(
                      Buffer.from(
                        String(file.content ?? ""),
                        "base64",
                      ).toString("utf8"),
                    );
                  }),
                ]
              : []),
          ]
        : []),
    ]);
    return out;
  }
  async updates(e: EnvironmentConfig, page = 0) {
    if (!e.stack) return { attempts: [], nextPage: undefined };
    const stack = obj(await this.read("GetStack", { stack: e.stack }));
    const id = String(stack._id?.$oid ?? stack.id ?? "");
    if (!id) throw new Error("Missing stack ID");
    const data = obj(
      await this.read("ListUpdates", {
        query: {
          "target.type": "Stack",
          "target.id": id,
          operation: { $in: ["DeployStack", "DeployStackIfChanged"] },
        },
        page,
      }),
    );
    if (!Array.isArray(data.updates))
      throw new Error("Unsupported update history response");
    const attempts = await Promise.all(
      array(data.updates)
        .slice(0, 30)
        .map(async (u, i) => {
          if (i < 5) {
            try {
              const full = obj(
                await this.read("GetUpdate", { id: String(u.id) }),
              );
              if (full.target?.type === "Stack" && full.target?.id === id)
                u = { ...u, ...full };
            } catch {
              /* Preserve the list entry when detail is not available. */
            }
          }
          return normalizeAttempt(u, this.config.komodo);
        }),
    );
    return {
      attempts,
      nextPage: typeof data.next_page === "number" ? data.next_page : undefined,
    };
  }
  private async environments(
    p: ProjectConfig,
    environments: EnvironmentConfig[],
    partial: Set<string>,
    user: string,
  ) {
    const out: Environment[] = [];
    // Projects are processed eight at a time; sequential environments keep total upstream work bounded.
    for (const e of environments)
      out.push({
        ...(await this.environment(p, e, partial)),
        terminal: canTerminal(this.config, user, e),
      });
    return out;
  }
  async snapshot(user: string): Promise<Snapshot> {
    if (this.config.workEnv === "test") return testSnapshot();
    const partial = new Set<string>();
    const issues = new Set<string>();
    const checkedAt = new Date().toISOString();
    try {
      await this.discover();
    } catch (error) {
      partial.add("Komodo");
      issues.add(providerDiagnostic(error, "Stack discovery"));
    }
    const projects: Snapshot["projects"] = [];
    if (this.discoveryIssues.length) {
      partial.add("Komodo");
      for (const issue of this.discoveryIssues) issues.add(issue);
    }
    const configured = this.projects();
    // Bound work for large inventories instead of overflowing the provider request queue.
    for (let offset = 0; offset < configured.length; offset += 8) {
      const batch = await Promise.all(
        configured.slice(offset, offset + 8).map(async (p) => {
          const accessible: EnvironmentConfig[] = [];
          for (const e of p.environments) {
            try {
              if (await this.allowed(p, e)) accessible.push(e);
            } catch (error) {
              // Never expose repository data when access could not be verified.
              // Continue checking other environments so one broken mapping cannot block them.
              partial.add("Komodo");
              issues.add(providerDiagnostic(error, "Stack access check"));
            }
          }
          if (!accessible.length) return undefined;
          let environments = [...accessible];
          let notice: string | undefined;
          if (
            p.repository &&
            (!this.isDiscovered(p) || p.sourceKind === "application")
          ) {
            try {
              // Discovery adds CI-only branches; a branch is never assumed to have a stack.
              const tagged =
                this.isDiscovered(p) && p.sourceKind === "application";
              const branches = tagged
                ? await this.applicationBranches(p)
                : array(
                    await this.forge(
                      `/repos/${this.repo(p.repository)}/branches?limit=30&page=1`,
                    ),
                  );
              environments = environments.concat(
                branches
                  .filter(
                    (b) =>
                      typeof b.name === "string" &&
                      !p.environments.some((e) => e.branch === b.name),
                  )
                  .slice(
                    0,
                    tagged ? branches.length : this.config.discoveryLimit,
                  )
                  .map((b) => ({
                    id: `branch-${Buffer.from(b.name).toString("base64url")}`,
                    name: b.name,
                    branch: b.name,
                    stage: "Development" as const,
                    version:
                      branchOdooVersion(b.name) ??
                      (tagged
                        ? "Unknown"
                        : (environments[0]?.version ?? "unknown")),
                    terminal: false,
                    terminalService: "odoo",
                  })),
              );
              if (
                !tagged &&
                (branches.length >= 30 ||
                  branches.filter(
                    (b) => !p.environments.some((e) => e.branch === b.name),
                  ).length > this.config.discoveryLimit)
              )
                notice = `Branch discovery is bounded to ${this.config.discoveryLimit} additional branches from the first 30 upstream entries. Configure a branch explicitly to always include it.`;
            } catch (error) {
              partial.add("Forgejo");
              issues.add(providerDiagnostic(error, "Branch discovery"));
            }
          }
          return {
            id: p.id,
            name: p.name,
            repository: p.repository,
            sourceKind: p.sourceKind,
            notice: this.isDiscovered(p)
              ? p.sourceKind === "application"
                ? undefined
                : "Komodo resource without application metadata. Application commit history is unavailable."
              : notice,
            repoUrl: p.repository
              ? `${this.config.forgejo}/${this.repo(p.repository)}`
              : undefined,
            environments: await this.environments(
              p,
              environments,
              partial,
              user,
            ),
          };
        }),
      );
      projects.push(...batch.filter((p): p is NonNullable<typeof p> => !!p));
    }
    const providers: ProviderState[] = (["Forgejo", "Komodo"] as const).map(
      (name) => {
        const stale = [...this.stale].filter((k) =>
          name === "Forgejo"
            ? k.startsWith("forge:") || k.startsWith("branches:")
            : k.startsWith("komodo:"),
        );
        if (stale.length) partial.add(name);
        return {
          name,
          state: partial.has(name)
            ? "unavailable"
            : (
                  name === "Forgejo"
                    ? projects.some(
                        (p) =>
                          p.repository &&
                          p.environments.some((e) => e.branch !== "Unknown"),
                      )
                    : this.config.autoDiscover ||
                      projects.some((p) => p.environments.some((e) => e.stack))
                )
              ? "connected"
              : "unchecked",
          issues: [
            ...new Set([
              ...issues,
              ...projects.flatMap((p) =>
                p.environments.flatMap((e) => e.issues),
              ),
              ...stale.map(
                (key) =>
                  this.staleReasons.get(key) ??
                  `${name}: cached data is being shown because the latest read failed.`,
              ),
            ]),
          ].filter(
            (issue) =>
              issue.startsWith(`${name}:`) ||
              (name === "Komodo" && this.discoveryIssues.includes(issue)),
          ),
          checkedAt: stale.length
            ? new Date(
                Math.min(
                  ...stale.map((k) => this.cache.get(k)?.at ?? Date.now()),
                ),
              ).toISOString()
            : checkedAt,
        };
      },
    );
    return {
      workEnv: "prod",
      projects: projects.filter((p): p is NonNullable<typeof p> => !!p),
      providers,
      fetchedAt: checkedAt,
      stale: partial.size > 0,
      issues: [...issues],
      pollMs: this.config.pollMs,
      terminalEnabled: this.config.terminalEnabled,
    };
  }
  mapping(project: string, environment: string) {
    const p = this.projects().find((p) => p.id === project);
    let e = p?.environments.find((e) => e.id === environment);
    if (p && !e && environment.startsWith("branch-")) {
      const branches = array(
        this.cache.get(`branches:${p.repository}`)?.value ??
          this.cache.get(
            `forge:/repos/${this.repo(p.repository)}/branches?limit=30&page=1`,
          )?.value,
      );
      const branch = branches.find(
        (b) =>
          `branch-${Buffer.from(String(b.name)).toString("base64url")}` ===
          environment,
      );
      if (branch && !p.environments.some((e) => e.branch === branch.name))
        e = {
          id: environment,
          name: String(branch.name),
          branch: String(branch.name),
          stage: "Development",
          version:
            branchOdooVersion(String(branch.name)) ??
            (this.isDiscovered(p) && p.sourceKind === "application"
              ? "Unknown"
              : (p.environments[0]?.version ?? "unknown")),
          terminal: false,
          terminalService: "odoo",
        };
    }
    if (!p || !e) throw new Error("Unknown project/environment");
    return { p, e };
  }
  async logs(
    project: string,
    environment: string,
    source: string,
    id?: string,
    service = "",
  ): Promise<Logs> {
    if (this.config.workEnv === "test") return testLogs(source);
    const { p, e } = this.mapping(project, environment);
    service ||= e.terminalService;
    let entries: LogEntry[] = [];
    let note =
      "Provider retention applies. Output is bounded; sensitive patterns are redacted on a best-effort basis.";
    if (source === "runtime") {
      if (!e.stack) throw new Error("No deployment configured");
      const services = array(
        await this.read("ListStackServices", { stack: e.stack }),
      );
      if (!services.some((s) => s.service === service))
        throw new Error("Unknown service");
      const log = obj(
        await this.request("Komodo", "/read/GetStackLog", {
          stack: e.stack,
          services: [service],
          tail: 500,
          timestamps: true,
        }),
      );
      entries = [
        {
          stage: service,
          text: [log.stdout, log.stderr].filter(Boolean).join("\n"),
        },
      ];
      note += " Current container output; not historical deployment logs.";
    } else if (source === "deploy") {
      if (!e.stack || !id) throw new Error("Select a deployment attempt");
      const stack = obj(await this.read("GetStack", { stack: e.stack }));
      const log = obj(await this.read("GetUpdate", { id }));
      if (
        log.target?.type !== "Stack" ||
        log.target?.id !== (stack._id?.$oid ?? stack.id) ||
        !["DeployStack", "DeployStackIfChanged"].includes(log.operation)
      )
        throw new Error("Update does not belong to this deployment");
      entries = array(log.logs).map((l) => ({
        stage: String(l.stage ?? "deploy"),
        success: l.success,
        text: [l.stdout, l.stderr].filter(Boolean).join("\n"),
      }));
    } else if (source === "ci") {
      if (!p.repository || !this.config.forgejo)
        throw new Error("No Forgejo repository identified");
      if (!id || !/^\d+$/.test(id)) throw new Error("Select a workflow run");
      const run = obj(
        await this.forge(
          `/repos/${this.repo(p.repository)}/actions/runs/${id}`,
        ),
      );
      if (
        ![e.branch, `refs/heads/${e.branch}`].includes(
          run.prettyref ?? run.head_branch ?? run.ref,
        )
      )
        throw new Error("Workflow run does not belong to this branch");
      const raw = await this.forge(
        `/repos/${this.repo(p.repository)}/actions/runs/${id}/jobs`,
      );
      const jobs = array(raw.jobs ?? raw).slice(0, 12);
      entries = await Promise.all(
        jobs.map(async (j) => {
          try {
            return {
              stage: `${String(j.name)} · attempt ${Number(j.attempt ?? 1)}`,
              text: await this.request(
                "Forgejo",
                `/repos/${this.repo(p.repository)}/actions/jobs/${Number(j.id)}/logs?attempt=${Number(j.attempt ?? 1)}`,
                undefined,
                true,
              ),
            };
          } catch {
            return {
              stage: String(j.name),
              text: "Inline logs unavailable for this job. Open the workflow in Forgejo to inspect retained output.",
            };
          }
        }),
      );
      note +=
        " CI log support depends on the installed Forgejo version. Up to 12 jobs are included.";
    } else throw new Error("Unknown log source");
    const secrets = [
      this.jwt,
      this.config.forgejoToken,
      this.config.komodoKey,
      this.config.komodoSecret,
    ];
    return {
      title:
        source === "runtime"
          ? `${service} · current container`
          : `Deployment ${id}`,
      entries: entries.map((l) => ({ ...l, text: cleanLog(l.text, secrets) })),
      note,
      fetchedAt: new Date().toISOString(),
    };
  }
}
