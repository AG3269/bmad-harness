import * as fs from "node:fs";
import * as path from "node:path";
import type { Finding, Question } from "../decide/engine.js";

/**
 * The record of what happened.
 *
 * Written as it goes, one line per event, so a crash loses at most the last
 * line. Two readers: the harness, to resume and to summarize; and you, in the
 * morning.
 */

export type Event =
  | { type: "run_started"; epic: string; mode: string; session: string; repo?: string; pid?: number; configFingerprint?: string; onlyStory?: string; preferredSession?: string }
  | { type: "story_started"; story: string; title: string; criteria: number }
  | { type: "story_session"; story: string; session: string }
  | { type: "story_baseline"; story: string; file: string; ignore: string[] }
  | { type: "story_planned"; story: string; sourceHash: string }
  | { type: "turn_started"; story: string; stage: string; turnId: string; agent: string; model: string }
  | { type: "turn_result"; story: string; stage: string; turnId: string }
  | { type: "turn_recovered"; story: string; stage: string; turnId: string; artifact: string }
  | { type: "reconcile_started"; story: string; turnId: string; originalTurnId: string }
  | { type: "run_resumed"; story: string }
  | { type: "recovery_failed"; story: string; summary: string }
  | { type: "turn"; story: string; stage: string; agent: string; model: string; seconds: number }
  | { type: "review_findings"; story: string; findings: Finding[] }
  | { type: "decision_requested"; story: string; requestId: string; question: Question; why: string; summary: string }
  | { type: "agent_asked"; story: string; question: string; options: string[]; viaProse: boolean }
  | { type: "answered"; story: string; question: string; pick: string; by: "rules" | "model" | "human"; sureness: number | null; because: string }
  | { type: "shadow"; story: string; question: string; wouldPick: string; sureness: number; actual: string | null }
  | { type: "phase1"; story: string; outcome: string; reasons: string[]; unmet: string[]; integrity?: unknown }
  | { type: "phase2"; story: string; outcome: string; reasons: string[] }
  | { type: "escalated"; story: string; why: string; summary: string }
  | { type: "story_finished"; story: string; outcome: string; why: string }
  | { type: "run_finished"; outcome: string; summary: string }
  | { type: "note"; story?: string; text: string };

export class Ledger {
  readonly dir: string;
  private file: string;
  private seq = 0;
  private secrets: string[] = [];

  constructor(root: string, runId: string, options: { resume?: boolean } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === "." || runId === "..") {
      throw new Error("Invalid run ID.");
    }
    this.dir = path.join(root, runId);
    this.file = path.join(this.dir, "log.jsonl");
    if (options.resume) {
      if (!fs.existsSync(this.file)) throw new Error(`No existing run log for ${runId}.`);
      const events = this.read();
      for (let i = 0; i < events.length; i++) {
        if (events[i]?.seq !== i) throw new Error(`The run log for ${runId} has invalid sequence numbers.`);
      }
      this.seq = events.length;
    } else {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.dir, { mode: 0o700 });
    }
  }

  /** Values blanked out of everything written. */
  hide(values: (string | undefined)[]) {
    this.secrets.push(...values.filter((v): v is string => !!v && v.length > 3));
  }

  write(e: Event) {
    const line = JSON.stringify({ seq: this.seq, at: new Date().toISOString(), ...e });
    const fd = fs.openSync(this.file, "a", 0o600);
    try {
      fs.writeFileSync(fd, this.scrub(line) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.seq++;
  }

  /** Keep a full artifact — a reconstruction, a comparison — next to the log. */
  keep(name: string, contents: unknown) {
    const fd = fs.openSync(path.join(this.dir, name), "w", 0o600);
    try {
      fs.writeFileSync(fd, this.scrub(typeof contents === "string" ? contents : JSON.stringify(contents, null, 2)));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  read(): (Event & { seq: number; at: string })[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  /** Recent events for one story, for handing to the summarizer. */
  recentFor(story: string, limit = 40): string[] {
    return this.read()
      .filter((e) => (e as any).story === story)
      .slice(-limit)
      .map((e) => `${e.at} ${e.type}: ${describe(e)}`);
  }

  private scrub(s: string): string {
    let out = s;
    for (const secret of this.secrets) out = out.split(secret).join("[hidden]");
    return out;
  }

  /**
   * The human-readable version. Leads with the outcome and the calls made
   * without you — that's what's worth reading.
   */
  report(): string {
    const events = this.read();
    const out: string[] = [];

    const started = events.find((e) => e.type === "run_started") as any;
    const lastFinished = [...events].reverse().find((e) => e.type === "run_finished");
    const lastResumed = [...events].reverse().find((e) => e.type === "run_resumed");
    const finished = lastFinished && (!lastResumed || lastFinished.seq > lastResumed.seq) ? lastFinished : undefined;

    out.push(`# ${started?.epic ?? "run"}`, "");
    out.push(`**Result:** ${finished?.outcome ?? "still running"}`);
    if (started?.session) out.push(`**Session:** ${started.session}`);
    if (finished?.summary) out.push("", finished.summary);
    out.push("");

    const recoveryFailures = events.filter((event) => event.type === "recovery_failed");
    if (recoveryFailures.length) {
      out.push("## Recovery errors", "");
      for (const event of recoveryFailures) {
        out.push(`- ${event.at} — Story ${event.story}: ${event.summary}`);
      }
      out.push("");
    }

    const stories = events.filter((e) => e.type === "story_finished") as any[];
    if (stories.length) {
      out.push("## Stories", "");
      for (const s of stories) out.push(`- **${s.story}** — ${s.outcome}: ${s.why}`);
      out.push("");
    }

    const p1 = events.filter((e) => e.type === "phase1") as any[];
    if (p1.length) {
      out.push("## Phase 1 — does the code match the story?", "");
      for (const p of p1) {
        out.push(`**${p.story}** — ${p.outcome}`);
        for (const r of p.reasons) out.push(`  - ${r}`);
        out.push("");
      }
    }

    // Always print this, clean or not. A guardrail you only hear from when it
    // fires is indistinguishable from one that stopped running.
    const integrity = p1.filter((p) => p.integrity);
    if (integrity.length) {
      out.push("## Phase 1 guardrails", "");
      for (const p of integrity) {
        const g = p.integrity;
        const bits: string[] = [];
        bits.push(g.excludedFiles.length
          ? `kept ${g.excludedFiles.length} story/doc file(s) away from the reader`
          : "no story files in the diff");
        if (g.redactedText || g.redactedLabels) {
          bits.push(`redacted ${g.redactedText} quote(s) and ${g.redactedLabels} AC label(s) from the code`);
        }
        bits.push(`story wording reused in the reconstruction: ${Math.round((g.overlap ?? 0) * 100)}%${g.overlapFlagged ? " ⚠" : ""}`);
        if (g.secondPass) bits.push("re-read after the gaps were named — less independent");
        out.push(`**${p.story}** — ${bits.join("; ")}.`);
        if (g.decoy) {
          const result = g.decoy.passed === null ? "**UNVERIFIED**" : g.decoy.passed ? "passed" : "**FAILED**";
          out.push(`  Decoy (${g.decoy.kind}, "${g.decoy.used.title}"): ${result} — ${g.decoy.note}`);
        } else {
          out.push(`  Decoy: not run for this story.`);
        }
        if (g.excludedFiles.length) out.push(`  Excluded: ${g.excludedFiles.join(", ")}`);
        out.push("");
      }
    }

    const p2 = events.filter((e) => e.type === "phase2") as any[];
    if (p2.length) {
      out.push("## Phase 2 — did it work?", "");
      for (const p of p2) {
        out.push(`**${p.story}** — ${p.outcome}`);
        for (const r of p.reasons) out.push(`  - ${r}`);
        out.push("");
      }
    }

    const decisions = (events.filter((e) => e.type === "answered") as any[])
      .filter((d) => d.by !== "human");
    if (decisions.length) {
      out.push("## Decided without you", "");
      for (const d of decisions) {
        const sure = d.sureness != null ? ` · ${Math.round(d.sureness * 100)}% sure` : "";
        out.push(`- **${d.story}** — ${d.question}`);
        out.push(`  Chose *${d.pick}* (${d.by}${sure}). ${d.because}`);
      }
      out.push("");
    }

    const shadow = events.filter((e) => e.type === "shadow") as any[];
    if (shadow.length) {
      const scored = shadow.filter((s) => s.actual);
      const agreed = scored.filter((s) => s.wouldPick === s.actual).length;
      out.push("## Shadow mode", "");
      out.push(`The model watched but didn't decide. It matched you ${agreed} of ${scored.length} times.`);
      if (scored.length >= 5) {
        out.push("", "Agreement by how sure it was:");
        for (const [label, lo, hi] of [["low  (<70%)", 0, 0.7], ["mid  (70–85%)", 0.7, 0.85], ["high (85%+)", 0.85, 1.01]] as const) {
          const bucket = scored.filter((s) => s.sureness >= lo && s.sureness < hi);
          if (!bucket.length) continue;
          const hit = bucket.filter((s) => s.wouldPick === s.actual).length;
          out.push(`  ${label}  ${hit}/${bucket.length}`);
        }
        out.push("", "Set decide.confidence where agreement crosses what you'll accept.");
      }
      out.push("");
      for (const s of shadow) {
        const mark = !s.actual ? "?" : s.wouldPick === s.actual ? "✓" : "✗";
        out.push(`- ${mark} ${s.question}`);
        out.push(`    it: *${s.wouldPick}* (${Math.round(s.sureness * 100)}%) · you: *${s.actual ?? "—"}*`);
      }
      out.push("");
    }

    const escalations = events.filter((e) => e.type === "escalated") as any[];
    if (escalations.length) {
      out.push("## Escalated", "");
      for (const e of escalations) {
        out.push(`### ${e.story} — ${e.why}`, "", e.summary, "");
      }
    }

    const notes = events.filter((e) => e.type === "note") as any[];
    if (notes.length) {
      out.push("## Notes", "");
      for (const n of notes) out.push(`- ${n.story ? `**${n.story}** — ` : ""}${n.text}`);
      out.push("");
    }

    return out.join("\n");
  }

  saveReport(): string {
    const p = path.join(this.dir, "report.md");
    fs.writeFileSync(p, this.report());
    return p;
  }
}

function describe(e: any): string {
  switch (e.type) {
    case "turn": return `${e.stage} via ${e.agent} (${e.model}), ${e.seconds}s`;
    case "agent_asked": return `asked: ${e.question}`;
    case "answered": return `chose ${e.pick} (${e.by}) — ${e.because}`;
    case "phase1": return `phase 1 ${e.outcome}: ${e.reasons.join(" | ")}`;
    case "phase2": return `phase 2 ${e.outcome}: ${e.reasons.join(" | ")}`;
    case "note": return e.text;
    default: return JSON.stringify(e).slice(0, 200);
  }
}
