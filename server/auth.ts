import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config, EnvironmentConfig } from "./config.ts";
export function identity(
  req: IncomingMessage,
  config: Config,
): string | undefined {
  if (config.workEnv === "test") return "test-viewer";
  const secret = req.headers["x-dashboard-proxy-secret"];
  const user = req.headers["x-dashboard-user"];
  if (
    typeof secret !== "string" ||
    typeof user !== "string" ||
    !user.trim() ||
    user.length > 200
  )
    return;
  const a = Buffer.from(secret),
    b = Buffer.from(config.proxySecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return;
  return user;
}
export function canTerminal(
  config: Config,
  user: string,
  env: EnvironmentConfig,
) {
  return (
    config.workEnv === "prod" &&
    config.terminalEnabled &&
    (config.authMode === "komodo" || config.terminalUsers.includes(user)) &&
    env.terminal &&
    !!env.stack &&
    (!["Production", "Unknown"].includes(env.stage) ||
      config.terminalProduction)
  );
}
