import { createHash } from "node:crypto";
import type { Config, ProjectConfig } from "./config.ts";

// ListStacks exposes sanitized summary fields. Never pass raw stack config to the browser.
export function discoveredProject(
  config: Config,
  item: Record<string, any>,
  tags: string[] = [],
): ProjectConfig | undefined {
  const id = typeof item.id === "string" ? item.id : item._id?.$oid;
  if (typeof id !== "string" || !id || typeof item.name !== "string") return;
  const info = item.info && typeof item.info === "object" ? item.info : {};
  let repository = "";
  const repo: string =
    typeof info.repo === "string" ? info.repo.replace(/\.git$/, "") : "";
  if (
    config.forgejo &&
    /^[\w.-]+\/[\w.-]+$/.test(repo) &&
    repo.split("/").every((part) => ![".", ".."].includes(part))
  ) {
    try {
      const forge = new URL(config.forgejo);
      const provider =
        typeof info.git_provider === "string" ? info.git_provider : "";
      const providerUrl = provider
        ? new URL(provider.includes("://") ? provider : `https://${provider}`)
        : undefined;
      // A repository on another provider must never be fetched with the Forgejo token.
      if (
        providerUrl &&
        !providerUrl.username &&
        !providerUrl.password &&
        providerUrl.host === forge.host &&
        providerUrl.pathname.replace(/\/$/, "") ===
          forge.pathname.replace(/\/$/, "")
      )
        repository = repo;
    } catch {
      /* Unknown provider: Komodo data remains available. */
    }
  }
  const services: Record<string, any>[] = Array.isArray(info.services)
    ? info.services.filter(
        (service: unknown) => service && typeof service === "object",
      )
    : [];
  const odoo = services.filter(
    (s) =>
      typeof s.service === "string" &&
      (s.service === "odoo" ||
        /(?:^|\/)odoo(?::|@)/.test(String(s.image ?? ""))),
  );
  const service =
    odoo.length === 1
      ? odoo[0].service
      : services.length === 1 && typeof services[0].service === "string"
        ? services[0].service
        : "";
  const branch =
    typeof info.branch === "string" && info.branch ? info.branch : "Unknown";
  const parsed = odooMetadata(tags);
  const meta = parsed.values;
  const application = !!(meta.project && meta.repository);
  const appBranch = application ? meta.branch || "Unknown" : branch;
  const stage = application
    ? meta.stage === "production"
      ? "Production"
      : meta.stage === "staging"
        ? "Staging"
        : "Development"
    : "Unknown";
  const selectedService = meta.service || service;
  return {
    id: application
      ? `project-${createHash("sha256").update(`${meta.project}\0${meta.repository}`).digest("hex").slice(0, 24)}`
      : `stack-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`,
    name: application ? meta.project : item.name,
    repository: application ? meta.repository : repository,
    infraRepository: repository,
    infraBranch: branch,
    sourceKind: application
      ? "application"
      : repository
        ? "infrastructure"
        : "none",
    environments: [
      {
        id: application
          ? `stack-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`
          : "instance",
        name: item.name,
        branch: appBranch,
        stage,
        version:
          meta.version ||
          (stage === "Development"
            ? branchOdooVersion(appBranch)
            : undefined) ||
          "Unknown",
        infraRepository: repository,
        infraBranch: branch,
        metadataIssue:
          parsed.issue ||
          (application && !meta.branch
            ? "Application branch tag is missing; application history for this deployment is unavailable."
            : undefined),
        stack: id,
        terminal: !!selectedService,
        terminalService: selectedService,
      },
    ],
  };
}

export function stackLink(value: unknown) {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    return;
  }
}

const metadataKeys = new Set([
  "project",
  "repository",
  "branch",
  "stage",
  "version",
  "service",
]);
export function odooMetadata(tags: string[]) {
  const values: Record<string, string> = {};
  for (const tag of tags) {
    const match = /^odoo\.([a-z]+)=(.*)$/.exec(tag);
    if (!match || !metadataKeys.has(match[1])) continue;
    const [, key, value] = match;
    if (
      !value ||
      value.length > 200 ||
      /[\x00-\x1f\x7f]/.test(value) ||
      (values[key] && values[key] !== value)
    )
      return {
        values: {} as Record<string, string>,
        issue:
          "Conflicting or invalid Odoo metadata tags; this resource remains unclassified.",
      };
    values[key] = value;
  }
  const invalid =
    (values.project &&
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(values.project)) ||
    (values.repository &&
      (!/^[\w.-]+\/[\w.-]+$/.test(values.repository) ||
        values.repository.split("/").some((p) => [".", ".."].includes(p)))) ||
    (values.branch && !validBranch(values.branch)) ||
    (values.version && !/^\d{1,2}\.\d+(?:\.\d+)?$/.test(values.version)) ||
    (values.service && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(values.service));
  if (invalid)
    return {
      values: {} as Record<string, string>,
      issue: "Invalid Odoo metadata tags; this resource remains unclassified.",
    };
  return { values, issue: undefined };
}
export function validBranch(branch: string) {
  return (
    !!branch &&
    branch !== "@" &&
    !/[\s~^:?*\[\]\\]/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.includes("//") &&
    branch.split("/").every((p) => !p.startsWith(".") && !p.endsWith(".lock"))
  );
}

// OCA application branches start with the Odoo series, e.g. 19.0-feature or 19.0.
export function branchOdooVersion(branch: string): string | undefined {
  return /^(\d{1,2}\.\d+)(?=-|$)/.exec(branch)?.[1];
}
