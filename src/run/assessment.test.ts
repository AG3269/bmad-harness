import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecoveryAssessment } from "./recover.js";

const report = {
  summary: "The story remains blocked pending approval.",
  next_step: "human",
  uncertainties: ["The required approval has not been recorded."],
};
const json = JSON.stringify(report);

for (const [name, text] of [
  ["plain JSON", json],
  ["JSON code fence", `\`\`\`json\n${json}\n\`\`\``],
  ["unlabelled code fence", `\`\`\`\n${json}\n\`\`\``],
  ["completion wrapper", `**Task completed:**\n\n${json}`],
  ["prose wrapper", `Recovery assessment:\n${json}\nEnd of assessment.`],
] as const) {
  test(`reads a complete assessment from ${name}`, () => {
    assert.deepEqual(parseRecoveryAssessment(text), report);
  });
}

test("duplicate completion reports retain both summaries and all distinct uncertainties", () => {
  const completion = {
    summary: "No implementation was authorized.",
    next_step: "human",
    uncertainties: [...report.uncertainties, "The next human choice is unknown."],
  };
  const parsed = parseRecoveryAssessment(`${json}\n\n**Task completed:**\n\n${JSON.stringify(completion)}`);
  assert.equal(parsed.summary, `${report.summary}\n\n${completion.summary}`);
  assert.equal(parsed.next_step, "human");
  assert.deepEqual(parsed.uncertainties, completion.uncertainties);
  assert.deepEqual(parseRecoveryAssessment(`${json}\n\n${json}`), report);
});

test("braces, brackets, quotes and Windows paths inside JSON strings are not payload boundaries", () => {
  const value = {
    ...report, summary: 'Inspect C:\\synthetic\\story.md: "{status}" and [approval] remain uncertain. A slash: \\',
  };
  assert.deepEqual(parseRecoveryAssessment(JSON.stringify(value)), value);
});

test("conflicting next steps are rejected instead of selecting the first or last report", () => {
  const conflicting = JSON.stringify({ ...report, next_step: "develop", uncertainties: [] });
  assert.throws(() => parseRecoveryAssessment(`${json}\n\n**Task completed:**\n\n${conflicting}`), /conflicting next steps/);
});

for (const [name, text] of [
  ["empty output", ""],
  ["prose only", "The assessment is complete."],
  ["truncated JSON", json.slice(0, -1)],
  ["invalid JSON", '{"summary": broken}'],
  ["wrong shape", "{}"],
  ["root array", `[${json}]`],
  ["unknown field", JSON.stringify({ ...report, approved: true })],
  ["valid followed by truncation", `${json}\n{"summary":`],
  ["valid followed by invalid format", `${json}\n{}`],
  ["valid preceded by invalid format", `{}\n${json}`],
  ["malformed array boundary", json.replace('["The required', '{"The required')],
] as const) {
  test(`rejects ${name} without discarding malformed or uncertain content`, () => {
    assert.throws(() => parseRecoveryAssessment(text), /not valid JSON|invalid format/);
  });
}

test("combining reports never truncates text or drops uncertainty to meet schema limits", () => {
  const first = { ...report, summary: "a".repeat(2000) };
  const second = { ...report, summary: "b".repeat(2000) };
  assert.throws(() => parseRecoveryAssessment(`${JSON.stringify(first)}\n${JSON.stringify(second)}`), /format limits/);
  const many = { ...report, uncertainties: Array.from({ length: 20 }, (_, index) => `Uncertainty ${index}`) };
  assert.throws(() => parseRecoveryAssessment(`${JSON.stringify(many)}\n${json}`), /format limits/);
});
