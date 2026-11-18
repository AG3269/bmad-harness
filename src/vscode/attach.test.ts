import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InMemoryTransport, type AhpTransport } from "@microsoft/agent-host-protocol/client";
import * as YAML from "yaml";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { Azure, type Ask } from "../llm/azure.js";
import { Ledger } from "../audit/ledger.js";
import { Decider } from "../decide/engine.js";
import { runEpic } from "../run/epic.js";
import { runStory } from "../run/story.js";
import { findStories } from "../bmad/stories.js";
import { snapshotWorktree } from "../validate/diff.js";
import { saveBaseline } from "../run/baseline.js";
import { askRecoveryAgent, recoverRecordedTurn } from "../run/recover.js";
import { createHash } from "node:crypto";
import { AttachedSession } from "./attach.js";
import type { ApprovalHandler } from "./approval.js";
import type { AvailableSession } from "./sessions.js";

type JsonMessage = {
  id?: number;
  method?: string;
  params?: {
    channel?: string;
    clientId?: string;
    clientSeq?: number;
    action?: { type: string; turnId: string; message?: { text?: string; agent?: { uri: string }; model?: { id: string } }; approved?: boolean };
  };
};

type Behavior = "success" | "refresh" | "identity-refresh" | "session-workspace-change" | "chat-change" | "changed-agent" | "changed-definition" | "story" | "create-story" | "inspect" | "recover-complete" | "recover-tool" | "recover-story" | "recover-active" | "recover-refresh" | "recover-pending" | "recover-input" |
  "approval" | "result-approval" | "session-input" |
  "respond-approval" | "respond-result" | "external-approval" | "input-resolved" | "unexpected-tool" |
  "disconnect" | "timeout" | "mismatch" | "rejected" | "workspace-change";

function fixture(t: TestContext, behavior: Behavior = "success", onApproval?: ApprovalHandler, allowActive = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ahp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".github", "agents"), { recursive: true });
  const agentFile = path.join(repo, ".github", "agents", "bmad-agent-dev.agent.md");
  fs.writeFileSync(agentFile, "test agent");
  const reviewerFile = path.join(repo, ".github", "agents", "bmad-agent-architect.agent.md");
  fs.writeFileSync(reviewerFile, "test reviewer");
  const plannerFile = path.join(repo, ".github", "agents", "bmad-agent-pm.agent.md");
  fs.writeFileSync(plannerFile, "test planner");
  const [transport, peer] = InMemoryTransport.pair();
  const session: AvailableSession = {
    resource: "ahp-session:/test", title: "Test session", status: 1,
    host: { type: "editor", pid: 1, instanceId: "test" },
  };
  const workingDirectory = pathToFileURL(repo).href;
  const agentUri = pathToFileURL(agentFile).href;
  const chatUri = "ahp-chat:/test";
  const snapshots: Record<string, object> = {
    "ahp-root://": {
      agents: [{ provider: "copilotcli", displayName: "Copilot", description: "", models: [
        { id: "model-id", provider: "copilotcli", name: "Configured model", policyState: "enabled" },
        { id: "review-id", provider: "copilotcli", name: "Configured reviewer", policyState: "enabled" },
      ] }],
    },
    [session.resource]: {
      provider: "copilotcli", title: session.title,
      status: ["inspect", "recover-active", "recover-refresh", "recover-pending", "recover-input"].includes(behavior) ? 8 : 1,
      lifecycle: "ready", activeClients: [],
      workingDirectories: [workingDirectory], chats: [{ resource: chatUri }], defaultChat: chatUri,
      ...(behavior === "recover-pending" ? { inputNeeded: [{
        id: "pending", chat: chatUri, kind: "toolConfirmation", turnId: RECOVERED_ID,
        toolCall: { status: "pending-confirmation", toolCallId: "tool", toolName: "read_file", invocationMessage: "Needs approval" },
      }] } : {}),
      ...(behavior === "recover-input" ? { inputNeeded: [{
        id: "session-input", chat: chatUri, kind: "chatInput", request: { id: "question" },
      }] } : {}),
      customizations: [{
        type: "directory", id: "agents", uri: pathToFileURL(path.dirname(agentFile)).href,
        name: "Agents", enabled: true, load: { kind: "loaded" }, children: [{
          type: "agent", id: "developer", name: "bmad-agent-dev", uri: agentUri,
        }, {
          type: "agent", id: "reviewer", name: "bmad-agent-architect", uri: pathToFileURL(reviewerFile).href,
        }, {
          type: "agent", id: "planner", name: "bmad-agent-pm", uri: pathToFileURL(plannerFile).href,
        }],
      }],
    },
    [chatUri]: {
      resource: chatUri, title: "Chat",
      status: ["inspect", "recover-active", "recover-refresh", "recover-pending", "recover-input"].includes(behavior) ? 8 : 1,
      modifiedAt: "2026-01-01T00:00:00Z",
      turns: behavior === "inspect"
        ? [{ id: "past", state: "complete", responseParts: [{ kind: "markdown", content: "Earlier result" }] }]
        : behavior === "recover-complete" || behavior === "recover-story" || behavior === "recover-tool"
          ? [{ id: RECOVERED_ID, state: "complete", message: { agent: { uri: agentUri }, model: { id: "model-id" } },
            responseParts: behavior === "recover-tool" ? [{ kind: "toolCall", toolCall: { status: "completed" } }]
              : [{ kind: "markdown", id: "part", content: "Completed response" }] }]
          : [],
      ...(behavior === "inspect" ? { activeTurn: {
        id: "current", responseParts: [
          { kind: "markdown", content: "Current progress" },
          { kind: "toolCall", toolCall: { status: "running", content: [{ type: "terminal", resource: "ahp-terminal:/test" }] } },
        ],
      } } : {}),
      ...(["recover-active", "recover-refresh", "recover-pending", "recover-input"].includes(behavior) ? { activeTurn: {
        id: RECOVERED_ID, message: { agent: { uri: agentUri }, model: { id: "model-id" } },
        responseParts: [{ kind: "markdown", id: "part", content: "Partial" }],
      } } : {}),
    },
    "ahp-terminal:/test": {
      title: "Test terminal", content: [{ type: "unclassified", value: "Terminal output" }],
      claim: { kind: "session", session: session.resource, chat: chatUri }, lifecycle: { status: "running" },
    },
  };
  const server = mockHost(peer, snapshots, behavior, repo);
  const driver = new AttachedSession(repo, { session, transport, requestTimeoutMs: 2000, onApproval, allowActive });
  return { root, repo, driver, server, agentUri };
}

function mockHost(peer: AhpTransport, snapshots: Record<string, object>, behavior: Behavior, repo: string) {
  let dispatches = 0;
  let cancellations = 0;
  let clientId = "";
  let seq = 0;
  let chatSubscriptions = 0;
  const send = async (value: object) => { await peer.send(JSON.stringify(value)); };
  const action = async (channel: string, value: object, origin?: object, rejectionReason?: string) => {
    await send({
      jsonrpc: "2.0", method: "action",
      params: { channel, serverSeq: ++seq, action: value, origin, ...(rejectionReason ? { rejectionReason } : {}) },
    });
  };
  const refresh = () => action("ahp-session:/test", {
    type: "session/customizationUpdated",
    customization: {
      type: "directory", id: "agents", uri: pathToFileURL(path.join(repo, ".github", "agents")).href,
      name: "Agents", enabled: true, load: { kind: "loaded" }, children: [{
        type: "agent", id: "developer", name: "bmad-agent-dev",
        uri: pathToFileURL(path.join(repo, ".github", "agents", "bmad-agent-dev.agent.md")).href,
        ...(behavior === "changed-agent" ? { enabled: false } : {}),
        ...(behavior === "changed-definition" ? { description: "A changed agent definition" } : {}),
      }],
    },
  });
  const task = (async () => {
    while (true) {
      const frame = await peer.recv();
      if (!frame) return;
      if (frame.kind !== "text") throw new Error("Expected text protocol frame.");
      const message: JsonMessage = JSON.parse(frame.text);
      if (message.method === "initialize") {
        clientId = message.params?.clientId ?? "";
        await send({
          jsonrpc: "2.0", id: message.id,
          result: { protocolVersion: "1.0.0", serverSeq: seq, snapshots: [
            { resource: "ahp-root://", state: snapshots["ahp-root://"], fromSeq: seq },
          ] },
        });
      } else if (message.method === "ping") {
        await send({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "subscribe") {
        const channel = message.params?.channel ?? "";
        await send({ jsonrpc: "2.0", id: message.id, result: {
          snapshot: { resource: channel, state: snapshots[channel], fromSeq: seq },
        } });
        if (channel === "ahp-chat:/test") {
          chatSubscriptions++;
          if (chatSubscriptions === 2 && (behavior === "recover-active" || behavior === "recover-refresh" || behavior === "recover-pending" || behavior === "recover-input")) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (behavior === "recover-refresh") await refresh();
            if (behavior === "recover-pending") {
              await action(channel, { type: "chat/toolCallConfirmed", turnId: RECOVERED_ID, toolCallId: "tool", approved: true, confirmed: "user-action" });
            }
            if (behavior === "recover-input") {
              await action(channel, { type: "chat/inputCompleted", requestId: "question", response: "accept" });
            }
            await action(channel, { type: "chat/delta", turnId: RECOVERED_ID, partId: "part", content: " recovered" });
            await action(channel, { type: "chat/turnComplete", turnId: RECOVERED_ID, duration: 1 });
          }
        }
      } else if (message.method === "dispatchAction") {
        const channel = message.params?.channel ?? "";
        const sent = message.params?.action;
        if (!sent) throw new Error("Missing dispatched action.");
        if (sent.type === "chat/turnCancelled") {
          cancellations++;
          await action(channel, sent, { clientId, clientSeq: message.params?.clientSeq });
          continue;
        }
        if (sent.type === "chat/toolCallConfirmed" || sent.type === "chat/toolCallResultConfirmed") {
          await action(channel, sent, { clientId, clientSeq: message.params?.clientSeq });
          await action(channel, { type: "chat/responsePart", turnId: sent.turnId, part: { kind: "markdown", id: "part", content: "Hello" } });
          await action(channel, { type: "chat/turnComplete", turnId: sent.turnId, duration: 1 });
          continue;
        }
        dispatches++;
        if (behavior === "disconnect") { await peer.close(); return; }
        if (behavior === "timeout") continue;
        const origin = { clientId, clientSeq: message.params?.clientSeq };
        if (behavior === "rejected") {
          await action(channel, sent, origin, "test rejection");
          continue;
        }
        const echoed = behavior === "mismatch"
          ? { ...sent, message: { ...sent.message, model: { id: "wrong" } } }
          : sent;
        await action(channel, echoed, origin);
        if (behavior === "mismatch") continue;
        if (behavior === "refresh" || behavior === "changed-agent" || behavior === "changed-definition") await refresh();
        if (behavior === "identity-refresh") {
          await action("ahp-session:/test", { type: "session/defaultChatChanged", defaultChat: channel });
          await action("ahp-session:/test", { type: "session/workingDirectorySet", directory: pathToFileURL(repo).href });
          await action(channel, { type: "chat/workingDirectorySet", directory: pathToFileURL(repo).href });
        }
        if (behavior === "session-workspace-change") await action("ahp-session:/test", {
          type: "session/workingDirectorySet", directory: pathToFileURL(path.dirname(repo)).href,
        });
        if (behavior === "chat-change") await action("ahp-session:/test", { type: "session/defaultChatChanged", defaultChat: "ahp-chat:/other" });
        if (behavior === "unexpected-tool") {
          await action(channel, {
            type: "chat/toolCallStart", turnId: sent.turnId, toolCallId: "tool",
            toolName: "run_in_terminal", displayName: "Run terminal",
          });
          continue;
        }
        if (behavior === "approval") {
          await action(channel, {
            type: "chat/toolCallReady", turnId: sent.turnId, toolCallId: "tool",
            invocationMessage: "Needs approval",
          });
          continue;
        }
        if (behavior === "respond-approval" || behavior === "external-approval") {
          await action(channel, {
            type: "chat/toolCallStart", turnId: sent.turnId, toolCallId: "tool",
            toolName: "read_file", displayName: "Read file",
          });
          await action(channel, {
            type: "chat/toolCallReady", turnId: sent.turnId, toolCallId: "tool",
            invocationMessage: "Needs approval", toolInput: "{\"path\":\"test.txt\"}",
          });
          if (behavior === "external-approval") {
            await action(channel, {
              type: "chat/toolCallConfirmed", turnId: sent.turnId, toolCallId: "tool",
              approved: true, confirmed: "user-action",
            });
            await action(channel, { type: "chat/turnComplete", turnId: sent.turnId, duration: 1 });
          }
          continue;
        }
        if (behavior === "respond-result") {
          await action(channel, {
            type: "chat/toolCallComplete", turnId: sent.turnId, toolCallId: "tool",
            result: { success: true, pastTenseMessage: "Done" }, requiresResultConfirmation: true,
          });
          continue;
        }
        if (behavior === "result-approval") {
          await action(channel, {
            type: "chat/toolCallComplete", turnId: sent.turnId, toolCallId: "tool",
            result: { success: true, pastTenseMessage: "Done" }, requiresResultConfirmation: true,
          });
          continue;
        }
        if (behavior === "session-input") {
          await action("ahp-session:/test", {
            type: "session/inputNeededSet", request: { kind: "chatInput", id: "input", chat: channel, request: { id: "input" } },
          });
          continue;
        }
        if (behavior === "input-resolved") {
          await action(channel, { type: "chat/inputRequested", request: { id: "question" } });
          await action(channel, { type: "chat/inputCompleted", requestId: "question", response: "accept" });
          await action(channel, { type: "chat/turnComplete", turnId: sent.turnId, duration: 1 });
          continue;
        }
        if (behavior === "workspace-change") {
          await action(channel, { type: "chat/workingDirectoryRemoved", directory: "file:///test" });
          continue;
        }
        if (behavior === "recover-story" && sent.message?.text?.startsWith("The harness is recovering")) {
          await action(channel, { type: "chat/responsePart", turnId: sent.turnId, part: {
            kind: "markdown", id: "part",
            content: JSON.stringify({ summary: "Review remains.", next_step: "review", uncertainties: [] }),
          } });
          await action(channel, { type: "chat/turnComplete", turnId: sent.turnId, duration: 1 });
          continue;
        }
        if (behavior === "story" || behavior === "recover-story" || behavior === "create-story") {
          if (sent.message?.agent?.uri.endsWith("bmad-agent-pm.agent.md")) {
            fs.writeFileSync(path.join(repo, "stories", "1-1-mock-story.md"), [
              "# Story 1.1: Mock story", "", "## Status", "Ready", "",
              "## Acceptance Criteria", "1. Execute a simulated feature", "",
            ].join("\n"));
          } else if (sent.message?.agent?.uri.endsWith("bmad-agent-dev.agent.md")) {
            fs.mkdirSync(path.join(repo, "src"), { recursive: true });
            fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const implemented = true;\n");
            fs.writeFileSync(path.join(repo, "stories", behavior === "create-story" ? "1-1-mock-story.md" : "1.1.md"), [
              "# Story 1.1: Mock story", "", "## Status", "Review", "",
              "## Acceptance Criteria", "1. Execute a simulated feature", "",
            ].join("\n"));
          } else {
            fs.mkdirSync(path.join(repo, ".harness"), { recursive: true });
            fs.writeFileSync(path.join(repo, ".harness", "review.json"), "[]");
          }
        }
        await action(channel, { type: "chat/responsePart", turnId: sent.turnId, part: { kind: "markdown", id: "part", content: "Hello" } });
        await action(channel, { type: "chat/delta", turnId: sent.turnId, partId: "part", content: " world" });
        await action(channel, { type: "chat/turnComplete", turnId: sent.turnId, duration: 1 });
      }
    }
  })();
  return { task, dispatches: () => dispatches, cancellations: () => cancellations };
}

const turn = { agent: "bmad-agent-dev", model: "Configured model", say: "Say hello", timeoutMs: 1500 };
const RECOVERED_ID = "00000000-0000-4000-8000-000000000001";

test("AHP attaches, confirms agent/model, and reads a streamed turn", async (t) => {
  const { driver, server } = fixture(t);
  try {
    await driver.attach();
    await driver.verifySelections([turn]);
    assert.deepEqual(await driver.send(turn), { text: "Hello world", changed: [], idle: true });
    assert.equal(server.dispatches(), 1);
  } finally {
    await driver.detach();
    await server.task;
  }
});

for (const behavior of ["refresh", "identity-refresh"] as const) {
test(`${behavior} preserves monitoring without redispatching a turn`, async (t) => {
  const { driver, server } = fixture(t, behavior);
  try {
    await driver.attach();
    assert.equal((await driver.send(turn)).text, "Hello world");
    assert.equal(server.dispatches(), 1);
    assert.equal(server.cancellations(), 0);
  } finally {
    await driver.detach();
    await server.task;
  }
});
}

test("disabling the selected agent during refresh still fails closed", async (t) => {
  const { driver, server } = fixture(t, "changed-agent");
  try {
    await driver.attach();
    await assert.rejects(driver.send(turn), /agent.*unavailable/);
    assert.equal(server.dispatches(), 1);
    assert.equal(server.cancellations(), 0);
  } finally {
    await driver.detach();
    await server.task;
  }
});

test("changing the selected agent definition during refresh still fails closed", async (t) => {
  const { driver, server } = fixture(t, "changed-definition");
  try {
    await driver.attach();
    await assert.rejects(driver.send(turn), /selected agent configuration changed/);
    assert.equal(server.dispatches(), 1);
    assert.equal(server.cancellations(), 0);
  } finally {
    await driver.detach();
    await server.task;
  }
});

for (const [behavior, expected] of [
  ["approval", /requires approval/],
  ["result-approval", /result requires approval/],
  ["session-input", /requires user input or approval/],
  ["disconnect", /disconnected.*outcome is unknown/],
  ["timeout", /timed out.*outcome is unknown/],
  ["mismatch", /did not confirm the requested agent and model/],
  ["rejected", /rejected the turn/],
  ["workspace-change", /workspace changed/],
  ["session-workspace-change", /workspace or chat changed/],
  ["chat-change", /workspace or chat changed/],
] as const) {
  test(`AHP ${behavior} fails closed without repeating or approving the turn`, async (t) => {
    const { driver, server } = fixture(t, behavior);
    try {
      await driver.attach();
      await assert.rejects(driver.send({ ...turn, timeoutMs: 100 }), expected);
      await assert.rejects(driver.send(turn), /operator review/);
      assert.equal(server.dispatches(), 1);
    } finally {
      await driver.detach();
      await server.task;
    }
  });
}

test("unknown agent or model fails before a turn is dispatched", async (t) => {
  const { driver, server } = fixture(t);
  try {
    await driver.attach();
    await assert.rejects(driver.verifySelections([{ ...turn, model: "Unknown" }]), /model.*unavailable/);
    await assert.rejects(driver.verifySelections([{ ...turn, agent: "Unknown" }]), /agent.*unavailable/);
    assert.equal(server.dispatches(), 0);
  } finally {
    await driver.detach();
    await server.task;
  }
});

test("read-only synchronization inspects an active turn and its terminal without sending a message", async (t) => {
  const { driver, server } = fixture(t, "inspect", undefined, true);
  try {
    await driver.attach();
    const state = await driver.inspect();
    assert.deepEqual(state.activeTurn, { id: "current", text: "Current progress" });
    assert.deepEqual(state.recentTurns, [{ id: "past", state: "complete", text: "Earlier result" }]);
    assert.deepEqual(state.terminals, [{ title: "Test terminal", text: "Terminal output" }]);
    assert.equal(server.dispatches(), 0);
  } finally {
    await driver.detach();
    await server.task;
  }
});

test("normal attachment still rejects an already active session", async (t) => {
  const { driver, server } = fixture(t, "inspect");
  await assert.rejects(driver.attach(), /active turn or pending input/);
  await server.task;
});

test("recovery reads an already completed turn without dispatching it again", async (t) => {
  const { driver, server } = fixture(t, "recover-complete", undefined, true);
  try {
    await driver.attach();
    assert.equal((await driver.recoverTurn(RECOVERED_ID, turn)).text, "Completed response");
    await assert.rejects(driver.recoverTurn("missing", turn), /missing or is not the latest/);
    assert.equal(server.dispatches(), 0);
  } finally {
    await driver.detach();
    await server.task;
  }
});

test("reconciliation cancels an unexpected tool request", async (t) => {
  const { driver, server } = fixture(t, "unexpected-tool");
  try {
    await driver.attach();
    await assert.rejects(driver.send({ ...turn, noTools: true }), /attempted a tool.*Cancellation was requested/);
    assert.equal(server.dispatches(), 1);
    assert.equal(server.cancellations(), 1);
  } finally {
    await driver.detach();
    await server.task;
  }
});

test("recovery rejects a reconciliation that used a tool", async (t) => {
  const { driver, server } = fixture(t, "recover-tool", undefined, true);
  try {
    await driver.attach();
    await assert.rejects(driver.recoverTurn(RECOVERED_ID, { ...turn, noTools: true }), /used a tool/);
    assert.equal(server.dispatches(), 0);
  } finally {
    await driver.detach();
    await server.task;
  }
});

for (const behavior of ["recover-active", "recover-refresh", "recover-pending", "recover-input"] as const) {
  test(`recovery follows ${behavior} without resending the turn`, async (t) => {
    const { driver, server } = fixture(t, behavior, undefined, true);
    try {
      await driver.attach();
      assert.equal((await driver.recoverTurn(RECOVERED_ID, turn, 1000)).text, "Partial recovered");
      assert.equal(server.dispatches(), 0);
    } finally {
      await driver.detach();
      await server.task;
    }
  });
}

for (const approved of [true, false]) {
  test(`driver sends a human ${approved ? "approval" : "denial"} and continues the turn`, async (t) => {
    let seen = 0;
    const handler: ApprovalHandler = async (request) => {
      seen++;
      assert.equal(request.toolName, "read_file");
      assert.equal(request.input, "{\"path\":\"test.txt\"}");
      return { approved, by: "human" };
    };
    const { driver, server } = fixture(t, "respond-approval", handler);
    try {
      await driver.attach();
      assert.equal((await driver.send(turn)).text, "Hello");
      assert.equal(server.dispatches(), 1);
      assert.equal(seen, 1);
    } finally {
      await driver.detach();
      await server.task;
    }
  });
}

test("driver responds to a tool result confirmation", async (t) => {
  const { driver, server } = fixture(t, "respond-result", async (request) => {
    assert.equal(request.kind, "result");
    return { approved: true, by: "human" };
  });
  try {
    await driver.attach();
    assert.equal((await driver.send(turn)).text, "Hello");
  } finally {
    await driver.detach();
    await server.task;
  }
});

test("the harness keeps watching when a human resolves agent input in VS Code", async (t) => {
  const { driver, server } = fixture(t, "input-resolved", async () => ({ approved: false, by: "human" }));
  try {
    await driver.attach();
    assert.equal((await driver.send(turn)).idle, true);
    assert.equal(server.dispatches(), 1);
  } finally {
    await driver.detach();
    await server.task;
  }
});

test("an approval made in VS Code cancels the harness prompt without duplicate approval", async (t) => {
  let aborted = false;
  const handler: ApprovalHandler = async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
  });
  const { driver, server } = fixture(t, "external-approval", handler);
  try {
    await driver.attach();
    assert.equal((await driver.send(turn)).idle, true);
    assert.equal(aborted, true);
    assert.equal(server.dispatches(), 1);
  } finally {
    await driver.detach();
    await server.task;
  }
});

test("a timeout cancels an outstanding approval prompt", async (t) => {
  let aborted = false;
  const handler: ApprovalHandler = async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
  });
  const { driver, server } = fixture(t, "approval", handler);
  try {
    await driver.attach();
    await assert.rejects(driver.send({ ...turn, timeoutMs: 100 }), /timed out/);
    assert.equal(aborted, true);
  } finally {
    await driver.detach();
    await server.task;
  }
});

for (const create of [false, true]) {
test(`the epic runs ${create ? "creation, " : ""}development, fresh review and Phase 1 through AHP`, async (t) => {
  const { root, repo, driver, server } = fixture(t, create ? "create-story" : "story");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".harness/\n");
  git("add", ".gitignore");
  git("commit", "-qm", "base");
  fs.mkdirSync(path.join(repo, "stories"));
  if (create) fs.writeFileSync(path.join(repo, "epics.md"), [
    "# Plan", "", "## Epic 1: Work", "", "### Story 1.1: Mock story", "",
    "**Acceptance Criteria:**", "1. Execute a simulated feature", "",
  ].join("\n"));
  else fs.writeFileSync(path.join(repo, "stories", "1.1.md"), [
    "# Story 1.1: Mock story", "", "## Status", "Ready", "",
    "## Acceptance Criteria", "1. Execute a simulated feature", "",
  ].join("\n"));
  const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
  const configFile = path.join(root, "config.yaml");
  fs.writeFileSync(configFile, YAML.stringify({
    ...template, repo, stories_dir: "stories",
    story_creation: { enabled: create, epics_file: "epics.md", agent: "bmad-agent-pm", model: "Configured model" },
    bmad: {
      ...template.bmad,
      models: { ...template.bmad.models, develop: "Configured model", review: "Configured reviewer" },
    },
    phase1: { ...template.phase1, blindness: { ...template.phase1.blindness, exclude: ["stories/**"], max_verbatim_overlap: 1 } },
  }));
  const cfg = loadConfig(configFile, { requireAzureKey: false });
  class TestAzure extends Azure {
    calls = 0;
    override async askJson<T>(_opts: Omit<Ask, "json">, shape: { parse: (value: unknown) => T }): Promise<T> {
      this.calls++;
      const value = this.calls === 1
        ? { summary: "Adds a simulated feature.", confidence: 0.9 }
        : this.calls === 2
          ? { criteria: [{ id: "AC1", verdict: "covered", evidence: "implemented" }], overall: "matched" }
          : { criteria: ["AC1", "AC2"].map((id) => ({ id, verdict: "missing", evidence: "unrelated" })), overall: "different" };
      return shape.parse(value);
    }
  }
  const azure = new TestAzure(cfg.azure);
  const ledger = new Ledger(root, "run");
  const decider = new Decider(cfg, ledger, azure);
  try {
    await driver.attach();
    const result = await runEpic("epic-1", { cfg, azure, ledger, vscode: driver, decider });
    assert.equal(result.outcome, "finished");
    assert.equal(server.dispatches(), create ? 3 : 2);
    assert.equal(azure.calls, 3);
    assert.ok(ledger.read().some((event) => event.type === "phase1" && event.outcome === "pass"));
  } finally {
    await driver.detach();
    await server.task;
  }
});
}

test("a restarted harness recovers the completed development turn and continues without repeating it", async (t) => {
  const { root, repo, driver, server } = fixture(t, "recover-story", undefined, true);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".harness/\n");
  git("add", ".gitignore");
  git("commit", "-qm", "base");
  fs.mkdirSync(path.join(repo, "stories"));
  fs.writeFileSync(path.join(repo, "stories", "1.1.md"), [
    "# Story 1.1: Mock story", "", "## Status", "Review", "",
    "## Acceptance Criteria", "1. Execute a simulated feature", "",
  ].join("\n"));
  const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
  const configFile = path.join(root, "config.yaml");
  fs.writeFileSync(configFile, YAML.stringify({
    ...template, repo, stories_dir: "stories", story_creation: { enabled: false },
    bmad: {
      ...template.bmad,
      models: { ...template.bmad.models, develop: "Configured model", review: "Configured reviewer" },
    },
    phase1: { ...template.phase1, blindness: { ...template.phase1.blindness, exclude: ["stories/**"], max_verbatim_overlap: 1 } },
  }));
  const cfg = loadConfig(configFile, { requireAzureKey: false });
  const story = findStories(repo, "stories")[0]!;
  const ledger = new Ledger(root, "run");
  const filename = `baseline-${createHash("sha256").update(story.file).digest("hex")}.json.gz`;
  saveBaseline(path.join(ledger.dir, filename), snapshotWorktree(repo, { ignore: cfg.phase1.ignore }));
  ledger.write({ type: "run_started", epic: "epic-1", mode: "watch", repo, pid: 2147483647, session: "selected" });
  ledger.write({ type: "story_session", story: story.id, session: "ahp-session:/test" });
  ledger.write({ type: "story_baseline", story: story.id, file: filename, ignore: cfg.phase1.ignore });
  ledger.write({
    type: "turn_started", story: story.id, stage: "develop", turnId: RECOVERED_ID,
    agent: cfg.bmad.agents.develop, model: cfg.bmad.models.develop,
  });
  fs.writeFileSync(path.join(repo, "app.ts"), "export const implemented = true;\n");
  class TestAzure extends Azure {
    calls = 0;
    override async askJson<T>(_opts: Omit<Ask, "json">, shape: { parse: (value: unknown) => T }): Promise<T> {
      this.calls++;
      return shape.parse(this.calls === 1 ? { summary: "Adds a simulated feature.", confidence: 0.9 }
        : this.calls === 2 ? { criteria: [{ id: "AC1", verdict: "covered", evidence: "implemented" }], overall: "matched" }
          : { criteria: ["AC1", "AC2"].map((id) => ({ id, verdict: "missing", evidence: "unrelated" })), overall: "different" });
    }
  }
  const azure = new TestAzure(cfg.azure);
  const decider = new Decider(cfg, ledger, azure);
  try {
    await driver.attach();
    const recovery = await recoverRecordedTurn({ cfg, ledger, story, session: "ahp-session:/test", driver });
    const assessment = await askRecoveryAgent({
      cfg, ledger, story, vscode: driver, previousStage: recovery.stage, originalTurnId: recovery.turnId,
    });
    assert.equal(assessment.next_step, "review");
    const result = await runStory(story, {
      cfg, azure, ledger, vscode: driver, decider, allStories: [story], spend() {}, recovery,
    });
    assert.equal(result.outcome, "done");
    assert.equal(server.dispatches(), 2);
    assert.equal(azure.calls, 3);
  } finally {
    await driver.detach();
    await server.task;
  }
});

test("the epic stops before the next story when Phase 1 escalates", async (t) => {
  const { root, repo, driver, server } = fixture(t, "story");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".harness/\n");
  git("add", ".gitignore");
  git("commit", "-qm", "base");
  fs.mkdirSync(path.join(repo, "stories"));
  for (const id of ["1.1", "1.2"]) {
    fs.writeFileSync(path.join(repo, "stories", `${id}.md`), [
      `# Story ${id}: Mock story`, "", "## Status", "Ready", "",
      "## Acceptance Criteria", "1. Execute a simulated feature", "",
    ].join("\n"));
  }
  const project = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const template = YAML.parse(fs.readFileSync(path.join(project, "harness.config.yaml"), "utf8"));
  const configFile = path.join(root, "config.yaml");
  fs.writeFileSync(configFile, YAML.stringify({
    ...template, repo, stories_dir: "stories", story_creation: { enabled: false },
    bmad: {
      ...template.bmad,
      models: { ...template.bmad.models, develop: "Configured model", review: "Configured reviewer" },
    },
    phase1: { ...template.phase1, blindness: { ...template.phase1.blindness, exclude: ["stories/**"], max_verbatim_overlap: 1 } },
  }));
  const cfg = loadConfig(configFile, { requireAzureKey: false });
  class EscalatingAzure extends Azure {
    calls = 0;
    override async askJson<T>(_opts: Omit<Ask, "json">, shape: { parse: (value: unknown) => T }): Promise<T> {
      this.calls++;
      if (this.calls === 3) throw new Error("decoy unavailable");
      return shape.parse(this.calls === 1
        ? { summary: "Adds a simulated feature.", confidence: 0.9 }
        : { criteria: [{ id: "AC1", verdict: "covered", evidence: "implemented" }], overall: "matched" });
    }
    override async ask(): Promise<string> { return "Test escalation."; }
  }
  const azure = new EscalatingAzure(cfg.azure);
  const ledger = new Ledger(root, "run");
  const decider = new Decider(cfg, ledger, azure);
  try {
    await driver.attach();
    const result = await runEpic("epic-1", { cfg, azure, ledger, vscode: driver, decider });
    assert.equal(result.outcome, "stopped");
    assert.equal(server.dispatches(), 2);
    assert.deepEqual(ledger.read().filter((event) => event.type === "story_started").map((event) => event.story), ["1.1"]);
  } finally {
    await driver.detach();
    await server.task;
  }
});
