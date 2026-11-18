import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { connectEndpoint, parseEndpoint, type HostEndpoint } from "./transport.js";

const host = { type: "editor", pid: 123, instanceId: "test-instance" };

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-socket-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\harness-test-${randomUUID()}`
    : path.join(root, "agent.sock");
  const endpoint: HostEndpoint = {
    ...host, schemaVersion: 2, protocolVersion: "1.1.0", connectionToken: "test-token",
    endpoint: { type: "socket", path: socketPath },
  };
  return { endpoint, socketPath };
}

test("host discovery matches identity and rejects remote or malformed endpoints", (t) => {
  const { endpoint } = fixture(t);
  assert.deepEqual(parseEndpoint(JSON.stringify({ endpoints: [endpoint] }), host), endpoint);
  assert.deepEqual(parseEndpoint(JSON.stringify([endpoint]), host), endpoint);
  assert.throws(() => parseEndpoint(JSON.stringify({ endpoints: [endpoint, endpoint] }), host), /no longer uniquely/);
  assert.throws(() => parseEndpoint(JSON.stringify({ endpoints: [] }), host), /no longer uniquely/);
  assert.throws(() => parseEndpoint(JSON.stringify({ endpoints: [{ ...endpoint, schemaVersion: 3 }] }), host), /unsupported/);
  assert.throws(() => parseEndpoint(JSON.stringify({ endpoints: [{
    ...endpoint, endpoint: { type: "tcp", host: "example.com", port: 80 },
  }] }), host), /not local/);
  assert.throws(() => parseEndpoint("test-token", host), (error: Error) => {
    assert.match(error.message, /invalid JSON/);
    assert.doesNotMatch(error.message, /test-token/);
    return true;
  });
});

test("WebSocket transport connects through the local pipe and authenticates", async (t) => {
  const { endpoint, socketPath } = fixture(t);
  const server = http.createServer();
  const sockets = new WebSocketServer({ noServer: true });
  let tokenAccepted = false;
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    tokenAccepted = url.searchParams.get("tkn") === "test-token";
    if (!tokenAccepted) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" })));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const transport = await connectEndpoint(endpoint, 3000);
  try {
    await transport.send('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    const reply = await transport.recv();
    assert.equal(reply?.kind, "text");
    if (reply?.kind === "text") assert.equal(JSON.parse(reply.text).result, "ok");
    assert.equal(tokenAccepted, true);
  } finally {
    await transport.close();
  }
});
