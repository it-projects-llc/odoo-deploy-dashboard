import express from "express";
import { Authentication } from "./session.ts";
import { createApp } from "./app.ts";
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { Providers } from "./providers.ts";
import { installTerminal } from "./terminal.ts";
const config = loadConfig();
const providers = new Providers(config);
const auth = new Authentication(config);
const app = createApp(config, providers, auth);
const server = createServer(app);
installTerminal(server, config, providers, auth);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve(root, "dist/index.html")),
  );
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
server.listen(config.port, config.host, () =>
  console.log(
    `Dashboard ${config.workEnv}: http://${config.host}:${config.port}`,
  ),
);
function shutdown() {
  server.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
