import "dotenv/config";
import { z } from "zod";
const httpUrl = z
  .string()
  .url()
  .refine(
    (s) =>
      ["http:", "https:"].includes(new URL(s).protocol) &&
      !new URL(s).username &&
      !new URL(s).password,
    "Expected an HTTP(S) URL without credentials",
  );
const environmentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1),
  branch: z.string().min(1),
  stage: z.enum(["Production", "Staging", "Development", "Unknown"]),
  version: z.string().default("19.0"),
  stack: z.string().min(1).optional(),
  url: httpUrl.optional(),
  imagePath: z.string().optional(),
  terminalService: z.string().default("odoo"),
  infraRepository: z.string().optional(),
  infraBranch: z.string().optional(),
  metadataIssue: z.string().optional(),
  terminal: z.boolean().default(false),
});
const projectSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  infraRepository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  infraBranch: z.string().default("19.0"),
  sourceKind: z
    .enum(["application", "infrastructure", "none"])
    .default("application"),
  environments: z.array(environmentSchema).min(1).max(20),
});
export type ProjectConfig = z.infer<typeof projectSchema>;
export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const bool = (name: string, fallback = false) => {
    const v = env[name];
    if (v !== undefined && !["true", "false"].includes(v))
      throw new Error(`${name} must be true or false`);
    return v === undefined ? fallback : v === "true";
  };
  const int = (name: string, fallback: number, min: number, max: number) =>
    z.coerce
      .number()
      .int()
      .min(min)
      .max(max)
      .parse(env[name] ?? fallback);
  if (env.DASHBOARD_DEMO !== undefined) {
    throw new Error(
      "DASHBOARD_DEMO has been replaced by work_env=test|prod; remove the old variable",
    );
  }
  const workEnv = z.enum(["test", "prod"]).default("test").parse(env.work_env);
  const isTest = workEnv === "test";
  const terminalEnabled = !isTest && bool("DASHBOARD_TERMINAL_ENABLED");
  const authMode = z
    .enum(["komodo", "proxy"])
    .default("komodo")
    .parse(env.DASHBOARD_AUTH_MODE);
  const proxySecret = isTest ? "" : (env.DASHBOARD_PROXY_SECRET ?? "");
  const sessionSecret = isTest ? "" : (env.DASHBOARD_SESSION_SECRET ?? "");
  const origin = httpUrl.parse(env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:4173");
  if (
    new URL(origin).pathname !== "/" ||
    new URL(origin).search ||
    new URL(origin).hash
  )
    throw new Error("DASHBOARD_ORIGIN must be an origin without a path");
  const projects = z
    .array(projectSchema)
    .max(10)
    .parse(JSON.parse(isTest ? "[]" : (env.DASHBOARD_PROJECTS_JSON ?? "[]")));
  if (
    new Set(projects.map((p) => p.id)).size !== projects.length ||
    projects.some(
      (p) =>
        new Set(p.environments.map((e) => e.id)).size !== p.environments.length,
    )
  )
    throw new Error("Project and environment IDs must be unique");
  const required = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required when work_env=prod`);
    return v;
  };
  if (!isTest && authMode === "proxy" && proxySecret.length < 32)
    throw new Error(
      "DASHBOARD_PROXY_SECRET must contain at least 32 characters when work_env=prod",
    );
  if (!isTest && authMode === "komodo" && sessionSecret.length < 32)
    throw new Error(
      "DASHBOARD_SESSION_SECRET must contain at least 32 characters when work_env=prod",
    );
  const autoDiscover = !isTest && bool("DASHBOARD_AUTO_DISCOVER", true);
  if (!isTest && !autoDiscover && projects.length === 0)
    throw new Error(
      "DASHBOARD_PROJECTS_JSON must contain at least one project when work_env=prod",
    );
  const terminalUsers = (isTest ? "" : (env.DASHBOARD_TERMINAL_USERS ?? ""))
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (terminalEnabled && authMode === "proxy" && !terminalUsers.length)
    throw new Error(
      "Terminal requires explicit users in DASHBOARD_TERMINAL_USERS when using proxy authentication",
    );
  return {
    workEnv,
    authMode,
    sessionSecret,
    projects,
    autoDiscover,
    origin: new URL(origin).origin,
    host: env.DASHBOARD_HOST ?? "127.0.0.1",
    port: int("PORT", 4173, 1, 65535),
    trustProxyHops: int("DASHBOARD_TRUST_PROXY_HOPS", 0, 0, 5),
    forgejo: isTest
      ? ""
      : httpUrl.parse(required("FORGEJO_URL")).replace(/\/$/, ""),
    forgejoToken: isTest ? "" : required("FORGEJO_TOKEN"),
    komodo: isTest
      ? ""
      : httpUrl.parse(required("KOMODO_URL")).replace(/\/$/, ""),
    komodoKey:
      isTest || authMode === "komodo" ? "" : required("KOMODO_API_KEY"),
    komodoSecret:
      isTest || authMode === "komodo" ? "" : required("KOMODO_API_SECRET"),
    proxySecret,
    terminalEnabled,
    terminalUsers,
    terminalShell: isTest
      ? "/bin/bash"
      : (env.DASHBOARD_TERMINAL_SHELL ?? "/bin/bash"),
    terminalProduction: !isTest && bool("DASHBOARD_TERMINAL_PRODUCTION"),
    terminalMax: int("DASHBOARD_TERMINAL_MAX_CONNECTIONS", 4, 1, 20),
    terminalIdleMs:
      int("DASHBOARD_TERMINAL_IDLE_SECONDS", 900, 30, 3600) * 1000,
    discoveryLimit: int("DASHBOARD_DISCOVERY_LIMIT", 8, 0, 30),
    pollMs: int("DASHBOARD_POLL_SECONDS", 15, 5, 300) * 1000,
    cacheMs: int("DASHBOARD_CACHE_SECONDS", 10, 1, 300) * 1000,
  };
}
export type Config = ReturnType<typeof loadConfig>;
