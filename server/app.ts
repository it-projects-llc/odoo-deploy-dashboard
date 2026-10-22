import express from "express";
import type { Config } from "./config.ts";
import { Authentication, AuthError } from "./session.ts";
import { Providers, ProviderError, providerDiagnostic } from "./providers.ts";

export function createApp(
  config: Config,
  providers: Providers,
  auth = new Authentication(config),
) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops) app.set("trust proxy", config.trustProxyHops);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(express.json({ limit: "8kb" }));
  auth.install(app);
  app.use("/api", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    let session;
    try {
      session = await auth.authenticate(req);
    } catch (e) {
      res
        .status(e instanceof AuthError ? e.status : 502)
        .json({ error: "Unable to verify your Komodo session." });
      return;
    }
    if (!session) {
      res.status(401).json({
        error: "Authentication required. Sign in to continue.",
      });
      return;
    }
    res.locals.user = session.user;
    res.locals.providers = providers.forSession(session.jwt);
    if (req.method !== "GET") {
      res.status(405).json({ error: "This endpoint is read-only." });
      return;
    }
    next();
  });
  const limits = new Map<string, { start: number; n: number }>();
  app.use("/api", (req, res, next) => {
    const key = res.locals.user;
    const n = Date.now();
    const old = limits.get(key);
    if (!old || n - old.start > 60000) {
      if (limits.size > 1000) limits.clear();
      limits.set(key, { start: n, n: 1 });
    } else if (++old.n > 120) {
      res.setHeader("Retry-After", "60");
      res
        .status(429)
        .json({ error: "Request limit reached. Try again shortly." });
      return;
    }
    next();
  });
  app.get("/api/snapshot", async (_req, res) => {
    try {
      res.json(
        await (res.locals.providers as Providers).snapshot(res.locals.user),
      );
    } catch (error) {
      res
        .status(
          error instanceof ProviderError && [401, 403].includes(error.status)
            ? error.status
            : 502,
        )
        .json({
          error: providerDiagnostic(error, "Dashboard snapshot"),
        });
    }
  });
  app.get("/api/logs", async (req, res) => {
    try {
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      const scoped = res.locals.providers as Providers;
      if (config.workEnv !== "test")
        await scoped.authorizedMapping(
          str(req.query.project),
          str(req.query.environment),
        );
      res.json(
        await scoped.logs(
          str(req.query.project),
          str(req.query.environment),
          str(req.query.source),
          str(req.query.id),
          str(req.query.service),
        ),
      );
    } catch (error) {
      res
        .status(
          error instanceof ProviderError && [401, 403].includes(error.status)
            ? error.status
            : 502,
        )
        .json({
          error:
            "Logs unavailable for this selection. Check permissions, retention, and provider API support; use the upstream link for details.",
        });
    }
  });
  app.get("/api/commits", async (req, res) => {
    try {
      if (config.workEnv === "test") {
        res.json({ commits: [] });
        return;
      }
      const scoped = res.locals.providers as Providers;
      const { p, e } = await scoped.authorizedMapping(
        String(req.query.project),
        String(req.query.environment),
      );
      const page = Number(req.query.page);
      if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error();
      const commits = await scoped.commits(p, e, page);
      res.json({
        commits,
        nextPage: commits.length === 10 ? page + 1 : undefined,
      });
    } catch (error) {
      res
        .status(
          error instanceof ProviderError && [401, 403].includes(error.status)
            ? error.status
            : 502,
        )
        .json({ error: "Commit history is unavailable." });
    }
  });
  app.get("/api/attempts", async (req, res) => {
    try {
      if (config.workEnv === "test") {
        res.json({ attempts: [] });
        return;
      }
      const scoped = res.locals.providers as Providers;
      const { e } = await scoped.authorizedMapping(
        String(req.query.project),
        String(req.query.environment),
      );
      const page = Number(req.query.page);
      if (!Number.isInteger(page) || page < 0 || page > 100) throw new Error();
      res.json(await scoped.updates(e, page));
    } catch (error) {
      res
        .status(
          error instanceof ProviderError && [401, 403].includes(error.status)
            ? error.status
            : 502,
        )
        .json({ error: "Deployment history is unavailable." });
    }
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Unknown dashboard endpoint" }),
  );

  return app;
}
