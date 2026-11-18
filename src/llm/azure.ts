import { DefaultAzureCredential } from "@azure/identity";
import type { Config } from "../config.js";

/**
 * Azure OpenAI, for the harness's own thinking.
 *
 * This is what reads diffs, compares them to stories, settles decisions and
 * writes summaries. It is NOT what the BMAD agents run on — they stay on
 * Copilot's models in VS Code. Two separate surfaces, and only this one is
 * configured here.
 *
 * Two things worth knowing about Azure specifically:
 *
 *   - You call a DEPLOYMENT, not a model. The name is whatever you called it
 *     in AI Foundry, which often isn't the model's name.
 *   - Rate limits are per-deployment and hit harder than you'd expect. The
 *     client backs off and retries on 429 rather than failing a whole run
 *     three hours in.
 */

export type Ask = {
  deployment: string;
  system?: string;
  user: string;
  /** Force a JSON object back. Use for anything the harness parses. */
  json?: boolean;
  /** Lower is steadier. Reading diffs wants near-zero. */
  temperature?: number;
  maxTokens?: number;
};

export type Usage = { prompt: number; completion: number };

export class Azure {
  private credential?: DefaultAzureCredential;
  private cachedToken?: { value: string; expiresAt: number };

  /** Running total, so the report can show what the harness itself cost. */
  readonly usage: Record<string, Usage> = {};

  constructor(private cfg: Config["azure"]) {
    if (cfg.auth === "aad") this.credential = new DefaultAzureCredential();
  }

  async ask(opts: Ask): Promise<string> {
    const url =
      `${this.cfg.endpoint.replace(/\/$/, "")}/openai/deployments/` +
      `${encodeURIComponent(opts.deployment)}/chat/completions` +
      `?api-version=${this.cfg.api_version}`;

    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: opts.user },
    ];

    const body: Record<string, unknown> = {
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 4000,
    };
    if (opts.json) body.response_format = { type: "json_object" };

    const res = await this.withRetry(url, body, opts.deployment);

    const choice = res?.choices?.[0]?.message?.content;
    if (typeof choice !== "string") {
      throw new Error(`Azure OpenAI returned nothing usable from ${opts.deployment}.`);
    }

    const u = res.usage;
    if (u) {
      const slot = (this.usage[opts.deployment] ??= { prompt: 0, completion: 0 });
      slot.prompt += u.prompt_tokens ?? 0;
      slot.completion += u.completion_tokens ?? 0;
    }

    return choice;
  }

  /** Same as ask(), but parses the JSON and gives a useful error if it isn't. */
  async askJson<T>(opts: Omit<Ask, "json">, shape: { parse: (x: unknown) => T }): Promise<T> {
    const raw = await this.ask({ ...opts, json: true });
    const text = raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      throw new Error(
        `${opts.deployment} was asked for JSON and returned something else:\n` +
        text.slice(0, 400),
      );
    }
    return shape.parse(parsed);
  }

  // ---------------------------------------------------------------------------

  private async withRetry(url: string, body: unknown, deployment: string): Promise<any> {
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await this.authHeader()) },
        body: JSON.stringify(body),
      });

      if (res.ok) return res.json();

      // Rate limited or a transient server problem. Azure sends Retry-After
      // on 429 and it's usually accurate — use it rather than guessing.
      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxAttempts) {
          throw new Error(
            `Azure OpenAI kept returning ${res.status} for ${deployment} after ` +
            `${maxAttempts} tries. Check the deployment's rate limit.`,
          );
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 1000, 30_000);
        await sleep(waitMs);
        continue;
      }

      // Everything else is a real problem — wrong deployment name, no access,
      // malformed request. Retrying won't help.
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Azure OpenAI said no (HTTP ${res.status}) for deployment "${deployment}".\n` +
        hint(res.status, deployment) +
        (detail ? `\n${detail.slice(0, 300)}` : ""),
      );
    }

    throw new Error("unreachable");
  }

  private async authHeader(): Promise<Record<string, string>> {
    if (this.cfg.auth === "key") {
      const key = process.env[this.cfg.key_env];
      if (!key) throw new Error(`${this.cfg.key_env} isn't set.`);
      return { "api-key": key };
    }

    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) {
      return { Authorization: `Bearer ${this.cachedToken.value}` };
    }

    const token = await this.credential!.getToken(
      "https://cognitiveservices.azure.com/.default",
    );
    if (!token) {
      throw new Error(
        "Couldn't get an Azure token. Try `az login`, or switch azure.auth to `key`.",
      );
    }

    this.cachedToken = { value: token.token, expiresAt: token.expiresOnTimestamp };
    return { Authorization: `Bearer ${token.token}` };
  }
}

function hint(status: number, deployment: string): string {
  if (status === 401 || status === 403) {
    return `  Looks like access. With auth: aad you need the "Cognitive Services ` +
           `OpenAI User" role on the resource — being its owner isn't enough.`;
  }
  if (status === 404) {
    return `  "${deployment}" isn't a deployment on that endpoint. Deployment names ` +
           `are what you called them in AI Foundry, not model names.`;
  }
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
