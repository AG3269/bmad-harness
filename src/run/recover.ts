import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { Ledger } from "../audit/ledger.js";
import type { Story } from "../bmad/stories.js";
import type { Config } from "../config.js";
import { collect } from "../validate/diff.js";
import type { WorktreeSnapshot } from "../validate/diff.js";
import type { Reply } from "../vscode/types.js";
import type { VSCode } from "../vscode/types.js";
import { loadBaseline } from "./baseline.js";

type RecoveryDriver = {
  recoverTurn(id: string, selection: { agent: string; model: string; noTools?: boolean }): Promise<Reply>;
};

export const RECOVERY_DECISION_REQUIRED =
  "The agent reported uncertainty or a conflicting next step; inspect the run before continuing.";
export const RECOVERY_ASSESSMENT_CHANGED =
  "The recovery assessment changed since your confirmation. Review the current uncertainties before continuing.";

export async function withRecoveryAudit<T>(ledger: Ledger, story: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    ledger.write({ type: "recovery_failed", story, summary });
    console.error(`Recovery stopped. Report: ${ledger.saveReport()}`);
    throw error;
  }
}

export async function recoverRecordedTurn(options: {
  cfg: Config; ledger: Ledger; story: Story; session: string; driver: RecoveryDriver;
}): Promise<{
  turnId: string; stage: string; agent: string; model: string; reply: Reply;
  baseline: WorktreeSnapshot; priorFixes: number; alreadyReworked: boolean; alreadyRetested: boolean;
  artifact: string; filesChanged: number; recommendation: string; unsafeReason?: string;
  assessment?: z.infer<typeof AgentReport>;
}> {
  const { cfg, ledger, story, session, driver } = options;
  const events = ledger.read();
  const started = events.find((event) => event.type === "run_started");
  if (!started || started.type !== "run_started" || !started.repo || !sameRepo(started.repo, cfg.repo)) {
    throw new Error("The run does not identify the configured repository; recovery is unsafe.");
  }
  const recordedSession = [...events].reverse().find((event) => event.type === "story_session" && event.story === story.id);
  if (!recordedSession || recordedSession.type !== "story_session" || recordedSession.session !== session) {
    throw new Error("The selected session differs from the original run; recovery is unsafe.");
  }
  const baselineEvent = [...events].reverse().find((event) => event.type === "story_baseline" && event.story === story.id);
  const expectedBaseline = `baseline-${createHash("sha256").update(story.file).digest("hex")}.json.gz`;
  if (!baselineEvent || baselineEvent.type !== "story_baseline" || baselineEvent.file !== expectedBaseline ||
      !z.array(z.string()).safeParse(baselineEvent.ignore).success) {
    throw new Error("The original story baseline is unavailable or belongs to a different story.");
  }
  const baseline = loadBaseline(path.join(ledger.dir, baselineEvent.file));
  if (JSON.stringify(baselineEvent.ignore) !== JSON.stringify(cfg.phase1.ignore)) {
    throw new Error("Phase 1 ignore settings changed since the story began; automatic continuation is unsafe.");
  }
  const latestTurn = [...events].reverse().find((event) => event.type === "turn_started" && event.story === story.id);
  if (!latestTurn || latestTurn.type !== "turn_started" ||
      !z.string().uuid().safeParse(latestTurn.turnId).success) {
    throw new Error("No valid recorded turn exists for this story.");
  }
  const latestReply = await driver.recoverTurn(latestTurn.turnId, {
    agent: latestTurn.agent, model: latestTurn.model,
    ...(latestTurn.stage === "reconcile" ? { noTools: true } : {}),
  });
  let recordedTurn = latestTurn;
  let result = latestReply;
  let assessment: z.infer<typeof AgentReport> | undefined;
  if (latestTurn.stage === "reconcile") {
    const link = [...events].reverse().find((event) =>
      event.type === "reconcile_started" && event.story === story.id && event.turnId === latestTurn.turnId);
    if (!link || link.type !== "reconcile_started") throw new Error("The reconciliation turn has no recorded original turn.");
    const original = events.find((event) =>
      event.type === "turn_started" && event.story === story.id && event.turnId === link.originalTurnId);
    if (!original || original.type !== "turn_started") throw new Error("The original story turn is unavailable.");
    const saved = [...events].reverse().find((event) =>
      event.type === "turn_recovered" && event.story === story.id && event.turnId === original.turnId);
    const expected = `recovered-${createHash("sha256").update(original.turnId).digest("hex")}.json`;
    if (!saved || saved.type !== "turn_recovered" || saved.artifact !== expected) {
      throw new Error("The original recovered turn artifact is unavailable.");
    }
    let artifactValue: unknown;
    try {
      artifactValue = JSON.parse(fs.readFileSync(path.join(ledger.dir, expected), "utf8"));
    } catch {
      throw new Error("The original recovered turn artifact is unreadable.");
    }
    const artifact = z.object({ turnId: z.string(), stage: z.string(), response: z.string() }).strict().safeParse(artifactValue);
    if (!artifact.success || artifact.data.turnId !== original.turnId || artifact.data.stage !== original.stage) {
      throw new Error("The original recovered turn artifact does not match the recorded turn.");
    }
    recordedTurn = original;
    result = { text: artifact.data.response, changed: [], idle: true };
    assessment = parseAgentReport(latestReply.text, ledger, latestTurn.turnId);
  }
  const changes = collect(cfg.repo, baseline, { ignore: baselineEvent.ignore, maxChars: cfg.phase1.max_diff_chars });
  const artifact = `recovered-${createHash("sha256").update(recordedTurn.turnId).digest("hex")}.json`;
  ledger.keep(artifact, { turnId: recordedTurn.turnId, stage: recordedTurn.stage, response: result.text });
  ledger.write({ type: "turn_recovered", story: story.id, stage: recordedTurn.stage, turnId: recordedTurn.turnId, artifact });
  const completedFixes = events.filter((event) => event.type === "turn" && event.story === story.id && event.stage === "fix");
  const lastFixRecorded = completedFixes.some((event) => event.seq > recordedTurn.seq);
  const finished = [...events].reverse().find((event) => event.type === "story_finished" && event.story === story.id);
  const alreadyFinished = finished?.type === "story_finished" && finished.seq > recordedTurn.seq &&
    (finished.outcome === "done" || finished.outcome === "done-with-debt");
  const carriedDebt = events.some((event) => event.type === "answered" && event.story === story.id && event.pick === "carry-on");
  return {
    turnId: recordedTurn.turnId,
    stage: recordedTurn.stage,
    agent: recordedTurn.agent,
    model: recordedTurn.model,
    reply: result,
    baseline,
    priorFixes: completedFixes.length + (recordedTurn.stage === "fix" && !lastFixRecorded ? 1 : 0),
    alreadyReworked: events.some((event) => event.type === "turn_started" && event.story === story.id && event.stage === "rework"),
    alreadyRetested: events.some((event) => event.type === "turn_started" && event.story === story.id && event.stage === "retest"),
    artifact: path.join(ledger.dir, artifact),
    filesChanged: changes.files.length,
    recommendation: nextStep(recordedTurn.stage),
    unsafeReason: alreadyFinished ? "The story was already recorded as validated."
      : carriedDebt ? "A previous decision carried review debt; manual reconciliation is required."
      : undefined,
    assessment,
  };
}

function nextStep(stage: string): string {
  if (stage === "create") return "Validate the prepared story and its unchanged acceptance criteria before implementation.";
  if (stage === "develop" || stage === "fix") return "Review the work, then run Phase 1 against the saved baseline.";
  if (stage === "review") return "Validate the fresh review output before deciding whether to fix findings or run Phase 1.";
  if (stage === "rework") return "Review the rework and rerun Phase 1 against the saved baseline.";
  if (stage === "test" || stage === "retest") return "Inspect the test results before deciding whether another test run is safe.";
  return "Inspect the story and recovered session before choosing the next step.";
}

const AgentReport = z.object({
  summary: z.string().min(1).max(4000),
  next_step: z.enum(["develop", "review", "phase1", "test", "human"]),
  uncertainties: z.array(z.string().max(1000)).max(20),
}).strict();

export type RecoveryAssessment = z.infer<typeof AgentReport>;

export function recoveryAssessmentFingerprint(assessment: RecoveryAssessment): string {
  return createHash("sha256").update(JSON.stringify(assessment)).digest("hex");
}

export function assertRecoveryAssessmentFingerprint(assessment: RecoveryAssessment, expected: string): void {
  if (recoveryAssessmentFingerprint(assessment) !== expected) {
    throw new Error(RECOVERY_ASSESSMENT_CHANGED);
  }
}

export function readSavedRecoveryAssessment(ledger: Ledger, turnId: string): RecoveryAssessment | undefined {
  const file = path.join(ledger.dir, `reconcile-${createHash("sha256").update(turnId).digest("hex")}.json`);
  if (!fs.existsSync(file)) return undefined;
  return AgentReport.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export async function askRecoveryAgent(options: {
  cfg: Config; ledger: Ledger; story: Story; vscode: VSCode; previousStage: string; originalTurnId: string;
}): Promise<z.infer<typeof AgentReport>> {
  const { cfg, ledger, story, vscode, previousStage, originalTurnId } = options;
  const turnId = randomUUID();
  const agent = cfg.bmad.agents.develop;
  const model = cfg.bmad.models.develop;
  ledger.write({ type: "reconcile_started", story: story.id, turnId, originalTurnId });
  ledger.write({ type: "turn_started", story: story.id, stage: "reconcile", turnId, agent, model });
  const reply = await vscode.send({
    id: turnId,
    noTools: true,
    agent,
    model,
    say:
      `The harness is recovering story ${story.id} after an interruption. ` +
      `The last recorded stage was ${previousStage}.\n\n` +
      "Based only on this conversation, summarize what is known, what remains uncertain, " +
      "and which step should happen next. Do not edit files, run commands, call tools, " +
      "or claim a validation passed without evidence.\n\n" +
      "Return exactly one JSON object. Do not repeat it in completion text or add markdown or commentary.\n\n" +
      'Reply only with JSON: {"summary":"...","next_step":"develop|review|phase1|test|human","uncertainties":["..."]}.',
  });
  ledger.write({ type: "turn_result", story: story.id, stage: "reconcile", turnId });
  return parseAgentReport(reply.text, ledger, turnId);
}

function parseAgentReport(text: string, ledger: Ledger, turnId: string): z.infer<typeof AgentReport> {
  const name = `reconcile-${createHash("sha256").update(turnId).digest("hex")}`;
  ledger.keep(`${name}.txt`, text);
  let report: z.infer<typeof AgentReport>;
  try {
    report = parseRecoveryAssessment(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason} Saved response: ${path.join(ledger.dir, `${name}.txt`)}`);
  }
  ledger.keep(`${name}.json`, report);
  return report;
}

export function parseRecoveryAssessment(text: string): z.infer<typeof AgentReport> {
  const values: unknown[] = [];
  let start = -1;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  const invalidJson = () => new Error("The agent's recovery assessment was not valid JSON.");
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (start < 0) {
      if (char === "{" || char === "[") {
        start = index;
        stack.push(char);
      } else if (char === "}" || char === "]") {
        throw invalidJson();
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const opening = stack.pop();
      if (opening !== (char === "}" ? "{" : "[")) throw invalidJson();
      if (!stack.length) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          throw invalidJson();
        }
        start = -1;
      }
    }
  }
  if (start >= 0 || !values.length) throw invalidJson();
  const reports = values.map((value) => {
    const parsed = AgentReport.safeParse(value);
    if (!parsed.success) throw new Error("The agent's recovery assessment has an invalid format.");
    return parsed.data;
  });
  if (new Set(reports.map((report) => report.next_step)).size !== 1) {
    throw new Error("The agent returned recovery assessments with conflicting next steps; manual reconciliation is required.");
  }
  const combined = AgentReport.safeParse({
    summary: [...new Set(reports.map((report) => report.summary))].join("\n\n"),
    next_step: reports[0]!.next_step,
    uncertainties: [...new Set(reports.flatMap((report) => report.uncertainties))],
  });
  if (!combined.success) {
    throw new Error("The combined recovery assessments exceed the allowed format limits; manual reconciliation is required.");
  }
  return combined.data;
}

function sameRepo(left: string, right: string): boolean {
  const a = fs.realpathSync.native(left);
  const b = fs.realpathSync.native(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
