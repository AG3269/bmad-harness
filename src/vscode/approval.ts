import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { minimatch } from "minimatch";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Ledger } from "../audit/ledger.js";

export type ApprovalRequest = {
  key: string;
  turnId: string;
  toolCallId: string;
  kind: "tool" | "result";
  toolName?: string;
  message: string;
  input?: string;
  hasRiskAssessment: boolean;
  options?: { id: string; label: string; kind: "approve" | "deny" }[];
};

export type ApprovalDecision = {
  approved: boolean;
  by: "human" | "rule";
  optionId?: string;
};

export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;

export function inputFingerprint(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function createApprovalHandler(cfg: Config, ledger: Ledger, story: string): ApprovalHandler {
  return async (request, signal) => {
    if (signal.aborted) throw new Error("Approval request was resolved elsewhere.");
    const fingerprint = request.input === undefined ? undefined : inputFingerprint(request.input);
    const auto = isAutomaticallyApproved(cfg, request);
    if (auto) {
      ledger.write({ type: "note", story, text: `Requested Exact-match tool approval: ${request.toolName} (${request.toolCallId}).` });
      return { approved: true, by: "rule" };
    }
    if (cfg.mode === "solo") {
      ledger.write({ type: "note", story, text: `Tool approval requires a human in solo mode (${request.toolCallId}).` });
      throw new Error("Tool approval requires a human, but solo mode does not ask. Inspect the active VS Code turn.");
    }

    console.log(`\nTool ${request.kind === "result" ? "result " : ""}approval needed for ${story}.`);
    console.log(`  Tool: ${safeText(request.toolName ?? "(unknown)")}`);
    console.log(`  Request: ${safeText(request.message)}`);
    if (fingerprint) console.log(`  Input SHA-256: ${fingerprint}`);
    console.log("  Review the full request in VS Code; another client may resolve it there.");
    ledger.write({ type: "note", story, text: `Awaiting human approval for ${request.toolName ?? "unknown tool"} (${request.toolCallId}).` });

    if (!process.stdin.isTTY) {
      return new Promise<ApprovalDecision>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error("Approval request was resolved elsewhere.")); return; }
        signal.addEventListener("abort", () => reject(new Error("Approval request was resolved elsewhere.")), { once: true });
      });
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const options = request.options ?? [];
      if (options.length) {
        options.forEach((option, index) => console.log(`  ${index + 1}. ${safeText(option.label)} (${option.kind})`));
      }
      while (true) {
        const prompt = options.length ? "Choose an option number, or q to stop: " : "Approve [a], deny [d], or stop [q]: ";
        const input = (await rl.question(prompt, { signal })).trim().toLowerCase();
        if (input === "q") throw new Error("Stopped while awaiting tool approval; inspect the VS Code turn before resuming.");
        if (options.length && /^[1-9]\d*$/.test(input)) {
          const option = options[Number(input) - 1];
          if (option) {
            ledger.write({ type: "note", story, text: `Human requested ${option.kind} for tool ${request.toolName ?? "unknown"} (${request.toolCallId}).` });
            return { approved: option.kind === "approve", by: "human", optionId: option.id };
          }
        } else if (!options.length && (input === "a" || input === "d")) {
          ledger.write({ type: "note", story, text: `Human requested ${input === "a" ? "approval" : "denial"} for tool ${request.toolName ?? "unknown"} (${request.toolCallId}).` });
          return { approved: input === "a", by: "human" };
        }
        console.log("Invalid choice.");
      }
    } finally {
      rl.close();
    }
  };
}

export function isAutomaticallyApproved(cfg: Config, request: ApprovalRequest): boolean {
  if (cfg.mode === "watch" || cfg.decide.shadow || request.kind !== "tool" ||
      request.toolName !== "list_directory" || request.input === undefined ||
      request.hasRiskAssessment || request.options?.length) return false;
  const fingerprint = inputFingerprint(request.input);
  if (!cfg.tool_approvals.auto_allow.some((rule) => rule.tool === request.toolName && rule.input_sha256 === fingerprint)) {
    return false;
  }
  let value: unknown;
  try {
    value = JSON.parse(request.input);
  } catch {
    return false;
  }
  const parsed = z.object({ path: z.string().min(1), recursive: z.literal(false) }).strict().safeParse(value);
  if (!parsed.success) return false;

  try {
    const repo = fs.realpathSync.native(cfg.repo);
    const directory = fs.realpathSync.native(path.resolve(repo, parsed.data.path));
    const relative = path.relative(repo, directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        !fs.statSync(directory).isDirectory()) return false;
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.some((part) => /^\.git$|^\.harness$|^\.env(?:\.|$)/i.test(part))) return false;
    const normalized = relative.split(path.sep).join("/");
    return !cfg.decide.never_touch.some((pattern) =>
      minimatch(normalized, pattern, { dot: true }) || minimatch(`${normalized}/`, pattern, { dot: true }));
  } catch {
    return false;
  }
}

function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 1000);
}
