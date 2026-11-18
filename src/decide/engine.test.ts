import assert from "node:assert/strict";
import { test } from "node:test";
import { Question } from "./engine.js";

const question = {
  kind: "approval-required",
  asks: "Which approved contract should be used?",
  options: [
    { id: "provide", label: "Provide an approved contract" },
    { id: "blocked", label: "Leave the story blocked" },
  ],
};

test("string-form questions retain their text and existing defaults", () => {
  const parsed = Question.parse(question);
  assert.equal(parsed.asks, question.asks);
  assert.equal(parsed.context, "");
  assert.equal(parsed.options[0]!.undoable, true);
});

test("array-form asks preserve every paragraph, context and option without mutating input", () => {
  const paragraphs = [
    "How should the missing architecture approvals be resolved?",
    "Prior story approval does not approve the current story.",
  ];
  const value = { ...question, asks: paragraphs, context: "The story remains Blocked." };
  const before = structuredClone(value);
  const parsed = Question.parse(value);
  assert.equal(parsed.asks, paragraphs.join("\n\n"));
  assert.equal(parsed.context, value.context);
  assert.deepEqual(parsed.options.map((option) => option.id), ["provide", "blocked"]);
  assert.deepEqual(value, before);
  assert.equal(Question.parse({ ...question, asks: [question.asks] }).asks, question.asks);
});

for (const [name, asks] of [
  ["empty array", []],
  ["empty paragraph", [""]],
  ["blank paragraph", [" \n\t "]],
  ["mixed types", ["A valid paragraph", 123]],
  ["objects", [{ asks: "A separate question" }]],
  ["nested arrays", [["A separate question"]]],
] as const) {
  test(`invalid array-form asks are rejected: ${name}`, () => {
    assert.equal(Question.safeParse({ ...question, asks }).success, false);
  });
}

test("the 800-character limit applies to the complete normalized question without truncation", () => {
  const exact = ["a".repeat(399), "b".repeat(399)];
  assert.equal(Question.parse({ ...question, asks: exact }).asks, exact.join("\n\n"));
  assert.equal(Question.safeParse({ ...question, asks: ["a".repeat(400), "b".repeat(399)] }).success, false);
  assert.equal(Question.safeParse({ ...question, asks: "a".repeat(801) }).success, false);
});
