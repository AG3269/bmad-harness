import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import * as YAML from "yaml";
import { z } from "zod";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { loadConfig } from "../config.js";
import { findConfiguredStories } from "../bmad/stories.js";
import { Ledger } from "../audit/ledger.js";
import { AttachedSession, type SessionInspection } from "../vscode/attach.js";
import { discoverHosts, discoverSessions, sessionStatus, type AvailableSession } from "../vscode/sessions.js";
import { connectEndpoint, discoverEndpoint } from "../vscode/transport.js";
import { readSavedRecoveryAssessment, recoveryAssessmentFingerprint, RECOVERY_DECISION_REQUIRED, RECOVERY_ASSESSMENT_CHANGED, type RecoveryAssessment } from "../run/recover.js";
import { pendingDecision, type PendingDecision } from "./decisions.js";
import { readReview } from "../validate/review.js";

const execFileAsync = promisify(execFile);
const Profile = z.object({ id: z.string().uuid(), name: z.string().min(1).max(80), configFile: z.string().min(1), environmentConfig: z.string().optional() });
const Task = z.object({
  id: z.string().uuid(), profileId: z.string().uuid(), kind: z.enum(["start", "watch", "continue"]),
  target: z.string(), session: z.string(), runId: z.string().optional(), story: z.string().optional(),
  state: z.enum(["queued", "running", "decision", "completed", "error", "detached"]),
  createdAt: z.string(), updatedAt: z.string(), pid: z.number().optional(), error: z.string().optional(),
  acceptUncertainty: z.boolean().optional(),
  assessmentFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type Profile = z.infer<typeof Profile>;
export type Task = z.infer<typeof Task>;
type TaskView = Task & { output: string; decision?: PendingDecision; decisionError?: string };
export type SessionSync = {
  attemptedAt: string; checkedAt?: string; changedAt?: string; revision?: string;
  inspection?: SessionInspection; error?: string;
};
export type Run = {
  id: string; profileId: string; repo: string; target: string; story?: string; title?: string;
  stage?: string; session?: string; turnId?: string; updatedAt: string; outcome?: string;
  error?: string; harnessRunning: boolean; agentStatus: string; recovered: boolean; report: string;
  recoveryPaused: boolean; recoveryAssessment?: RecoveryAssessment; recoveryAssessmentError?: string;
  recoveryAssessmentFingerprint?: string;
  sessionSync?: SessionSync;
  sessionAdvanced: boolean;
  phase1?: { outcome: string; reasons: string[]; at: string };
  phase2?: { outcome: string; reasons: string[]; at: string };
};
type Launch = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
type Dependencies = {
  discover?: typeof discoverSessions; launch?: Launch;
  inspect?: (repo: string, session: AvailableSession) => Promise<SessionInspection>;
};

export class HarnessApp {
  readonly root: string;
  private profiles: Profile[];
  private tasks: Task[];
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  private outputs = new Map<string, string>();
  private secrets = new Set<string>();
  private busy = false;
  private sessionCache = new Map<string, { at: number; sessions: AvailableSession[] }>();
  private discover: typeof discoverSessions;
  private launch: Launch;
  private baseEnvironment = { ...process.env };
  private observations = new Map<string, SessionSync>();
  private polling?: Promise<void>;
  private inspecting = new Map<string, Promise<SessionInspection>>();
  private inspectSession?: Dependencies["inspect"];
  private pollingErrors = new Map<string, string>();

  constructor(readonly baseConfig: string, readonly cwd: string, deps: Dependencies = {}) {
    this.baseConfig = path.resolve(baseConfig);
    this.root = path.join(path.dirname(this.baseConfig), ".harness-state", "app");
    fs.mkdirSync(path.join(this.root, "tasks"), { recursive: true, mode: 0o700 });
    const profilesFile = path.join(this.root, "profiles.json");
    this.profiles = fs.existsSync(profilesFile)
      ? z.array(Profile).parse(JSON.parse(fs.readFileSync(profilesFile, "utf8")))
      : [{ id: randomUUID(), name: "Default workspace", configFile: this.baseConfig }];
    this.write(profilesFile, this.profiles);
    this.tasks = fs.readdirSync(path.join(this.root, "tasks")).filter((file) => file.endsWith(".json")).map((file) => {
      const task = Task.parse(JSON.parse(fs.readFileSync(path.join(this.root, "tasks", file), "utf8")));
      if (task.state === "running" || task.state === "decision" || task.state === "queued") {
        task.state = "detached";
        task.error = "The app restarted. Inspect the original session before reconnecting; no work was resent.";
        this.saveTask(task);
      }
      return task;
    });
    this.discover = deps.discover ?? discoverSessions;
    this.inspectSession = deps.inspect;
    this.launch = deps.launch ?? ((args, directory, env) =>
      spawn(process.execPath, args, { cwd: directory, env, windowsHide: true, stdio: "pipe" }));
    this.config(this.profiles[0]!.id);
  }

  private write(file: string, value: unknown): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  }

  private saveTask(task: Task): void {
    task.updatedAt = new Date().toISOString();
    this.write(path.join(this.root, "tasks", `${task.id}.json`), task);
  }

  profile(id: string): Profile {
    const profile = this.profiles.find((item) => item.id === id);
    if (!profile) throw new Error("Unknown workspace profile.");
    return profile;
  }

  config(id: string) {
    const env = { ...this.baseEnvironment };
    const profile = this.profile(id);
    if (profile.environmentConfig) loadConfig(profile.environmentConfig, { requireAzureKey: false, env });
    const cfg = loadConfig(profile.configFile, { requireAzureKey: false, env });
    for (const [key, value] of Object.entries(env)) {
      if (value && value.length > 3 && (/key|token|secret|password|credential/i.test(key) || key === cfg.azure.key_env)) this.secrets.add(value);
    }
    return { cfg, env };
  }

  scrub(text: string): string {
    let clean = text.replace(/([?&](?:tkn|token|key)=)[^&\s"']+/gi, "$1[hidden]");
    for (const secret of this.secrets) clean = clean.split(secret).join("[hidden]");
    return clean.replace(/\x1b\[[0-9;]*m/g, "");
  }

  async sessions(profileId: string, force = false): Promise<AvailableSession[]> {
    const cached = this.sessionCache.get(profileId);
    if (!force && cached && Date.now() - cached.at < 5000) return cached.sessions;
    const { cfg } = this.config(profileId);
    const sessions = await this.discover(cfg.repo);
    this.sessionCache.set(profileId, { at: Date.now(), sessions });
    return sessions;
  }

  addProfile(input: unknown): Profile {
    const value = z.object({
      name: z.string().trim().min(1).max(80), configFile: z.string().optional(),
      repo: z.string().optional(), storiesDir: z.string().default("_bmad-output\\implementation-artifacts"),
      epicsFile: z.string().default("_bmad-output\\planning-artifacts\\epics.md"),
    }).strict().parse(input);
    const id = randomUUID();
    let configFile: string;
    if (value.configFile) {
      if (!path.isAbsolute(value.configFile)) throw new Error("Use an absolute configuration path.");
      configFile = fs.realpathSync.native(value.configFile);
    } else {
      if (!value.repo || !path.isAbsolute(value.repo)) throw new Error("Choose an absolute existing repository path.");
      const { cfg } = this.config(this.profiles[0]!.id);
      const copy = { ...cfg, repo: fs.realpathSync.native(value.repo), stories_dir: value.storiesDir,
        story_creation: { ...cfg.story_creation, epics_file: value.epicsFile }, mode: "watch" };
      configFile = path.join(this.root, `workspace-${id}.yaml`);
      fs.writeFileSync(configFile, YAML.stringify(copy), { flag: "wx", mode: 0o600 });
    }
    const env = { ...this.baseEnvironment };
    try { loadConfig(configFile, { requireAzureKey: false, env }); }
    catch (error) {
      if (!value.configFile) fs.unlinkSync(configFile);
      throw error;
    }
    const profile: Profile = { id, name: value.name, configFile,
      ...(!value.configFile ? { environmentConfig: this.baseConfig } : {}) };
    if (this.profiles.some((item) => item.configFile === profile.configFile)) throw new Error("This configuration is already registered.");
    this.profiles.push(profile);
    this.write(path.join(this.root, "profiles.json"), this.profiles);
    return profile;
  }

  private readRuns(profileId: string, sessions: AvailableSession[]): Run[] {
    const { cfg } = this.config(profileId);
    const root = path.join(this.cwd, "runs");
    if (!fs.existsSync(root)) return [];
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name)).slice(0, 100);
    const runs: Run[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(root, dir.name, "log.jsonl"))) continue;
      const ledger = new Ledger(root, dir.name, { resume: true });
      const events = ledger.read();
      const started = events.find((event) => event.type === "run_started");
      if (!started || !started.repo || canonical(started.repo) !== canonical(cfg.repo)) continue;
      const recent = [...events].reverse();
      const lastTurn = recent.find((event) => event.type === "turn_started");
      const lastStage = recent.filter((event) => event.type === "turn" || event.type === "turn_started")
        .find((event) => event.story === lastTurn?.story);
      const lastSession = recent.filter((event) => event.type === "story_session").find((event) => !lastTurn || event.story === lastTurn.story);
      const story = recent.find((event) => event.type === "story_started");
      const finished = recent.find((event) => event.type === "run_finished");
      const resumed = recent.find((event) => event.type === "run_resumed");
      const failure = recent.filter((event) => event.type === "recovery_failed" || event.type === "run_finished")
        .find((event) => event.type === "recovery_failed" || event.outcome === "error");
      const recovered = recent.find((event) => event.type === "turn_recovered");
      const reconciliation = recent.find((event) => event.type === "turn_started" && event.stage === "reconcile");
      const recoveryPaused = failure?.type === "recovery_failed" &&
        [RECOVERY_DECISION_REQUIRED, RECOVERY_ASSESSMENT_CHANGED].includes(failure.summary) &&
        (!resumed || resumed.seq < failure.seq);
      let recoveryAssessment: RecoveryAssessment | undefined;
      let recoveryAssessmentError: string | undefined;
      let assessmentFingerprint: string | undefined;
      if (recoveryPaused && reconciliation?.type === "turn_started") {
        try {
          const saved = readSavedRecoveryAssessment(ledger, reconciliation.turnId);
          if (!saved) throw new Error("The saved assessment is missing. Reconnect in watch mode to inspect the recorded result.");
          assessmentFingerprint = recoveryAssessmentFingerprint(saved);
          recoveryAssessment = {
            ...saved, summary: this.scrub(saved.summary), uncertainties: saved.uncertainties.map((text) => this.scrub(text)),
          };
        } catch (error) {
          recoveryAssessmentError = this.scrub(`Cannot load the recovery assessment: ${message(error)}`);
        }
      }
      const active = this.tasks.find((task) => task.runId === dir.name && this.children.has(task.id));
      const sync = lastSession ? this.observations.get(this.sessionKey(cfg.repo, lastSession.session)) : undefined;
      const latest = sync?.inspection?.activeTurn ?? sync?.inspection?.recentTurns.at(-1);
      const phase1 = recent.filter((event) => event.type === "phase1").find((event) => event.story === lastTurn?.story);
      const phase2 = recent.filter((event) => event.type === "phase2").find((event) => event.story === lastTurn?.story);
      runs.push({
        id: dir.name, profileId, repo: cfg.repo, target: started.onlyStory ? `Story ${started.onlyStory}` : started.epic,
        story: lastTurn?.story ?? story?.story, title: story?.title, stage: lastStage?.stage,
        session: lastSession?.session, turnId: lastTurn?.turnId,
        updatedAt: events.at(-1)?.at ?? started.at,
        outcome: finished && (!resumed || finished.seq > resumed.seq) ? finished.outcome : undefined,
        error: failure && (!resumed || failure.seq > resumed.seq) ? this.scrub(failure.summary) : undefined,
        recovered: !!recovered && (!failure || recovered.seq > failure.seq),
        harnessRunning: !!active || !!started.pid && processAlive(started.pid) && !finished,
        agentStatus: lastSession ? sessionStatus(sessions.find((session) => session.resource === lastSession.session)?.status ?? 0) : "not bound",
        report: this.scrub(ledger.report()),
        recoveryPaused, recoveryAssessment, recoveryAssessmentError,
        recoveryAssessmentFingerprint: assessmentFingerprint,
        sessionSync: sync,
        sessionAdvanced: !!latest && !!lastTurn && latest.id !== lastTurn.turnId,
        phase1: phase1 ? { outcome: phase1.outcome, reasons: phase1.reasons.map((text) => this.scrub(text)), at: phase1.at } : undefined,
        phase2: phase2 ? { outcome: phase2.outcome, reasons: phase2.reasons.map((text) => this.scrub(text)), at: phase2.at } : undefined,
      });
    }
    return runs;
  }

  async snapshot() {
    const workspaces = await Promise.all(this.profiles.map(async (profile) => {
      try {
        const { cfg } = this.config(profile.id);
        const stories = findConfiguredStories(cfg).map((story) => ({ id: story.id, title: story.title, status: story.status }));
        let sessions: AvailableSession[] = [];
        let discoveryError: string | undefined;
        try { sessions = await this.sessions(profile.id); } catch (error) { discoveryError = this.scrub(message(error)); }
        return { ...profile, repo: cfg.repo, stories, discoveryError, syncError: this.pollingErrors.get(profile.id),
          sessions: sessions.map((session) => ({ id: session.resource, title: session.title, status: sessionStatus(session.status) })),
          runs: this.readRuns(profile.id, sessions) };
      } catch (error) {
        return { ...profile, error: this.scrub(message(error)), stories: [], sessions: [], runs: [] };
      }
    }));
    return {
      sessionPollIntervalMs: 30_000, workspaces,
      tasks: this.tasks.map((task): TaskView => {
        try {
          return { ...task, output: this.output(task.id), decision: this.decision(task) };
        } catch (error) {
          return { ...task, output: this.output(task.id), decisionError: this.scrub(message(error)) };
        }
      }),
    };
  }

  private decision(task: Task): PendingDecision | undefined {
    if (task.state !== "decision") return undefined;
    const events = task.runId
      ? new Ledger(path.join(this.cwd, "runs"), task.runId, { resume: true }).read() : [];
    const decision = pendingDecision(task, this.output(task.id), events);
    if (!decision) return undefined;
    if (!decision.findings.length && ["fix", "carry-on"].every((id) => decision.choices.some((choice) => choice.id === id))) {
      const { cfg } = this.config(task.profileId);
      const file = path.join(cfg.repo, ".harness", "review.json");
      if (fs.existsSync(file)) {
        try {
          decision.findings = readReview({
            folder: cfg.repo, readFile: (relative) => fs.readFileSync(path.join(cfg.repo, relative), "utf8"),
          });
          decision.findingsSource = `Latest workspace review (${fs.statSync(file).mtime.toISOString()}); may postdate this decision`;
        } catch (error) { decision.backgroundError = this.scrub(`Cannot read the latest review background: ${message(error)}`); }
      }
    }
    return {
      ...decision, question: this.scrub(decision.question), reason: this.scrub(decision.reason),
      background: this.scrub(decision.background),
      choices: decision.choices.map((choice) => ({ ...choice, label: this.scrub(choice.label), detail: this.scrub(choice.detail) })),
      findings: decision.findings.map((finding) => ({
        ...finding, file: this.scrub(finding.file), what: this.scrub(finding.what), suggested_fix: this.scrub(finding.suggested_fix),
      })),
    };
  }

  private sessionKey(repo: string, resource: string): string {
    return JSON.stringify([canonical(repo), resource]);
  }

  async pollSessions(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.pollBoundSessions();
    try { await this.polling; }
    finally { this.polling = undefined; }
  }

  private async pollBoundSessions(): Promise<void> {
    const targets = new Map<string, { profileId: string; repo: string; resource: string; sessions?: AvailableSession[]; error?: string }>();
    await Promise.all(this.profiles.map(async (profile) => {
      try {
        const { cfg } = this.config(profile.id);
        let sessions: AvailableSession[] | undefined;
        let discoveryError: string | undefined;
        try { sessions = await this.sessions(profile.id, true); }
        catch (error) { discoveryError = this.scrub(message(error)); }
        const resources = new Set([
          ...this.readRuns(profile.id, sessions ?? []).flatMap((run) => run.session ? [run.session] : []),
          ...this.tasks.filter((task) => task.profileId === profile.id && ["queued", "running", "decision"].includes(task.state)).map((task) => task.session),
        ]);
        for (const resource of resources) {
          targets.set(this.sessionKey(cfg.repo, resource), { profileId: profile.id, repo: cfg.repo, resource, sessions, error: discoveryError });
        }
        this.pollingErrors.delete(profile.id);
      } catch (error) { this.pollingErrors.set(profile.id, this.scrub(message(error))); }
    }));
    await Promise.all([...targets].map(async ([key, target]) => {
      const previous = this.observations.get(key);
      const attemptedAt = new Date().toISOString();
      try {
        if (target.error) throw new Error(target.error);
        const matches = target.sessions?.filter((session) => session.resource === target.resource) ?? [];
        if (matches.length !== 1) throw new Error("The bound VS Code session is unavailable or ambiguous. No replacement was selected.");
        const inspection = await this.inspectAvailable(target.repo, matches[0]!);
        const revision = createHash("sha256").update(JSON.stringify(inspection)).digest("hex");
        const checkedAt = new Date().toISOString();
        this.observations.set(key, {
          attemptedAt, checkedAt, inspection, revision,
          changedAt: revision === previous?.revision ? previous.changedAt : checkedAt,
        });
      } catch (error) {
        this.observations.set(key, { ...previous, attemptedAt, error: this.scrub(message(error)) });
      }
    }));
  }

  private output(id: string): string {
    const current = this.outputs.get(id);
    if (current !== undefined) return current;
    const file = path.join(this.root, "tasks", `${id}.log`);
    if (!fs.existsSync(file)) return "";
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(size, 24_000));
      fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      return this.scrub(buffer.toString("utf8"));
    } finally { fs.closeSync(fd); }
  }

  async start(input: unknown): Promise<Task> {
    const value = z.object({
      profileId: z.string().uuid(), target: z.string().regex(/^(?:epic-\d+|\d+\.\d+)$/),
      session: z.string().min(1),
    }).strict().parse(input);
    const { cfg } = this.config(value.profileId);
    if (cfg.driver !== "attach") throw new Error("The app starts live sessions only. Set driver: attach in this workspace configuration.");
    const stories = findConfiguredStories(cfg);
    if (!stories.some((story) => value.target.startsWith("epic-")
      ? story.id.startsWith(value.target.slice(5) + ".") : story.id === value.target)) throw new Error("The selected story or epic does not exist in this workspace.");
    const sessions = await this.sessions(value.profileId, true);
    const selected = sessions.filter((session) => session.resource === value.session);
    if (selected.length !== 1) throw new Error("Select an unambiguous session matching this workspace.");
    if (selected[0]!.status & (8 | 16 | 64 | 2)) throw new Error("This session is busy, awaiting input, archived, or in error. Reconnect its existing run instead of starting another.");
    if (this.tasks.some((task) => task.profileId === value.profileId && task.target === value.target &&
        ["queued", "running", "decision"].includes(task.state))) throw new Error("This story or epic is already running or queued.");
    const task = this.newTask(value.profileId, "start", value.target, value.session);
    await this.drain();
    return task;
  }

  async recover(input: unknown): Promise<Task> {
    const value = z.object({
      profileId: z.string().uuid(), runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      action: z.enum(["watch", "continue"]),
      acceptUncertainty: z.boolean().default(false),
      assessmentFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }).strict().parse(input);
    const sessions = await this.sessions(value.profileId, true);
    const run = this.readRuns(value.profileId, sessions).find((item) => item.id === value.runId);
    if (!run?.story || !run.session || !run.turnId) throw new Error("This run has no recorded story, session, and turn to recover.");
    if (value.acceptUncertainty && (value.action !== "continue" || !run.recoveryPaused || !run.recoveryAssessment)) {
      throw new Error("Uncertainty can be accepted only when continuing a paused run with a saved recovery assessment.");
    }
    if (value.acceptUncertainty && (!value.assessmentFingerprint ||
        value.assessmentFingerprint !== run.recoveryAssessmentFingerprint)) {
      throw new Error("The recovery assessment changed or was not confirmed. Review its current uncertainties before continuing.");
    }
    if (this.tasks.some((task) => task.runId === run.id && ["queued", "running", "decision"].includes(task.state))) {
      throw new Error("This run already has an active monitor or recovery operation.");
    }
    if (run.harnessRunning) throw new Error("The original harness process is still running.");
    if (run.outcome === "finished" || run.outcome === "finished-with-gaps") throw new Error("This run has already finished; no recovery was started.");
    const matches = sessions.filter((session) => session.resource === run.session);
    if (matches.length !== 1) throw new Error("The original session is unavailable or ambiguous. Recovery never substitutes a different session.");
    const { cfg } = this.config(value.profileId);
    const story = findConfiguredStories(cfg).find((item) => item.id === run.story);
    if (!story) throw new Error("The original story is no longer available.");
    const { StoryBindings } = await import("../vscode/bindings.js");
    const binding = new StoryBindings(cfg.repo, path.join(path.dirname(this.profile(value.profileId).configFile), ".harness-state", "sessions"), async () => sessions);
    const saved = await binding.resolveExisting(story);
    if (saved.resource !== run.session) throw new Error("The saved binding no longer matches the original run.");
    const task = this.newTask(value.profileId, value.action, run.target, run.session);
    task.runId = run.id;
    task.story = run.story;
    task.acceptUncertainty = value.acceptUncertainty;
    task.assessmentFingerprint = value.acceptUncertainty ? value.assessmentFingerprint : undefined;
    this.saveTask(task);
    await this.drain();
    return task;
  }

  private newTask(profileId: string, kind: Task["kind"], target: string, session: string): Task {
    const at = new Date().toISOString();
    const task: Task = { id: randomUUID(), profileId, kind, target, session, state: "queued", createdAt: at, updatedAt: at };
    this.tasks.push(task);
    this.saveTask(task);
    return task;
  }

  async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const task of this.tasks.filter((item) => item.state === "queued")) {
        try {
          const { cfg, env } = this.config(task.profileId);
          const occupied = this.tasks.some((item) => this.children.has(item.id) && canonical(this.config(item.profileId).cfg.repo) === canonical(cfg.repo));
          if (occupied) continue;
          if (task.kind === "start") {
            const sessions = await this.sessions(task.profileId, true);
            if (sessions.some((session) => session.status & (8 | 16))) continue;
          }
          const main = fileURLToPath(new URL("../main.js", import.meta.url));
          const entry = fs.existsSync(main) ? main : main.replace(/\.js$/, ".ts");
          const args = entry.endsWith(".ts") ? ["--import", import.meta.resolve("tsx"), entry] : [entry];
          args.push("--config", this.profile(task.profileId).configFile);
          if (task.kind === "start") {
            if (task.target.startsWith("epic-")) args.push(task.target);
            else args.push("--story", task.target);
            args.push("--session", task.session);
          } else {
            args.push("--recover-turn", task.runId!, "--story", task.story!);
            if (task.kind === "continue") args.push("--continue");
            if (task.kind === "continue" && task.acceptUncertainty) {
              const current = this.readRuns(task.profileId, []).find((run) => run.id === task.runId);
              if (!current?.recoveryPaused || current.recoveryAssessmentFingerprint !== task.assessmentFingerprint) {
                throw new Error("The recovery assessment changed while queued. Review the current uncertainties before continuing.");
              }
              args.push("--accept-uncertainty", "--assessment-fingerprint", task.assessmentFingerprint!);
            }
          }
          const child = this.launch(args, this.cwd, { ...env, HARNESS_APP_INPUT: "1" });
          this.children.set(task.id, child);
          task.pid = child.pid;
          task.state = "running";
          this.saveTask(task);
          const observe = (operation: () => void) => {
            try { operation(); }
            catch (error) {
              task.error = this.scrub(`Could not persist harness output: ${message(error)}`);
              task.state = "error";
              console.error(task.error);
            }
          };
          const append = (raw: string) => {
            const text = this.scrub(raw);
            const output = (this.outputs.get(task.id) ?? "") + text;
            this.outputs.set(task.id, output.slice(-24_000));
            fs.appendFileSync(path.join(this.root, "tasks", `${task.id}.log`), text, { mode: 0o600 });
            const runId = output.match(/(?:^|[\s\\\/])(epic-\d+-\d{4}-\d{2}-\d{2}T[\dTZ.-]+)/m)?.[1];
            if (runId) task.runId = runId.replace(/[\\\/]+$/, "");
            if (/Pick \[[^\]]+\] or "stop":\s*$/.test(output)) task.state = "decision";
            this.saveTask(task);
          };
          const streams = [child.stdout, child.stderr].map((stream) => {
            const decoder = new StringDecoder("utf8");
            let pending = "";
            stream.on("data", (chunk: Buffer) => observe(() => {
              pending += decoder.write(chunk);
              const end = pending.lastIndexOf("\n");
              if (end >= 0) { append(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
              if (/Pick \[[^\]]+\] or "stop":\s*$/.test(pending)) { append(pending); pending = ""; }
            }));
            return () => { pending += decoder.end(); if (pending) append(pending); };
          });
          child.on("error", (error) => observe(() => {
            task.error = this.scrub(message(error));
            task.state = "error";
            this.saveTask(task);
          }));
          child.stdin.on("error", (error) => observe(() => {
            task.error = this.scrub(`Could not send the harness decision: ${message(error)}`);
            task.state = "error";
            this.saveTask(task);
          }));
          child.on("close", (code, signal) => observe(() => {
            streams.forEach((flush) => flush());
            this.children.delete(task.id);
            const failed = code !== 0 || !!task.error;
            task.state = failed ? "error" : "completed";
            if (failed && !task.error) task.error = this.scrub(`Harness exited ${code ?? signal ?? "unexpectedly"}.\n${this.output(task.id).slice(-6000)}`);
            this.saveTask(task);
          }));
        } catch (error) {
          task.state = "error";
          task.error = this.scrub(message(error));
          this.saveTask(task);
        }
      }
    } finally { this.busy = false; }
  }

  async respond(input: unknown): Promise<void> {
    const value = z.object({
      taskId: z.string().uuid(), answer: z.string().min(1).max(800).regex(/^[^\r\n]+$/),
      decisionId: z.string().min(1).optional(),
    }).strict().parse(input);
    const task = this.tasks.find((item) => item.id === value.taskId);
    const child = this.children.get(value.taskId);
    if (!task || task.state !== "decision" || !child) throw new Error("This run is not waiting for a harness decision.");
    const decision = this.decision(task);
    if (!decision || value.decisionId && decision.id !== value.decisionId) throw new Error("The pending decision changed. Refresh its context before choosing.");
    if (value.answer !== "stop" && !decision.choices.some((choice) => choice.id === value.answer)) throw new Error("Choose one of the pending decision's listed options.");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(value.answer + "\n", (error) => error ? reject(error) : resolve());
    });
    task.state = "running";
    this.saveTask(task);
  }

  async inspect(profileId: string, runId: string) {
    const sessions = await this.sessions(profileId, true);
    const run = this.readRuns(profileId, sessions).find((item) => item.id === runId);
    if (!run?.session) throw new Error("This run has no recorded session.");
    const matches = sessions.filter((session) => session.resource === run.session);
    if (matches.length !== 1) throw new Error("The original session is unavailable or ambiguous.");
    const { cfg } = this.config(profileId);
    const state = await this.inspectAvailable(cfg.repo, matches[0]!);
    const key = this.sessionKey(cfg.repo, run.session);
    const previous = this.observations.get(key);
    const revision = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    const at = new Date().toISOString();
    this.observations.set(key, { attemptedAt: at, checkedAt: at, revision, inspection: state, changedAt: previous?.revision === revision ? previous.changedAt : at });
    return state;
  }

  private async inspectAvailable(repo: string, session: AvailableSession): Promise<SessionInspection> {
    const key = this.sessionKey(repo, session.resource);
    const existing = this.inspecting.get(key);
    if (existing) return existing;
    const pending = this.readSession(repo, session);
    this.inspecting.set(key, pending);
    try { return await pending; }
    finally { this.inspecting.delete(key); }
  }

  private async readSession(repo: string, session: AvailableSession): Promise<SessionInspection> {
    const driver = this.inspectSession ? undefined : new AttachedSession(repo, { session, allowActive: true });
    try {
      if (driver) await driver.attach();
      const state = this.inspectSession ? await this.inspectSession(repo, session) : await driver!.inspect();
      if (state.session !== session.resource) throw new Error("The inspection returned a different session; its output was not accepted.");
      return {
        ...state, title: this.scrub(state.title),
        activeTurn: state.activeTurn ? { ...state.activeTurn, text: this.scrub(state.activeTurn.text) } : undefined,
        recentTurns: state.recentTurns.map((turn) => ({ ...turn, text: this.scrub(turn.text) })),
        terminals: state.terminals.map((terminal) => ({ title: this.scrub(terminal.title), text: this.scrub(terminal.text) })),
      };
    } finally { await driver?.detach(); }
  }

  async openWorkspace(profileId: string): Promise<void> {
    const { cfg } = this.config(profileId);
    await execFileAsync(process.platform === "win32" ? "code-tunnel.exe" : "code", ["--new-window", cfg.repo], { windowsHide: true, timeout: 20_000 });
  }

  async createSession(profileId: string, instanceId: string): Promise<string> {
    const hosts = (await discoverHosts()).filter((host) => host.instanceId === instanceId && host.type === "editor");
    if (hosts.length !== 1) throw new Error("Select one running VS Code editor host.");
    const { cfg } = this.config(profileId);
    const client = new AhpClient(await connectEndpoint(await discoverEndpoint(hosts[0]!)), { requestTimeoutMs: 30_000 });
    client.connect();
    try {
      const initialized = await client.initialize({ clientId: `harness-app-${randomUUID()}`, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(initialized.protocolVersion)) throw new Error("Unsupported agent host protocol.");
      const id = `ahp-session:/${randomUUID()}`;
      await client.request("createSession", { channel: id, provider: "copilotcli", workingDirectories: [pathToFileURL(cfg.repo).href] });
      this.sessionCache.delete(profileId);
      return id;
    } finally { await client.shutdown(); }
  }
}

function canonical(repo: string): string {
  const real = fs.realpathSync.native(repo);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
