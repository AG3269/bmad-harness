import { createHash } from "node:crypto";
import type { Ledger } from "../audit/ledger.js";
import { Question, type Finding } from "../decide/engine.js";

export type PendingDecision = {
  id: string;
  question: string;
  reason: string;
  background: string;
  createdAt: string;
  choices: { id: string; label: string; detail: string }[];
  findings: Finding[];
  findingsSource?: string;
  backgroundError?: string;
};

export function pendingDecision(
  task: { id: string; state: string; updatedAt: string },
  output: string,
  events: ReturnType<Ledger["read"]>,
): PendingDecision | undefined {
  if (task.state !== "decision") return undefined;
  const recent = [...events].reverse();
  const requested = recent.find((event) => event.type === "decision_requested");
  if (requested) {
    if (events.some((event) => event.seq > requested.seq && event.type === "answered" && event.story === requested.story)) return undefined;
    const question = Question.parse(requested.question);
    const review = recent.find((event) => event.type === "review_findings" && event.seq < requested.seq && event.story === requested.story);
    return {
      id: requested.requestId, question: question.asks, reason: requested.why,
      background: question.context || requested.summary, createdAt: requested.at,
      choices: question.options.map(({ id, label, detail }) => ({ id, label, detail })),
      findings: review?.type === "review_findings" ? review.findings : [],
      findingsSource: review ? "Recorded harness review" : undefined,
    };
  }

  const prompt = output.match(/Pick \[([^\]\r\n]+)\] or "stop":\s*$/);
  if (!prompt) throw new Error("The harness is waiting for a decision, but its choices are unavailable. Inspect its output before responding.");
  const ids = prompt[1]!.split(" / ").map((id) => id.trim());
  const start = output.lastIndexOf("Options:");
  const lines = output.slice(start < 0 ? 0 : start + "Options:".length, prompt.index).split(/\r?\n/);
  const escalation = recent.find((event) => event.type === "escalated");
  return {
    id: createHash("sha256").update(task.id).update(output.slice(start < 0 ? prompt.index : start)).digest("hex"),
    question: ids.includes("fix") && ids.includes("carry-on") ? "How should the review findings be handled?"
      : escalation?.why ? `Decision required: ${escalation.why}` : "Choose how the harness should proceed.",
    reason: escalation?.why ?? "The harness is waiting for your decision.",
    background: escalation?.summary ?? output.slice(Math.max(0, output.lastIndexOf("Need you on this one")), start < 0 ? prompt.index : start).trim(),
    createdAt: task.updatedAt,
    choices: ids.map((id) => {
      const index = lines.findIndex((line) => line.startsWith(`  ${id} `));
      const next = index < 0 ? 0 : lines.findIndex((line, cursor) =>
        cursor > index && ids.some((choice) => line.startsWith(`  ${choice} `)));
      const details = index < 0 ? [] : lines.slice(index + 1, next < 0 ? undefined : next)
        .filter((line) => line.startsWith("      "));
      return {
        id, label: index < 0 ? id : lines[index]!.trim().slice(id.length).trim(),
        detail: details.map((line) => line.trim()).join("\n"),
      };
    }),
    findings: [],
  };
}
