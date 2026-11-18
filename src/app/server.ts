import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { HarnessApp } from "./service.js";
import { discoverHosts } from "../vscode/sessions.js";
import { acquireRepoLock } from "../run/lock.js";

export function createAppServer(app: HarnessApp) {
  const token = randomBytes(32).toString("hex");
  const template = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const message = app.scrub(error instanceof Error ? error.message : String(error));
      console.error(`App request failed: ${message}`);
      if (!response.headersSent) {
        response.writeHead(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 409, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: message }));
      } else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.once("listening", () => {
    const poll = () => {
      void app.pollSessions().catch((error: unknown) =>
        console.error(`Session polling failed: ${app.scrub(error instanceof Error ? error.message : String(error))}`));
    };
    poll();
    const timer = setInterval(poll, 30_000);
    server.once("close", () => clearInterval(timer));
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The app listener is unavailable.");
    const port = address.port;
    const origin = `http://127.0.0.1:${port}`;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.headers.host !== `127.0.0.1:${port}` ||
        request.headers.origin && request.headers.origin !== origin) {
      response.writeHead(403); response.end("Local requests only."); return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(18).toString("base64");
      response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(template.replaceAll("__NONCE__", nonce).replace("__APP_TOKEN__", token));
      return;
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204); response.end(); return;
    }
    if (request.headers["x-harness-token"] !== token) {
      response.writeHead(403); response.end("Missing app request token."); return;
    }
    const send = (value: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/api/state") { send(await app.snapshot()); return; }
    if (request.method === "GET" && url.pathname === "/api/hosts") {
      send((await discoverHosts()).filter((host) => host.type === "editor")); return;
    }
    if (request.method !== "POST") { response.writeHead(404); response.end("Not found."); return; }
    if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
      response.writeHead(415); response.end("Use application/json."); return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 16_384) { response.writeHead(413); response.end("Request is too large."); return; }
      chunks.push(buffer);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    switch (url.pathname) {
      case "/api/profiles": send(app.addProfile(input)); return;
      case "/api/start": send(await app.start(input)); return;
      case "/api/recover": send(await app.recover(input)); return;
      case "/api/respond": await app.respond(input); send({ ok: true }); return;
      case "/api/open": {
        const value = z.object({ profileId: z.string().uuid() }).strict().parse(input);
        await app.openWorkspace(value.profileId); send({ ok: true }); return;
      }
      case "/api/create-session": {
        const value = z.object({ profileId: z.string().uuid(), host: z.string().min(1) }).strict().parse(input);
        send({ id: await app.createSession(value.profileId, value.host) }); return;
      }
      case "/api/inspect": {
        const value = z.object({ profileId: z.string().uuid(), runId: z.string().min(1) }).strict().parse(input);
        send(await app.inspect(value.profileId, value.runId)); return;
      }
      default: response.writeHead(404); response.end("Not found.");
    }
  }
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    return value;
  };
  const port = z.coerce.number().int().min(0).max(65535).parse(option("--port", "4317"));
  const configFile = path.resolve(option("--config", "harness.config.yaml"));
  const stateRoot = path.join(path.dirname(configFile), ".harness-state", "app");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const unlock = acquireRepoLock(path.join(stateRoot, "locks"), stateRoot);
  let released = false;
  const release = () => { if (!released) { unlock(); released = true; } };
  let app: HarnessApp;
  try { app = new HarnessApp(configFile, process.cwd()); }
  catch (error) { release(); throw error; }
  const server = createAppServer(app);
  server.once("close", release);
  server.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) { release(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("App did not obtain a local port.");
  console.log(`Harness Studio: http://127.0.0.1:${address.port}`);
  console.log("The app never starts or recovers a run until you choose an action.");
  const timer = setInterval(() => {
    void app.drain().catch((error: unknown) => console.error(`Queue error: ${app.scrub(error instanceof Error ? error.message : String(error))}`));
  }, 5000);
  server.once("close", () => clearInterval(timer));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
