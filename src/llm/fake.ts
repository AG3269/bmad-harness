import type { Azure } from "./azure.js";

/**
 * A pretend Azure OpenAI, for dry runs.
 *
 * Set HARNESS_FAKE_AZURE=1 and the whole harness runs offline: no endpoint, no
 * credentials, no spend. Useful for checking your config, your story parsing
 * and the shape of the report before pointing it at anything real.
 *
 * It reads canned replies from `fixtures/azure/<deployment>.json` when they
 * exist, and otherwise invents something harmless.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function fakeAzure(
  deployments?: Record<string, string>,
  fixtures = "fixtures",
): Azure {
  /**
   * Work out which job this call is doing.
   *
   * Not by deployment name — several roles usually share one deployment, and
   * the reader and the comparer nearly always do. The prompts are distinct, so
   * match on those and fall back to the name.
   */
  const roleOf = (deployment: string, system: string, user: string): string => {
    const text = `${system}\n${user}`;
    if (/describe what they do|reply with only this JSON[\s\S]*inferred_criteria/i.test(text)) return "reader";
    if (/comparing what was asked for against what was built/i.test(text)) return "comparer";
    if (/whether an agent stopped to ask|pick between options/i.test(text)) return "decider";
    if (/briefings for someone who stepped away/i.test(text)) return "summarizer";

    const named = Object.entries(deployments ?? {}).find(([, n]) => n === deployment);
    return named?.[0] ?? deployment;
  };

  const usage: Record<string, { prompt: number; completion: number }> = {};

  const canned = (role: string): unknown | null => {
    const p = path.join(fixtures, "azure", `${role}.json`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  };

  const invent = (role: string, user: string): unknown => {
    if (role.includes("reader")) {
      return {
        summary: "[fake] A change was made. Turn off HARNESS_FAKE_AZURE for a real reading.",
        capabilities: [], inferred_criteria: [], surfaces: [], incomplete: [],
        confidence: 0.9,
      };
    }
    if (role.includes("comparer")) {
      // Mark every criterion covered — a dry run shouldn't fail stories for
      // reasons that are an artefact of there being no real model.
      const ids = [...user.matchAll(/^- (AC\d+):/gim)].map((m) => m[1]);
      return {
        criteria: ids.map((id) => ({ id, verdict: "covered", evidence: "[fake]" })),
        extra: [], divergences: [], overall: "[fake] dry run — nothing was really checked.",
      };
    }
    if (role.includes("decider")) {
      return { asking: false };
    }
    if (role.includes("summarizer")) {
      return "[fake] No summary in a dry run — turn off HARNESS_FAKE_AZURE for a real one.";
    }
    return {};
  };

  return {
    usage,
    async ask(opts: any) {
      const role = roleOf(opts.deployment, opts.system ?? "", opts.user ?? "");
      const body = canned(role) ?? invent(role, opts.user ?? "");
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async askJson(opts: any, shape: any) {
      const role = roleOf(opts.deployment, opts.system ?? "", opts.user ?? "");
      return shape.parse(canned(role) ?? invent(role, opts.user ?? ""));
    },
  } as unknown as Azure;
}
