import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ActionType, MessageKind, SUPPORTED_PROTOCOL_VERSIONS, ToolCallCancellationReason, ToolCallConfirmationReason, sessionReducer,
  type AgentCustomization, type ChatState, type RootState, type SessionInputRequest, type SessionModelInfo, type SessionState,
} from "@microsoft/agent-host-protocol";
import { AhpClient, type AhpTransport, type Subscription, type SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import type { VSCode, Turn, Reply } from "./types.js";
import type { AvailableSession } from "./sessions.js";
import { connectEndpoint, discoverEndpoint } from "./transport.js";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "./approval.js";

const RootSnapshot = z.object({
  agents: z.array(z.object({
    provider: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string(), provider: z.string() })),
  })),
}).passthrough();
const SessionSnapshot = z.object({
  provider: z.string(), title: z.string(), status: z.number(), lifecycle: z.string(),
  workingDirectories: z.array(z.string()), chats: z.array(z.object({ resource: z.string() })),
  defaultChat: z.string().optional(), customizations: z.array(z.unknown()).optional(),
  inputNeeded: z.array(z.unknown()).optional(),
}).passthrough();
const ChatSnapshot = z.object({
  resource: z.string(), status: z.number(), activeTurn: z.unknown().optional(),
  workingDirectories: z.array(z.string()).optional(),
}).passthrough();

export type AttachmentOptions = {
  session: AvailableSession;
  transport?: AhpTransport;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  onApproval?: ApprovalHandler;
  onApprovalResolved?: (decision: { toolCallId: string; kind: "tool" | "result"; approved: boolean; source: string }) => void;
  allowActive?: boolean;
};

export type SessionInspection = {
  session: string;
  chat: string;
  title: string;
  activeTurn?: { id: string; text: string };
  recentTurns: { id: string; state: string; text: string }[];
  pendingInputs: number;
  terminals: { title: string; text: string }[];
};

/** Drives the explicitly selected session over the Agent Host Protocol. */
export class AttachedSession implements VSCode {
  private client?: AhpClient;
  private root?: RootState;
  private session?: SessionState;
  private chatId = "";
  private chat?: ChatState;
  private sessionSubscription?: Subscription;
  private unusable = false;
  private running = false;

  constructor(private repo: string, private opts: AttachmentOptions) {}

  get describe() { return this.session?.title ?? this.opts.session.title; }
  get folder() { return this.repo; }

  setApprovalHandler(handler: ApprovalHandler): void {
    if (this.running) throw new Error("Cannot change approval policy during an agent turn.");
    this.opts.onApproval = handler;
  }

  async attach(): Promise<void> {
    if (this.client) throw new Error("The agent session is already attached.");
    const transport = this.opts.transport ?? await connectEndpoint(await discoverEndpoint(this.opts.session.host));
    const client = new AhpClient(transport, {
      requestTimeoutMs: this.opts.requestTimeoutMs ?? 15_000,
      subscriptionBuffer: 16_384,
    });
    this.client = client;
    try {
      client.connect();
      const init = await client.initialize({
        clientId: `bmad-harness-${randomUUID()}`,
        protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        initialSubscriptions: ["ahp-root://"],
      });
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(init.protocolVersion)) {
        throw new Error("The agent host selected an unsupported protocol version.");
      }
      const root = init.snapshots.find((snapshot) => snapshot.resource === "ahp-root://");
      if (!root || !RootSnapshot.safeParse(root.state).success || !("agents" in root.state)) {
        throw new Error("The agent host did not provide a valid root snapshot.");
      }
      this.root = root.state;
      const sessionSub = await client.subscribe(this.opts.session.resource);
      this.sessionSubscription = sessionSub.subscription;
      const sessionSnapshot = sessionSub.result.snapshot;
      if (!sessionSnapshot || sessionSnapshot.resource !== this.opts.session.resource ||
          !SessionSnapshot.safeParse(sessionSnapshot.state).success || !("activeClients" in sessionSnapshot.state)) {
        throw new Error("The selected session did not provide a valid session snapshot.");
      }
      this.session = sessionSnapshot.state;
      await this.refreshChat(this.opts.allowActive);
    } catch (error) {
      await this.detach();
      throw error;
    }
  }

  async verifySelections(turns: { agent: string; model: string }[]): Promise<void> {
    await this.refreshRootAndSession();
    await this.refreshChat();
    for (const turn of turns) this.resolveSelection(turn);
  }

  async inspect(): Promise<SessionInspection> {
    await this.refreshRootAndSession();
    await this.refreshChat(true);
    const session = this.session;
    const chat = this.chat;
    if (!session || !chat) throw new Error("The agent session state is unavailable.");
    const recent = chat.turns.slice(-5);
    const terminalResources = new Set<string>();
    for (const turn of [...recent, ...(chat.activeTurn ? [chat.activeTurn] : [])]) {
      for (const part of turn.responseParts) {
        if (part.kind !== "toolCall" || !("content" in part.toolCall) || !Array.isArray(part.toolCall.content)) continue;
        for (const content of part.toolCall.content) {
          if (content.type === "terminal") terminalResources.add(content.resource);
        }
      }
    }
    for (const work of chat.backgroundWork ?? []) {
      if (work.kind === "shell" && work.terminal) terminalResources.add(work.terminal);
    }
    const terminals: SessionInspection["terminals"] = [];
    for (const resource of [...terminalResources].slice(-5)) {
      const { result } = await this.requireClient().subscribe(resource);
      const snapshot = result.snapshot;
      if (!snapshot || snapshot.resource !== resource || !("claim" in snapshot.state) ||
          !("content" in snapshot.state) || !Array.isArray(snapshot.state.content)) {
        throw new Error("A session terminal did not provide a valid snapshot.");
      }
      const terminal = snapshot.state;
      if (terminal.claim.kind !== "session" || terminal.claim.session !== this.opts.session.resource ||
          terminal.claim.chat !== this.chatId) {
        throw new Error("A terminal in the session snapshot belongs to a different session or chat.");
      }
      terminals.push({
        title: terminal.title,
        text: terminal.content.map((part) => part.type === "command" ? part.output : part.value).join("").slice(-4000),
      });
      await this.requireClient().unsubscribe(resource);
    }
    return {
      session: this.opts.session.resource,
      chat: this.chatId,
      title: session.title,
      activeTurn: chat.activeTurn ? { id: chat.activeTurn.id, text: responseText(chat.activeTurn.responseParts) } : undefined,
      recentTurns: recent.map((turn) => ({ id: turn.id, state: turn.state, text: responseText(turn.responseParts) })),
      pendingInputs: session.inputNeeded?.length ?? 0,
      terminals,
    };
  }

  async recoverTurn(turnId: string, selection: { agent: string; model: string; noTools?: boolean }, timeoutMs?: number): Promise<Reply> {
    if (this.running) throw new Error("A harness turn is already in progress.");
    if (this.unusable) throw new Error("The session needs operator review after an interrupted turn.");
    this.running = true;
    try {
      await this.refreshRootAndSession();
      const subscription = await this.refreshChat(true);
      const chat = this.chat;
      if (!chat) throw new Error("The selected chat state is unavailable.");
      const { agent, model } = this.resolveSelection(selection);
      const active = chat.activeTurn;
      if (active && active.id !== turnId) {
        throw new Error("A different turn is active in the selected chat; refusing to resume.");
      }
      if (active) {
        verifyRecoveredSelection(active.message, agent.uri, model.id);
        if (selection.noTools && active.responseParts.some((part) => part.kind === "toolCall")) {
          throw new Error("The recovered reconciliation turn used a tool; inspect the session before proceeding.");
        }
        const parts = new Map(active.responseParts.filter((part) => part.kind === "markdown").map((part) => [part.id, part.content]));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            "The recovered turn timed out. Inspect the VS Code session before retrying.",
          )), timeoutMs ?? this.opts.turnTimeoutMs ?? 25 * 60_000);
        });
        try {
          return await Promise.race([
            this.waitForTurn(subscription, turnId, agent.uri, model.id, {
              parts, pending: this.session?.inputNeeded ?? [],
            }, selection.noTools),
            deadline,
          ]);
        } catch (error) {
          this.unusable = true;
          await this.detach();
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      const matches = chat.turns.filter((turn) => turn.id === turnId);
      if (matches.length !== 1 || chat.turns[chat.turns.length - 1]?.id !== turnId) {
        throw new Error(
          "The recorded turn is missing or is not the latest turn. Its outcome is uncertain; inspect the session before proceeding.",
        );
      }
      const completed = matches[0]!;
      verifyRecoveredSelection(completed.message, agent.uri, model.id);
      if (completed.state !== "complete") {
        throw new Error(`The recorded turn ended with state "${completed.state}"; inspect the session before proceeding.`);
      }
      if (selection.noTools && completed.responseParts.some((part) => part.kind === "toolCall")) {
        throw new Error("The recovered reconciliation turn used a tool; inspect the session before proceeding.");
      }
      return { text: responseText(completed.responseParts), changed: [], idle: true };
    } finally {
      this.running = false;
    }
  }

  async send(turn: Turn): Promise<Reply> {
    if (this.running) throw new Error("A harness turn is already in progress.");
    if (this.unusable) throw new Error("The session needs operator review after an interrupted turn.");
    this.running = true;
    try {
      await this.refreshRootAndSession();
      const chatSub = await this.refreshChat();
      const { agent, model } = this.resolveSelection(turn);
      const client = this.requireClient();
      const turnId = turn.id ?? randomUUID();
      const timeoutMs = turn.timeoutMs ?? this.opts.turnTimeoutMs ?? 25 * 60_000;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(
          "The agent turn timed out. Its outcome is unknown; inspect the VS Code session before retrying.",
        )), timeoutMs);
      });
      try {
        const waiting = this.waitForTurn(chatSub, turnId, agent.uri, model.id, undefined, turn.noTools);
        client.dispatch(this.chatId, {
          type: ActionType.ChatTurnStarted,
          turnId,
          startedAt: new Date().toISOString(),
          message: { text: turn.say, origin: { kind: MessageKind.User }, agent: { uri: agent.uri }, model: { id: model.id } },
        });
        return await Promise.race([waiting, deadline]);
      } catch (error) {
        this.unusable = true;
        await this.detach();
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } finally {
      this.running = false;
    }
  }

  readFile(rel: string): string | null {
    const file = path.join(this.repo, rel);
    try {
      return fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  removeFile(rel: string): void {
    const file = path.join(this.repo, rel);
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  async detach(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.shutdown();
  }

  private requireClient(): AhpClient {
    if (!this.client) throw new Error("The VS Code agent session is not attached.");
    return this.client;
  }

  private async refreshRootAndSession(): Promise<void> {
    const client = this.requireClient();
    await client.unsubscribe("ahp-root://");
    const rootSub = await client.subscribe("ahp-root://");
    const root = rootSub.result.snapshot;
    if (!root || root.resource !== "ahp-root://" ||
        !RootSnapshot.safeParse(root.state).success || !("agents" in root.state)) {
      throw new Error("The agent host root state is unavailable or invalid.");
    }
    this.root = root.state;
    await client.unsubscribe(this.opts.session.resource);
    const sessionSub = await client.subscribe(this.opts.session.resource);
    this.sessionSubscription = sessionSub.subscription;
    const snapshot = sessionSub.result.snapshot;
    if (!snapshot || snapshot.resource !== this.opts.session.resource ||
        !SessionSnapshot.safeParse(snapshot.state).success || !("activeClients" in snapshot.state)) {
      throw new Error("The selected agent session is no longer available.");
    }
    this.session = snapshot.state;
  }

  private async refreshChat(allowActive = false): Promise<Subscription> {
    const client = this.requireClient();
    const session = this.session;
    if (!session || session.lifecycle !== "ready") throw new Error("The selected agent session is not ready.");
    if (!matchesDirectories(session.workingDirectories, this.repo)) {
      throw new Error("The selected session no longer has the configured repository as a working directory.");
    }
    if (!allowActive && (session.status & 8 || session.inputNeeded?.length)) {
      throw new Error("The selected session has an active turn or pending input. Resolve it in VS Code first.");
    }
    if (session.status & 64) throw new Error("The selected session is archived; reopen it in VS Code first.");
    if (!allowActive && (!(session.status & 1) || session.status & 2)) throw new Error("The selected session is not idle.");
    const chatId = session.defaultChat;
    if (!chatId || !session.chats.some((chat) => chat.resource === chatId)) {
      throw new Error("The selected session has no unambiguous default chat.");
    }
    if (this.chatId) await client.unsubscribe(this.chatId);
    const chatSub = await client.subscribe(chatId);
    const snapshot = chatSub.result.snapshot;
    const parsed = snapshot ? ChatSnapshot.safeParse(snapshot.state) : undefined;
    if (!snapshot || snapshot.resource !== chatId || !parsed?.success || parsed.data.resource !== chatId ||
        !("turns" in snapshot.state)) {
      throw new Error("The selected chat did not provide a valid snapshot.");
    }
    if (!allowActive && (parsed.data.activeTurn || parsed.data.status & 8 || parsed.data.status & 64)) {
      throw new Error("The selected chat is busy, awaiting input, or archived.");
    }
    if (!allowActive && (!(parsed.data.status & 1) || parsed.data.status & 2)) throw new Error("The selected chat is not idle.");
    if (!matchesDirectories(parsed.data.workingDirectories ?? session.workingDirectories, this.repo)) {
      throw new Error("The selected chat cannot access the configured repository.");
    }
    this.chatId = chatId;
    this.chat = snapshot.state;
    return chatSub.subscription;
  }

  private resolveSelection(turn: { agent: string; model: string }, allowLoading = false): { agent: AgentCustomization; model: SessionModelInfo } {
    const root = this.root;
    const session = this.session;
    if (!root || !session) throw new Error("The agent host is not fully initialized.");
    const providers = root.agents.filter((agent) => agent.provider === session.provider);
    if (providers.length !== 1) throw new Error("The selected session's agent provider is unavailable or ambiguous.");
    const models = providers[0]!.models.filter((model) =>
      (model.id === turn.model || model.name === turn.model) &&
      (model.policyState === undefined || model.policyState === "enabled"));
    if (models.length !== 1) throw new Error(`The configured model "${turn.model}" is unavailable or ambiguous.`);

    const candidates: AgentCustomization[] = [];
    for (const container of session.customizations ?? []) {
      if (container.type !== "directory" && container.type !== "plugin") continue;
      if (container.type === "directory" && !container.enabled) continue;
      if (container.type === "plugin" && container.enablement?.some((decision) => !decision.enabled)) continue;
      if (!allowLoading && container.load && container.load.kind !== "loaded") continue;
      for (const child of container.children ?? []) {
        if (child.type === "agent" && (child.name === turn.agent || child.uri === turn.agent) &&
            child.enabled !== false && child.disableUserInvocation !== true) candidates.push(child);
      }
    }
    const expected = path.join(this.repo, ".github", "agents", `${turn.agent}.agent.md`);
    const preferred = candidates.filter((candidate) => samePath(candidate.uri, expected));
    const available = preferred.length ? preferred : candidates;
    if (available.length !== 1) throw new Error(`The configured BMAD agent "${turn.agent}" is unavailable or ambiguous.`);
    const agent = available[0]!;
    const model = models[0]!;
    if (agent.model && agent.model !== model.id && agent.model !== model.name) {
      throw new Error(`The configured agent "${turn.agent}" is pinned to a different model.`);
    }
    return { agent, model };
  }

  private selectionSignature(agentUri: string, modelId: string): string {
    const { agent } = this.resolveSelection({ agent: agentUri, model: modelId }, true);
    const contents = agentUri.startsWith("file:")
      ? createHash("sha256").update(fs.readFileSync(fileURLToPath(agentUri))).digest("hex") : undefined;
    return JSON.stringify([Object.entries(agent).sort(([a], [b]) => a.localeCompare(b)), contents]);
  }

  private async waitForTurn(
    subscription: Subscription, id: string, agentUri: string, modelId: string,
    recovered?: { parts: Map<string, string>; pending: SessionInputRequest[] },
    noTools = false,
  ): Promise<Reply> {
    const selectionSignature = this.selectionSignature(agentUri, modelId);
    let acknowledged = !!recovered;
    const parts = recovered?.parts ?? new Map<string, string>();
    const toolNames = new Map<string, string>();
    const requests = new Map<string, { request: ApprovalRequest; state: "queued" | "prompting" | "submitted"; controller?: AbortController }>();
    const resolved = new Map<string, number>();
    const sessionRequests = new Map<string, string>();
    const sessionAttention = new Map<string, string>();
    const inputRequests = new Set<string>();
    let activeKey: string | undefined;
    let decisionNext: Promise<{ source: "decision"; key: string; decision?: ApprovalDecision; error?: unknown }> | undefined;

    const startNext = () => {
      if (activeKey || !this.opts.onApproval) return;
      const entry = [...requests.values()].find((value) => value.state === "queued");
      if (!entry) return;
      entry.state = "prompting";
      entry.controller = new AbortController();
      activeKey = entry.request.key;
      const handler = this.opts.onApproval;
      decisionNext = Promise.resolve().then(() => handler(entry.request, entry.controller!.signal)).then(
        (decision) => ({ source: "decision" as const, key: entry.request.key, decision }),
        (error: unknown) => ({ source: "decision" as const, key: entry.request.key, error }),
      );
    };

    const enqueue = (request: ApprovalRequest, seq: number) => {
      if ((resolved.get(request.key) ?? -1) >= seq || requests.has(request.key)) return;
      if (!this.opts.onApproval) {
        throw new Error("A tool requires approval in VS Code. No approval was sent; inspect the active turn before retrying.");
      }
      requests.set(request.key, { request, state: "queued" });
      startNext();
    };

    const settle = (key: string, seq: number) => {
      resolved.set(key, Math.max(resolved.get(key) ?? -1, seq));
      const entry = requests.get(key);
      if (!entry) return;
      entry.controller?.abort();
      requests.delete(key);
      if (activeKey === key) { activeKey = undefined; decisionNext = undefined; }
      startNext();
    };

    const notifyInput = (requestId: string) => {
      if (inputRequests.has(requestId)) return;
      inputRequests.add(requestId);
      console.log("\nThe agent needs input in VS Code. Resolve the request there; the harness will keep watching.");
    };

    const rejectReconciliationTool = async (): Promise<never> => {
      this.requireClient().dispatch(this.chatId, { type: ActionType.ChatTurnCancelled, turnId: id, duration: 0 });
      try {
        await this.requireClient().ping();
      } catch {
        throw new Error("The reconciliation turn attempted a tool, but cancellation could not be confirmed. Inspect the session.");
      }
      throw new Error("The reconciliation turn attempted a tool. Cancellation was requested; inspect the session before proceeding.");
    };

    for (const pending of recovered?.pending ?? []) {
      if (pending.chat !== this.chatId) continue;
      if (pending.kind === "toolConfirmation" && pending.turnId === id) {
        const call = pending.toolCall;
        const kind = call.status === "pending-result-confirmation" ? "result" : "tool";
        const key = `${kind}:${call.toolCallId}`;
        sessionRequests.set(pending.id, key);
        requests.set(key, {
          state: "submitted",
          request: {
            key, turnId: id, toolCallId: call.toolCallId, kind, toolName: call.toolName,
            message: text(call.invocationMessage), hasRiskAssessment: true,
          },
        });
        console.log("\nA recovered tool request needs attention in VS Code. Resolve it there; the harness will keep watching.");
      } else if (pending.kind === "chatInput") {
        sessionAttention.set(pending.id, pending.request.id);
        notifyInput(pending.request.id);
      } else if (pending.kind === "toolAuthentication") {
        const attention = `auth:${pending.toolCall.toolCallId}`;
        sessionAttention.set(pending.id, attention);
        notifyInput(attention);
      }
    }

    const sessionSubscription = this.sessionSubscription;
    if (!sessionSubscription) throw new Error("The session subscription is unavailable.");
    let chatNext = subscription.next().then((result) => ({ source: "chat" as const, result }));
    let sessionNext = sessionSubscription.next().then((result) => ({ source: "session" as const, result }));
    try {
      while (true) {
        const next = await Promise.race(decisionNext ? [chatNext, sessionNext, decisionNext] : [chatNext, sessionNext]);
        if (next.source === "decision") {
          if (activeKey !== next.key) continue;
          const entry = requests.get(next.key);
          activeKey = undefined;
          decisionNext = undefined;
          if (!entry) { startNext(); continue; }
          if (next.error || !next.decision) {
            const reason = next.error instanceof Error ? next.error.message : "approval handler failed";
            throw new Error(`Could not resolve tool approval: ${reason}`);
          }
          entry.state = "submitted";
          const decision = next.decision;
          if (entry.request.kind === "result") {
            this.requireClient().dispatch(this.chatId, {
              type: ActionType.ChatToolCallResultConfirmed, turnId: id,
              toolCallId: entry.request.toolCallId, approved: decision.approved,
            });
          } else if (decision.approved) {
            this.requireClient().dispatch(this.chatId, {
              type: ActionType.ChatToolCallConfirmed, turnId: id,
              toolCallId: entry.request.toolCallId, approved: true,
              confirmed: decision.by === "human" ? ToolCallConfirmationReason.UserAction : ToolCallConfirmationReason.Setting,
              ...(decision.optionId ? { selectedOptionId: decision.optionId } : {}),
            });
          } else {
            this.requireClient().dispatch(this.chatId, {
              type: ActionType.ChatToolCallConfirmed, turnId: id,
              toolCallId: entry.request.toolCallId, approved: false, reason: ToolCallCancellationReason.Denied,
              ...(decision.optionId ? { selectedOptionId: decision.optionId } : {}),
            });
          }
          startNext();
          continue;
        }
        if (next.result.done) {
          throw new Error("The agent host disconnected during the turn. Its outcome is unknown; inspect the session before retrying.");
        }
        const event: SubscriptionEvent = next.result.value;
        if (next.source === "chat") chatNext = subscription.next().then((result) => ({ source: "chat" as const, result }));
        else sessionNext = sessionSubscription.next().then((result) => ({ source: "session" as const, result }));
        if (event.type === "authRequired") {
          throw new Error("The agent host requires authentication. Resolve it in VS Code before retrying.");
        }
        if (event.type !== "action") continue;
        const { action, rejectionReason, serverSeq } = event.params;
        if (next.source === "session") {
          switch (action.type) {
            case ActionType.SessionInputNeededSet:
              if (action.request.chat !== this.chatId) break;
              if (noTools && action.request.kind !== "chatInput" && action.request.turnId === id) {
                await rejectReconciliationTool();
              }
              if (action.request.kind === "chatInput") {
                if (!this.opts.onApproval) throw new Error("The active agent turn requires user input or approval in VS Code; inspect it before retrying.");
                sessionAttention.set(action.request.id, action.request.request.id);
                notifyInput(action.request.request.id);
              } else if (action.request.kind === "toolAuthentication") {
                if (!this.opts.onApproval) throw new Error("The active agent turn requires user input or approval in VS Code; inspect it before retrying.");
                const attention = `auth:${action.request.toolCall.toolCallId}`;
                sessionAttention.set(action.request.id, attention);
                notifyInput(attention);
              } else if (action.request.kind === "toolConfirmation" && action.request.turnId === id) {
                const call = action.request.toolCall;
                const kind = call.status === "pending-result-confirmation" ? "result" : "tool";
                const key = `${kind}:${call.toolCallId}`;
                sessionRequests.set(action.request.id, key);
                enqueue({
                  key, turnId: id, toolCallId: call.toolCallId, kind, toolName: call.toolName,
                  message: text(call.invocationMessage),
                  input: typeof call.toolInput === "string" ? call.toolInput : undefined,
                  hasRiskAssessment: "riskAssessment" in call && !!call.riskAssessment,
                  options: "options" in call ? approvalOptions(call.options) : undefined,
                }, serverSeq);
              }
              break;
            case ActionType.SessionInputNeededRemoved: {
              const key = sessionRequests.get(action.id);
              if (key) { sessionRequests.delete(action.id); settle(key, serverSeq); }
              const attention = sessionAttention.get(action.id);
              if (attention) { sessionAttention.delete(action.id); inputRequests.delete(attention); }
              break;
            }
            case ActionType.SessionWorkingDirectorySet:
            case ActionType.SessionWorkingDirectoryRemoved:
            case ActionType.SessionWorkingDirectoryReplaced:
            case ActionType.SessionDefaultChatChanged: {
              if (!this.session) throw new Error("The selected session state is unavailable during refresh.");
              const refreshed = sessionReducer(this.session, action);
              if (refreshed.defaultChat !== this.chatId || !matchesDirectories(refreshed.workingDirectories, this.repo)) {
                throw new Error(`The session's workspace or chat changed during the turn (${action.type}). Inspect it before retrying.`);
              }
              this.session = refreshed;
              break;
            }
            case ActionType.SessionCustomizationsChanged:
            case ActionType.SessionCustomizationToggled:
            case ActionType.SessionCustomizationUpdated:
            case ActionType.SessionCustomizationRemoved: {
              if (!this.session) throw new Error("The selected session state is unavailable during refresh.");
              this.session = sessionReducer(this.session, action);
              if (this.selectionSignature(agentUri, modelId) !== selectionSignature) {
                throw new Error(`The selected agent configuration changed during the turn (${action.type}). Inspect it before retrying.`);
              }
              console.log(`\nSession refresh verified (${action.type}); still following the original turn ${id}.`);
              break;
            }
          }
          continue;
        }
        if ("turnId" in action && action.turnId !== id) {
          if (action.type === ActionType.ChatTurnStarted) {
            throw new Error("Another turn started in the selected chat. Stop and inspect the session.");
          }
          continue;
        }
        if (rejectionReason) throw new Error(`The agent host rejected the turn: ${rejectionReason}`);
        if (noTools && (action.type === ActionType.ChatToolCallStart || action.type === ActionType.ChatToolCallReady ||
            action.type === ActionType.ChatToolCallComplete ||
            (action.type === ActionType.ChatResponsePart && action.part.kind === "toolCall"))) {
          await rejectReconciliationTool();
        }
        switch (action.type) {
          case ActionType.ChatTurnStarted:
            if (action.message.agent?.uri !== agentUri || action.message.model?.id !== modelId) {
              throw new Error("The host did not confirm the requested agent and model. Inspect the session before retrying.");
            }
            acknowledged = true;
            break;
          case ActionType.ChatResponsePart:
            if (action.part.kind === "markdown") parts.set(action.part.id, action.part.content);
            break;
          case ActionType.ChatDelta:
            parts.set(action.partId, (parts.get(action.partId) ?? "") + action.content);
            break;
          case ActionType.ChatToolCallStart:
            toolNames.set(action.toolCallId, action.toolName);
            break;
          case ActionType.ChatToolCallReady:
            if (!action.confirmed) {
              const key = `tool:${action.toolCallId}`;
              enqueue({
                key, turnId: id, toolCallId: action.toolCallId, kind: "tool",
                toolName: toolNames.get(action.toolCallId),
                message: text(action.invocationMessage),
                input: typeof action.toolInput === "string" ? action.toolInput : undefined,
                hasRiskAssessment: !!action.riskAssessment,
                options: approvalOptions(action.options),
              }, serverSeq);
            } else {
              this.opts.onApprovalResolved?.({ toolCallId: action.toolCallId, kind: "tool", approved: true, source: action.confirmed });
            }
            break;
          case ActionType.ChatToolCallConfirmed:
            this.opts.onApprovalResolved?.({
              toolCallId: action.toolCallId, kind: "tool", approved: action.approved,
              source: action.approved ? action.confirmed : action.reason,
            });
            settle(`tool:${action.toolCallId}`, serverSeq);
            break;
          case ActionType.ChatToolCallResultConfirmed:
            this.opts.onApprovalResolved?.({ toolCallId: action.toolCallId, kind: "result", approved: action.approved, source: "host" });
            settle(`result:${action.toolCallId}`, serverSeq);
            break;
          case ActionType.ChatToolCallAuthRequired:
            if (!this.opts.onApproval) throw new Error("The active agent turn requires user input in VS Code; inspect it before retrying.");
            notifyInput(`auth:${action.toolCallId}`);
            break;
          case ActionType.ChatToolCallAuthResolved:
            inputRequests.delete(`auth:${action.toolCallId}`);
            break;
          case ActionType.ChatInputRequested:
            if (!this.opts.onApproval) throw new Error("The active agent turn requires user input in VS Code; inspect it before retrying.");
            notifyInput(action.request.id);
            break;
          case ActionType.ChatInputCompleted:
            inputRequests.delete(action.requestId);
            break;
          case ActionType.ChatToolCallComplete:
            if (action.requiresResultConfirmation) {
              const key = `result:${action.toolCallId}`;
              if (!this.opts.onApproval) {
                throw new Error("A tool result requires approval in VS Code. No approval was sent; inspect the turn before retrying.");
              }
              enqueue({
                key, turnId: id, toolCallId: action.toolCallId, kind: "result",
                toolName: toolNames.get(action.toolCallId), message: text(action.result.pastTenseMessage),
                hasRiskAssessment: true,
              }, serverSeq);
            }
            break;
          case ActionType.ChatWorkingDirectorySet:
            if (samePath(action.directory, this.repo)) break;
            throw new Error("The chat's workspace changed during the turn. Inspect it before retrying.");
          case ActionType.ChatWorkingDirectoryRemoved:
            throw new Error("The chat's workspace changed during the turn. Inspect it before retrying.");
          case ActionType.ChatError:
            throw new Error(`The agent turn failed: ${action.part.error.message}`);
          case ActionType.ChatTurnCancelled:
            throw new Error("The agent turn was cancelled; inspect the session before retrying.");
          case ActionType.ChatTurnComplete:
            if (!acknowledged) throw new Error("The host did not acknowledge the requested agent and model.");
            if (requests.size || inputRequests.size) throw new Error("The agent turn finished while approvals or input were unresolved.");
            return { text: [...parts.values()].join("\n"), changed: [], idle: true };
        }
      }
    } finally {
      for (const entry of requests.values()) entry.controller?.abort();
    }
  }
}

function verifyRecoveredSelection(
  message: { agent?: { uri: string }; model?: { id: string } }, agent: string, model: string,
): void {
  if (message.agent?.uri !== agent || message.model?.id !== model) {
    throw new Error("The recorded turn does not match the expected agent and model; inspect the session before proceeding.");
  }
}

function responseText(parts: ChatState["turns"][number]["responseParts"]): string {
  return parts.filter((part) => part.kind === "markdown").map((part) => part.content).join("\n").slice(-4000);
}

function text(value: string | { markdown: string }): string {
  return typeof value === "string" ? value : value.markdown;
}

function approvalOptions(options: { id: string; label: string; kind: string }[] | undefined): ApprovalRequest["options"] {
  if (!options) return undefined;
  return options.map((option) => {
    if (option.kind !== "approve" && option.kind !== "deny") {
      throw new Error("The agent host offered an unsupported approval option.");
    }
    return { id: option.id, label: option.label, kind: option.kind };
  });
}

export function matchesSelectedSession(value: unknown, wanted: string, repo: string): boolean {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  const id = session.resource ?? session.sessionId ?? session.id;
  const shortId = wanted.startsWith("ahp-session:/") ? wanted.slice("ahp-session:/".length) : wanted;
  if (id !== wanted && id !== shortId) return false;
  const directories = Array.isArray(session.workingDirectories)
    ? session.workingDirectories
    : [session.workspace ?? session.folder ?? ""];
  return matchesDirectories(directories, repo);
}

function matchesDirectories(directories: unknown[] | undefined, repo: string): boolean {
  return directories?.length === 1 && typeof directories[0] === "string" && samePath(directories[0], repo);
}

function samePath(a: string, b: string): boolean {
  try {
    const left = fs.realpathSync(a.startsWith("file:") ? fileURLToPath(a) : a);
    const right = fs.realpathSync(b);
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  } catch {
    return false;
  }
}
