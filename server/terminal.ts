import { createHash, randomUUID } from "node:crypto";
import type { Server, IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { Config } from "./config.ts";
import { canTerminal } from "./auth.ts";
import { Authentication } from "./session.ts";
import type { Providers } from "./providers.ts";
const unavailable =
  "Komodo terminal unavailable. Check service state and Komodo compatibility.";
export function terminalFailureMessage(reason: string | number) {
  if (reason === 400)
    return "Komodo rejected the terminal connection parameters (HTTP 400). Check dashboard and Komodo API compatibility.";
  return reason === 401 ||
    reason === 403 ||
    (typeof reason === "string" &&
      /permission|forbidden|unauthori[sz]ed|access denied|not allowed|insufficient/i.test(
        reason,
      ))
    ? "Komodo denied terminal access for the current account. Ask a Komodo administrator to grant Terminal permission on this stack."
    : unavailable;
}
// Komodo uses serde_qs bracket notation. Encode values, preserving structural brackets in keys.
export function terminalQuery(params: Record<string, string>) {
  return Object.entries(params)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key).replace(/%5B/g, "[").replace(/%5D/g, "]")}=${encodeURIComponent(value)}`,
    )
    .join("&");
}
export function terminalFrame(input: unknown): Buffer {
  const m = input as {
    type?: string;
    data?: unknown;
    rows?: unknown;
    cols?: unknown;
  };
  if (
    m?.type === "input" &&
    typeof m.data === "string" &&
    Buffer.byteLength(m.data) <= 8192
  )
    return Buffer.concat([Buffer.from(m.data, "utf8"), Buffer.from([1])]);
  if (
    m?.type === "resize" &&
    Number.isInteger(m.rows) &&
    Number.isInteger(m.cols) &&
    Number(m.rows) >= 1 &&
    Number(m.rows) <= 500 &&
    Number(m.cols) >= 1 &&
    Number(m.cols) <= 1000
  )
    return Buffer.concat([
      Buffer.from(JSON.stringify({ rows: m.rows, cols: m.cols })),
      Buffer.from([255]),
    ]);
  throw new Error("Invalid terminal frame");
}
export function installTerminal(
  server: Server,
  config: Config,
  providers: Providers,
  auth = new Authentication(config),
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
  });
  const sessions = new Map<
    string,
    {
      user: string;
      project: string;
      environment: string;
      name: string;
      at: number;
    }
  >();
  let connections = 0;
  const reject = (socket: { end: (s: string) => unknown }, code: number) =>
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", config.origin);
    if (url.pathname !== "/api/terminal") {
      if (
        process.env.NODE_ENV === "production" ||
        url.pathname.startsWith("/api/")
      )
        reject(socket, 404);
      return;
    } // Vite handles its own development websocket.
    if (req.headers.origin !== config.origin) return void reject(socket, 403);
    let login;
    try {
      login = await auth.authenticate(req);
    } catch {
      return void reject(socket, 503);
    }
    if (!login) return void reject(socket, 403);
    const user = login.user;
    const owner = login.jwt ? login.id : user;
    let mapping;
    try {
      mapping = await providers
        .forSession(login.jwt)
        .authorizedMapping(
          url.searchParams.get("project") ?? "",
          url.searchParams.get("environment") ?? "",
        );
    } catch {
      return void reject(socket, 404);
    }
    if (login.jwt && !auth.isActive(login)) return void reject(socket, 403);
    if (!canTerminal(config, user, mapping.e)) return void reject(socket, 403);
    if (connections >= config.terminalMax) return void reject(socket, 429);
    const project = mapping.p.id,
      environment = mapping.e.id;
    for (const [id, s] of sessions)
      if (Date.now() - s.at > 3_600_000) sessions.delete(id);
    let id = url.searchParams.get("session") ?? "";
    if (id) {
      const s = sessions.get(id);
      if (
        !s ||
        s.user !== owner ||
        s.project !== project ||
        s.environment !== environment
      )
        return void reject(socket, 403);
    } else {
      if (sessions.size >= 200) return void reject(socket, 429);
      id = randomUUID();
      sessions.set(id, {
        user: owner,
        project,
        environment,
        name: `dash-${createHash("sha256").update(user).digest("hex").slice(0, 12)}-${randomUUID()}`,
        at: Date.now(),
      });
    }
    const session = sessions.get(id)!;
    session.at = Date.now();
    connections++;
    wss.handleUpgrade(req, socket, head, (client) => {
      const query = terminalQuery({
        "target[type]": "Stack",
        "target[params][stack]": mapping.e.stack!,
        "target[params][service]": mapping.e.terminalService,
        terminal: session.name,
        "init[command]": config.terminalShell,
        "init[recreate]": "Never",
        "init[mode]": "exec",
      });
      const target = new URL(`${config.komodo}/ws/terminal`);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      target.search = query;
      const upstream = new WebSocket(target, {
        maxPayload: 2_000_000,
        handshakeTimeout: 10000,
        perMessageDeflate: false,
      });
      let ready = false,
        lastInput = Date.now(),
        closed = false;
      const send = (data: object) => {
        if (client.readyState === WebSocket.OPEN)
          client.send(JSON.stringify(data));
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        connections--;
        clearInterval(timer);
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
        else if (upstream.readyState === WebSocket.CONNECTING)
          upstream.terminate();
      };
      const fail = (message = unavailable) => {
        if (closed) return;
        send({ type: "error", message });
        client.close(1011, "Terminal unavailable");
        cleanup();
      };
      let validating = false;
      let checked = Date.now();
      const timer = setInterval(() => {
        if (login.jwt && !auth.isActive(login)) {
          client.close(1008, "Session expired");
          cleanup();
          return;
        }
        if (login.jwt && !validating && Date.now() - checked > 30000) {
          validating = true;
          void auth
            .authenticate(req)
            .then((s) => {
              if (!s) {
                client.close(1008, "Sign in again");
                cleanup();
              }
            })
            .catch(() => fail())
            .finally(() => {
              validating = false;
              checked = Date.now();
            });
        }
        if (!ready && Date.now() - lastInput > 15000) return fail();
        if (Date.now() - lastInput > config.terminalIdleMs) {
          send({
            type: "error",
            message:
              "Disconnected after inactivity. The Komodo session may still be running.",
          });
          client.close(1000, "Idle timeout");
          cleanup();
        } else {
          client.ping();
        }
      }, 5000);
      upstream.on("open", () =>
        upstream.send(
          JSON.stringify({
            ...(login.jwt
              ? { type: "Jwt", params: { jwt: login.jwt } }
              : {
                  type: "ApiKeys",
                  params: {
                    key: config.komodoKey,
                    secret: config.komodoSecret,
                  },
                }),
          }),
        ),
      );
      upstream.on("message", (data, binary) => {
        // Komodo sends terminal setup failures as text ERROR frames after login.
        // Forward a safe explanation to the page, never the raw upstream error.
        if (!binary && data.toString().startsWith("ERROR:")) {
          fail(terminalFailureMessage(data.toString()));
          return;
        }
        if (!ready) {
          if (!binary && data.toString() === "LOGGED_IN") {
            ready = true;
            send({ type: "ready", session: id });
          } else {
            const status = /^\[(400|401|403)\b/.exec(data.toString());
            fail(
              status ? terminalFailureMessage(Number(status[1])) : unavailable,
            );
          }
          return;
        }
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > 2_000_000) {
          client.close(1013, "Output buffer full");
          cleanup();
          return;
        }
        client.send(data, { binary: true });
      });
      let ending = false;
      client.on("message", async (data, binary) => {
        if (!ready || ending) return;
        try {
          if (binary) throw new Error();
          const message = JSON.parse(data.toString());
          if (message.type === "end") {
            ending = true;
            // Only this socket's server-owned target and terminal name can be ended.
            try {
              const response = await fetch(
                `${config.komodo}/write/DeleteTerminal`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...(login.jwt
                      ? { Authorization: login.jwt }
                      : {
                          "X-Api-Key": config.komodoKey,
                          "X-Api-Secret": config.komodoSecret,
                        }),
                  },
                  body: JSON.stringify({
                    target: {
                      type: "Stack",
                      params: {
                        stack: mapping.e.stack,
                        service: mapping.e.terminalService,
                      },
                    },
                    terminal: session.name,
                  }),
                  signal: AbortSignal.timeout(10000),
                  redirect: "error",
                },
              );
              if (response.status === 401 || response.status === 403) {
                ending = false;
                send({
                  type: "error",
                  message:
                    "Komodo denied permission to end this terminal. Check the current account's terminal permissions in Komodo. The session may still be running.",
                });
                return;
              }
              if (!response.ok) throw new Error();
              sessions.delete(id);
              send({ type: "ended" });
              client.close(1000, "Session ended");
              cleanup();
            } catch {
              ending = false;
              send({
                type: "error",
                message:
                  "Unable to end the terminal. It may still be running; use Komodo to manage it.",
              });
              if (upstream.readyState === WebSocket.CLOSED) {
                client.close(1011, "Terminal disconnected");
                cleanup();
              }
            }
            return;
          }
          const frame = terminalFrame(message);
          if (upstream.bufferedAmount > 65536) throw new Error();
          upstream.send(frame);
          lastInput = Date.now();
          session.at = Date.now();
        } catch {
          client.close(1008, "Invalid terminal input");
          cleanup();
        }
      });
      upstream.on("unexpected-response", (_request, response) => {
        response.resume();
        fail(terminalFailureMessage(response.statusCode ?? 502));
      });
      upstream.on("error", () => fail());
      upstream.on("close", () => {
        if (ending) return;
        send({ type: "closed" });
        client.close(1000, "Komodo disconnected");
        cleanup();
      });
      client.on("error", cleanup);
      client.on("close", cleanup);
    });
  });
  return wss;
}
