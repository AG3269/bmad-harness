import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const Discovery = z.array(z.object({
  host: z.object({
    type: z.string().min(1),
    pid: z.number().int().nonnegative(),
    instanceId: z.string().min(1),
  }),
  sessions: z.array(z.object({
    resource: z.string().min(1),
    title: z.string(),
    status: z.number().int().nonnegative(),
    workingDirectories: z.array(z.string()).default([]),
    modifiedAt: z.string().optional(),
  })),
}));

export type AvailableSession = {
  resource: string;
  title: string;
  status: number;
  modifiedAt?: string;
  host: { type: string; pid: number; instanceId: string };
};

type PickerOptions = {
  requested?: string;
  input?: Readable;
  output?: Writable;
  allowPipedInput?: boolean;
};

/** Discover saved sessions without including host addresses or tokens in the result. */
export async function discoverSessions(repo: string): Promise<AvailableSession[]> {
  return parseSessions(await sessionList(), repo);
}

export async function discoverHosts(): Promise<AvailableSession["host"][]> {
  return Discovery.parse(JSON.parse(await sessionList())).map((entry) => entry.host);
}

async function sessionList(): Promise<string> {
  const command = process.platform === "win32" ? "code-tunnel.exe" : "code";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, ["agent", "ps", "--all", "--json"], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new Error(
      `Could not list VS Code agent sessions (${code}). ` +
      "Check that the VS Code CLI is installed and an agent host is running.",
    );
  }
  return stdout;
}

export function parseSessions(json: string, repo: string): AvailableSession[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("The VS Code agent session list was not valid JSON.");
  }

  const parsed = Discovery.safeParse(data);
  if (!parsed.success) {
    const locations = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`The VS Code agent session list has an unexpected format at: ${locations}.`);
  }

  const target = canonicalPath(repo);
  const sessions: AvailableSession[] = [];
  for (const { host, sessions: found } of parsed.data) {
    for (const session of found) {
      if (!session.workingDirectories.some((dir) => localDirectoryMatches(dir, target))) continue;
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9._~%/-]+$/.test(session.resource)) {
        throw new Error("A matching session has an unsupported or unsafe session ID.");
      }
      sessions.push({
        resource: session.resource,
        title: session.title,
        status: session.status,
        modifiedAt: session.modifiedAt,
        host,
      });
    }
  }
  return sessions.sort((a, b) => timestamp(b.modifiedAt) - timestamp(a.modifiedAt));
}

export async function selectSession(
  sessions: AvailableSession[],
  options: PickerOptions = {},
): Promise<AvailableSession> {
  if (sessions.length === 0) {
    throw new Error("No saved agent sessions match the configured repository.");
  }

  if (options.requested !== undefined) {
    const matches = sessions.filter((session) =>
      session.resource === options.requested || session.title === options.requested);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? "The requested session does not match the configured repository. Use --select-session to list choices."
          : "The requested session is ambiguous. Select a unique session from the interactive list.",
      );
    }
    return uniqueSelection(sessions, matches[0]!);
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!options.allowPipedInput && !("isTTY" in input && input.isTTY)) {
    throw new Error("Session selection requires an interactive terminal. Use --session with the full session ID instead.");
  }

  output.write("\nSessions for the configured repository:\n");
  output.write("Idle sessions may be open or closed; VS Code does not report that here.\n");
  sessions.forEach((session, index) => {
    const title = safeDisplay(session.title) || "(untitled)";
    const time = session.modifiedAt ? safeDisplay(session.modifiedAt) : "time unknown";
    output.write(
      `  ${index + 1}. ${title} [${sessionStatus(session.status)}] · ${time}\n` +
      `     ${session.resource} · ${safeDisplay(session.host.type)} host ${session.host.pid}\n`,
    );
  });

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    output.write("Choose a session number, or q to cancel: ");
    for await (const line of lines) {
      const answer = line.trim();
      if (answer.toLowerCase() === "q") throw new Error("Session selection cancelled.");
      if (/^[1-9]\d*$/.test(answer)) {
        const selected = sessions[Number(answer) - 1];
        if (selected) return uniqueSelection(sessions, selected);
      }
      output.write("Enter a listed session number, or q to cancel: ");
    }
    throw new Error("Session selection ended without a choice.");
  } finally {
    lines.close();
  }
}

function uniqueSelection(sessions: AvailableSession[], selected: AvailableSession): AvailableSession {
  if (sessions.filter((session) => session.resource === selected.resource).length !== 1) {
    throw new Error("The selected session ID appears on multiple hosts; it cannot be selected safely yet.");
  }
  return selected;
}

export function sessionStatus(status: number): string {
  const activity = status & 16 ? "waiting for input"
    : status & 8 ? "running"
    : status & 2 ? "error"
    : status & 1 ? "idle"
    : "status unknown";
  return status & 64 ? `${activity}, archived` : activity;
}

function localDirectoryMatches(directory: string, target: string): boolean {
  let local: string;
  try {
    if (directory.startsWith("file:")) local = fileURLToPath(directory);
    else if (path.isAbsolute(directory)) local = directory;
    else return false;
  } catch {
    return false;
  }

  try {
    return canonicalPath(local) === target;
  } catch (error) {
    if (error instanceof Error && "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new Error(`Could not inspect a session working directory (${code}).`);
  }
}

function canonicalPath(directory: string): string {
  const resolved = fs.realpathSync.native(directory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function timestamp(value?: string): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function safeDisplay(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
}
