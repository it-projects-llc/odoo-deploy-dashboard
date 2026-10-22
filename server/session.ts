import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Express, Response } from "express";
import type { Config } from "./config.ts";
import { identity } from "./auth.ts";

export type Session = {
  user: string;
  jwt: string;
  id: string;
  expires: number;
};
const COOKIE = "dashboard_session";
const MFA_COOKIE = "dashboard_mfa";
export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Authentication {
  // Only session identifiers live in memory. Restarting logs everyone out.
  private active = new Map<string, number>();
  private attempts = new Map<string, { at: number; count: number }>();
  constructor(public config: Config) {}
  private key() {
    return createHash("sha256").update(this.config.sessionSecret).digest();
  }
  seal(value: object, purpose: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(purpose));
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64url");
  }
  private open<T>(req: IncomingMessage, name: string): T | undefined {
    try {
      const value = req.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(name + "="))
        ?.slice(name.length + 1);
      if (!value || value.length > 3800) return;
      const b = Buffer.from(value, "base64url");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        this.key(),
        b.subarray(0, 12),
      );
      cipher.setAAD(Buffer.from(name));
      cipher.setAuthTag(b.subarray(-16));
      return JSON.parse(
        Buffer.concat([
          cipher.update(b.subarray(12, -16)),
          cipher.final(),
        ]).toString(),
      );
    } catch {
      return;
    }
  }
  private cookie(
    res: Response,
    name: string,
    value: object | undefined,
    seconds = 0,
  ) {
    const encoded = value ? this.seal(value, name) : "";
    if (encoded.length > 3800)
      throw new AuthError(
        502,
        "Komodo returned a session larger than supported.",
      );
    res.append(
      "Set-Cookie",
      `${name}=${encoded}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.config.origin.startsWith("https:") ? "; Secure" : ""}`,
    );
  }
  session(req: IncomingMessage): Session | undefined {
    const s = this.open<Session>(req, COOKIE);
    if (
      !s ||
      typeof s.jwt !== "string" ||
      typeof s.user !== "string" ||
      !this.isActive(s)
    )
      return;
    return s;
  }
  isActive(s: Session) {
    return s.expires > Date.now() && this.active.get(s.id) === s.expires;
  }
  private async call(
    path: string,
    body?: object,
    jwt?: string,
    cookie?: string,
  ) {
    let response: globalThis.Response;
    try {
      response = await fetch(this.config.komodo + path, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          ...(jwt ? { Authorization: jwt } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
    } catch {
      throw new AuthError(502, "Unable to reach Komodo. Try again shortly.");
    }
    if (!response.ok)
      throw new AuthError(
        response.status >= 500 ? 502 : 401,
        response.status >= 500
          ? "Komodo login is unavailable."
          : "Unable to sign in. Check your credentials and account access.",
      );
    const text = await response.text();
    if (text.length > 100000)
      throw new AuthError(502, "Unexpected Komodo authentication response.");
    return {
      body: JSON.parse(text),
      cookies: response.headers
        .getSetCookie()
        .map((v) => v.split(";", 1)[0])
        .join("; "),
    };
  }
  private async user(jwt: string) {
    const { body: u } = await this.call("/user", undefined, jwt);
    if (
      !u ||
      u.enabled !== true ||
      typeof u.username !== "string" ||
      !u.username
    )
      throw new AuthError(
        401,
        "This Komodo account is disabled or unavailable.",
      );
    return u.username as string;
  }
  async authenticate(req: IncomingMessage): Promise<Session | undefined> {
    if (this.config.workEnv === "test" || this.config.authMode === "proxy") {
      const user = identity(req, this.config);
      return user ? { user, jwt: "", id: user, expires: Infinity } : undefined;
    }
    const session = this.session(req);
    if (!session) return;
    try {
      const user = await this.user(session.jwt);
      if (!this.isActive(session)) return;
      return { ...session, user };
    } catch (e) {
      if (e instanceof AuthError && e.status === 401) {
        this.active.delete(session.id);
        return;
      }
      throw e;
    }
  }
  private async finish(res: Response, jwt: string) {
    const user = await this.user(jwt);
    let expires = Date.now() + 8 * 3600000;
    // Untrusted claims can only shorten the cookie lifetime; /user validates the token.
    try {
      const exp = JSON.parse(
        Buffer.from(jwt.split(".")[1], "base64url").toString(),
      ).exp;
      if (Number.isFinite(exp)) expires = Math.min(expires, exp * 1000);
    } catch {
      /* Komodo is authoritative. */
    }
    if (expires <= Date.now())
      throw new AuthError(401, "Komodo session has expired. Sign in again.");
    for (const [id, at] of this.active)
      if (at <= Date.now()) this.active.delete(id);
    if (this.active.size >= 1000)
      throw new AuthError(503, "Dashboard session capacity reached.");
    const session = { user, jwt, expires, id: randomUUID() };
    this.cookie(
      res,
      COOKIE,
      session,
      Math.floor((expires - Date.now()) / 1000),
    );
    this.active.set(session.id, expires);
    this.cookie(res, MFA_COOKIE, undefined);
    res.json({ authenticated: true, user });
  }
  install(app: Express) {
    app.use("/api/auth", (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    app.get("/api/auth/session", async (req, res) => {
      try {
        const s = await this.authenticate(req);
        res.json({
          authenticated: !!s,
          user: s?.user,
          mode: this.config.workEnv === "test" ? "test" : this.config.authMode,
        });
      } catch {
        res
          .status(502)
          .json({ error: "Unable to verify your Komodo session." });
      }
    });
    app.use(
      "/api/auth",
      (req, res, next) => {
        if (
          req.method !== "POST" ||
          req.headers.origin !== this.config.origin
        ) {
          res.status(403).json({ error: "Same-origin POST required." });
          return;
        }
        next();
      },
      (req, res, next) => {
        if (
          this.config.workEnv === "test" ||
          this.config.authMode !== "komodo"
        ) {
          res.status(404).json({ error: "Komodo login is not enabled." });
          return;
        }
        const now = Date.now();
        for (const [key, v] of this.attempts)
          if (now - v.at >= 60000) this.attempts.delete(key);
        const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
        const value = this.attempts.get(key) ?? { at: now, count: 0 };
        if (
          req.path !== "/logout" &&
          (++value.count > 10 || this.attempts.size >= 1000)
        ) {
          res.setHeader("Retry-After", "60");
          res
            .status(429)
            .json({ error: "Too many login attempts. Try again in a minute." });
          return;
        }
        this.attempts.set(key, value);
        next();
      },
    );
    // Only these three explicit operations are exposed; never proxy arbitrary auth requests.
    app.post("/api/auth/logout", (req, res) => {
      const session = this.session(req);
      if (session) this.active.delete(session.id);
      this.cookie(res, COOKIE, undefined);
      this.cookie(res, MFA_COOKIE, undefined);
      res.json({ ok: true });
    });
    app.post(["/api/auth/login", "/api/auth/totp"], async (req, res) => {
      try {
        const input = req.body;
        if (!input || typeof input !== "object")
          throw new AuthError(400, "Enter your Komodo credentials.");
        let response;
        if (req.path.endsWith("/totp")) {
          const challenge = this.open<{ cookie: string; expires: number }>(
            req,
            MFA_COOKIE,
          );
          if (!challenge || challenge.expires < Date.now())
            throw new AuthError(401, "Login challenge expired. Start again.");
          if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code))
            throw new AuthError(400, "Enter a six-digit authentication code.");
          response = await this.call(
            "/auth/login/CompleteTotpLogin",
            { code: input.code },
            undefined,
            challenge.cookie,
          );
        } else {
          if (
            typeof input.username !== "string" ||
            !input.username.trim() ||
            input.username.length > 200 ||
            typeof input.password !== "string" ||
            !input.password ||
            input.password.length > 1024
          )
            throw new AuthError(
              400,
              "Enter your Komodo username and password.",
            );
          this.cookie(res, MFA_COOKIE, undefined);
          response = await this.call("/auth/login/LoginLocalUser", {
            username: input.username.trim(),
            password: input.password,
          });
        }
        const body = response.body;
        if (body?.type === "Totp" && response.cookies) {
          this.cookie(
            res,
            MFA_COOKIE,
            { cookie: response.cookies, expires: Date.now() + 300000 },
            300,
          );
          res.json({ challenge: "totp" });
          return;
        }
        if (body?.type === "Passkey")
          throw new AuthError(
            400,
            "This account requires a Komodo passkey. Passkey login is not supported by this dashboard yet.",
          );
        const jwt = body?.type === "Jwt" ? body.data?.jwt : body?.jwt;
        if (typeof jwt !== "string" || !jwt)
          throw new AuthError(
            502,
            "Unsupported Komodo login response. Check the installed version.",
          );
        await this.finish(res, jwt);
      } catch (error) {
        res.status(error instanceof AuthError ? error.status : 502).json({
          error:
            error instanceof AuthError
              ? error.message
              : "Komodo login is unavailable. Check the installed version.",
        });
      }
    });
    app.use("/api/auth", (_req, res) =>
      res.status(404).json({ error: "Unknown login endpoint." }),
    );
  }
}
