import { execFile } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { promisify } from "node:util";
import WebSocket, { type RawData } from "ws";
import { TransportError, type AhpTransport, type JsonRpcMessage, type TransportFrame } from "@microsoft/agent-host-protocol/client";
import { z } from "zod";
import type { AvailableSession } from "./sessions.js";

const execFileAsync = promisify(execFile);
const HostIdentity = z.object({
  type: z.string(),
  pid: z.number().int().nonnegative(),
  instanceId: z.string(),
});
const HostEndpoint = HostIdentity.extend({
  schemaVersion: z.literal(2),
  protocolVersion: z.string(),
  connectionToken: z.string().min(1),
  endpoint: z.discriminatedUnion("type", [
    z.object({ type: z.literal("socket"), path: z.string().min(1) }),
    z.object({ type: z.literal("tcp"), host: z.string(), port: z.number().int().min(1).max(65535) }),
  ]),
});
export type HostEndpoint = z.infer<typeof HostEndpoint>;

export async function discoverEndpoint(host: AvailableSession["host"]): Promise<HostEndpoint> {
  const command = process.platform === "win32" ? "code-tunnel.exe" : "code";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, ["agent", "endpoints"], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    }));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new Error(`Could not discover the selected local VS Code host (${code}).`);
  }
  return parseEndpoint(stdout, host);
}

export function parseEndpoint(json: string, host: AvailableSession["host"]): HostEndpoint {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("The VS Code host registry returned invalid JSON.");
  }
  const registry = z.union([
    z.array(z.unknown()),
    z.object({ endpoints: z.array(z.unknown()) }).transform((value) => value.endpoints),
  ]).safeParse(data);
  if (!registry.success) throw new Error("The VS Code host registry returned an unexpected format.");
  const matches = registry.data.filter((entry: unknown) => {
    const identity = HostIdentity.safeParse(entry);
    return identity.success && identity.data.type === host.type &&
      identity.data.pid === host.pid && identity.data.instanceId === host.instanceId;
  });
  if (matches.length !== 1) throw new Error("The selected VS Code host is no longer uniquely available.");
  const parsed = HostEndpoint.safeParse(matches[0]);
  if (!parsed.success) throw new Error("The selected VS Code host has unsupported or invalid endpoint metadata.");
  validateLocalEndpoint(parsed.data.endpoint);
  return parsed.data;
}

function validateLocalEndpoint(endpoint: HostEndpoint["endpoint"]): void {
  if (endpoint.type === "tcp") {
    if (!["127.0.0.1", "::1", "localhost"].includes(endpoint.host.toLowerCase())) {
      throw new Error("The selected host is not local; remote agent hosts are not supported.");
    }
    return;
  }
  const localPipe = process.platform === "win32"
    ? /^\\\\\.\\pipe\\[^\\]+$/i.test(endpoint.path)
    : path.isAbsolute(endpoint.path);
  if (!localPipe) throw new Error("The selected host does not expose a local socket or named pipe.");
}

export async function connectEndpoint(host: HostEndpoint, timeoutMs = 15_000): Promise<AhpTransport> {
  validateLocalEndpoint(host.endpoint);
  const address = host.endpoint.type === "tcp"
    ? `ws://${host.endpoint.host === "::1" ? "[::1]" : host.endpoint.host}:${host.endpoint.port}/`
    : "ws://localhost/";
  const url = new URL(address);
  url.searchParams.set("tkn", host.connectionToken);
  const options: WebSocket.ClientOptions = {
    handshakeTimeout: timeoutMs, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false,
  };
  if (host.endpoint.type === "socket") {
    const socketPath = host.endpoint.path;
    const createConnection: typeof net.createConnection = (..._args: unknown[]) => net.createConnection(socketPath);
    options.createConnection = createConnection;
  }

  const socket = new WebSocket(url, options);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (ok) resolve();
      else {
        socket.on("error", () => {});
        socket.terminate();
        reject(new Error("Could not connect to the selected local VS Code host."));
      }
    };
    const onOpen = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    socket.once("open", onOpen);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
  return new LocalTransport(socket);
}

type PendingRead = {
  resolve: (value: TransportFrame | null) => void;
  reject: (error: Error) => void;
};

class LocalTransport implements AhpTransport {
  private queue: TransportFrame[] = [];
  private pending?: PendingRead;
  private error?: TransportError;
  private closed = false;
  private closing = false;

  constructor(private socket: WebSocket) {
    socket.on("message", (data, binary) => this.message(data, binary));
    socket.on("error", () => this.fail("The local agent host connection failed."));
    socket.on("close", () => {
      this.closed = true;
      if (!this.closing) this.fail("The local agent host disconnected.");
      else this.deliver(null);
    });
  }

  async send(message: JsonRpcMessage | string): Promise<void> {
    if (this.error) throw this.error;
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new TransportError("closed", "The local agent host connection is closed.");
    }
    const text = typeof message === "string" ? message : JSON.stringify(message);
    await new Promise<void>((resolve, reject) => {
      this.socket.send(text, (error) => {
        if (error) reject(new TransportError("io", "Could not send to the local agent host."));
        else resolve();
      });
    });
  }

  async recv(): Promise<TransportFrame | null> {
    if (this.error) throw this.error;
    const frame = this.queue.shift();
    if (frame) return frame;
    if (this.closed) return null;
    if (this.pending) throw new TransportError("protocol", "Concurrent reads on the agent transport are not supported.");
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 2_000);
      this.socket.once("close", () => { clearTimeout(timer); resolve(); });
      this.socket.close();
    });
  }

  private message(data: RawData, binary: boolean): void {
    if (binary) {
      this.fail("The agent host sent an unexpected binary protocol message.");
      return;
    }
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    const text = bytes.toString("utf8");
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid message");
    } catch {
      this.fail("The agent host sent an invalid protocol message.");
      return;
    }
    if (this.queue.length >= 4096) {
      this.fail("The agent host sent messages faster than they could be processed.");
      return;
    }
    this.deliver({ kind: "text", text });
  }

  private deliver(frame: TransportFrame | null): void {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve(frame);
    } else if (frame) {
      this.queue.push(frame);
    }
  }

  private fail(message: string): void {
    if (this.error || this.closing) return;
    this.error = new TransportError("io", message);
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.reject(this.error);
    }
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}
