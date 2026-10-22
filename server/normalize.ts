import type { Result, Attempt } from "../src/types.ts";
export function result(value: unknown): Result {
  const s = String(value ?? "").toLowerCase();
  if (["success", "passed"].includes(s)) return "passed";
  if (
    ["failure", "failed", "error", "timed_out", "action_required"].includes(s)
  )
    return "failed";
  if (["in_progress", "inprogress", "running"].includes(s)) return "running";
  if (["queued", "pending", "waiting", "requested", "blocked"].includes(s))
    return "pending";
  if (["canceled", "cancelled"].includes(s)) return "cancelled";
  if (["skipped", "neutral"].includes(s)) return "skipped";
  if (s === "warning") return "warning";
  return "unknown";
}
export function aggregate(states: Result[]): Result {
  if (!states.length) return "unknown";
  for (const s of [
    "failed",
    "running",
    "pending",
    "warning",
    "cancelled",
    "unknown",
  ] as Result[])
    if (states.includes(s)) return s;
  return states.every((s) => s === "skipped") ? "skipped" : "passed";
}
export function updateState(u: { status?: string; success?: boolean }): Result {
  return u.status === "Complete"
    ? u.success === true
      ? "passed"
      : "failed"
    : result(u.status);
}
export function iso(value: unknown): string {
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime())
    ? new Date(0).toISOString()
    : d.toISOString();
}
export function imageFromFile(contents: string): string | undefined {
  return contents.match(/^ODOO_IMAGE\s*=\s*['"]?([^\s'"#]+)/m)?.[1];
}
export function digest(image?: string) {
  return image?.match(/@sha256:[a-f0-9]{64}$/)?.[0];
}
export function sourceMatch(a?: string, b?: string) {
  return (
    !!a &&
    !!b &&
    a.length >= 7 &&
    b.length >= 7 &&
    (a.startsWith(b) || b.startsWith(a))
  );
}
export function safeUrl(v: unknown, base: string): string | undefined {
  try {
    const u = new URL(String(v));
    return u.origin === new URL(base).origin &&
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : undefined;
  } catch {
    return;
  }
}
export function cleanLog(text: string, secrets: string[] = []) {
  let s = text
    .replace(/<\/?span\b[^>]*>/gi, "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  for (const secret of secrets.filter(Boolean))
    s = s.split(secret).join("[REDACTED]");
  return s
    .replace(
      /((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s]+/gi,
      "$1[REDACTED]",
    )
    .slice(-1_000_000);
}
export function normalizeAttempt(
  u: Record<string, any>,
  base: string,
): Attempt {
  const id = String(u.id ?? u._id?.$oid ?? "");
  return {
    id,
    state: updateState(u),
    date: iso(u.start_ts),
    end: u.end_ts ? iso(u.end_ts) : undefined,
    operation: String(u.operation ?? "DeployStack"),
    actor: String(u.username ?? u.operator ?? "Unknown"),
    infraSha: typeof u.commit_hash === "string" ? u.commit_hash : undefined,
    url: base ? `${base}/updates/${encodeURIComponent(id)}` : undefined,
  };
}
