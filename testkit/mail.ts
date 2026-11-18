/**
 * Reads verification codes out of the shared Outlook mailbox.
 *
 * This belongs with your Playwright tests, not with the harness — copy it into
 * the KinLoop repo. It's here so it's alongside everything else while you set
 * things up.
 *
 * Before this works, once:
 *   1. Register an app in your tenant.
 *   2. Give it Mail.Read and Mail.ReadWrite (application permissions).
 *   3. IMPORTANT — restrict it to just the test mailboxes with an application
 *      access policy. Without that step it can read every mailbox you have.
 *   4. Put the details in the environment variables below.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export type MailConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The shared mailbox, e.g. kinloop.tests@yourdomain.com */
  mailbox: string;
};

export function configFromEnv(): MailConfig {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing ${k}. The mail helper can't run without it.`);
    return v;
  };
  return {
    tenantId: need("E2E_TENANT_ID"),
    clientId: need("E2E_CLIENT_ID"),
    clientSecret: need("GRAPH_MAIL_CREDENTIAL"),
    mailbox: need("E2E_MAILBOX"),
  };
}

export class Mail {
  private token?: { value: string; expiresAt: number };

  constructor(private cfg: MailConfig) {}

  /**
   * Waits for a code to arrive and returns it.
   *
   * `sentAfter` is not optional in practice. Without it, a retried test picks
   * up the code from the previous attempt, passes, and tells you nothing.
   * Always capture the time just before you trigger the email.
   */
  async waitForCode(opts: {
    to: string;
    sentAfter: Date;
    pattern?: RegExp;
    timeoutMs?: number;
  }): Promise<string> {
    const pattern = opts.pattern ?? /\b(\d{6})\b/;
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);

    while (Date.now() < deadline) {
      const messages = await this.recent(opts.to, opts.sentAfter);
      for (const m of messages) {
        const found = (m.body?.content ?? m.bodyPreview ?? "").match(pattern);
        if (found?.[1]) return found[1];
      }
      await sleep(2000);
    }

    throw new Error(
      `No code arrived for ${opts.to} within ${(opts.timeoutMs ?? 60_000) / 1000}s.\n` +
      `Check: is the address right? did the app actually send? is the mailbox ` +
      `the one the app sends to?`,
    );
  }

  /** Messages to an address since a time. */
  private async recent(to: string, since: Date): Promise<any[]> {
    const filter = encodeURIComponent(
      `receivedDateTime ge ${since.toISOString()}`,
    );
    const url =
      `${GRAPH}/users/${encodeURIComponent(this.cfg.mailbox)}/messages` +
      `?$filter=${filter}&$orderby=receivedDateTime desc&$top=25` +
      `&$select=id,subject,bodyPreview,body,toRecipients,receivedDateTime`;

    const res = await this.get(url);

    // Filter by recipient here rather than in the query — plus-addressed
    // recipients don't always match cleanly in Graph filters.
    const wanted = to.toLowerCase();
    return (res.value ?? []).filter((m: any) =>
      (m.toRecipients ?? []).some(
        (r: any) => (r.emailAddress?.address ?? "").toLowerCase() === wanted,
      ),
    );
  }

  /**
   * Empties the mailbox. Run this before a test run.
   *
   * Skip it and old codes stay around to be matched by accident, which shows
   * up as tests that pass for the wrong reason.
   */
  async clear(): Promise<number> {
    const url =
      `${GRAPH}/users/${encodeURIComponent(this.cfg.mailbox)}/messages` +
      `?$select=id&$top=100`;

    let removed = 0;
    for (;;) {
      const res = await this.get(url);
      const items = res.value ?? [];
      if (items.length === 0) break;
      for (const m of items) {
        await this.delete(
          `${GRAPH}/users/${encodeURIComponent(this.cfg.mailbox)}/messages/${m.id}`,
        );
        removed++;
      }
      if (items.length < 100) break;
    }
    return removed;
  }

  // --- plumbing --------------------------------------------------------------

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.value;
    }

    const res = await fetch(
      `https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );

    if (!res.ok) {
      // Deliberately vague — the response can contain things worth not logging.
      throw new Error(`Couldn't get a token from Microsoft (HTTP ${res.status}).`);
    }

    const json: any = await res.json();
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return this.token.value;
  }

  private async get(url: string): Promise<any> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!res.ok) throw new Error(`Graph said no (HTTP ${res.status}) for ${url.split("?")[0]}`);
    return res.json();
  }

  private async delete(url: string): Promise<void> {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Couldn't delete a message (HTTP ${res.status})`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A unique address per run, so two runs can't read each other's mail.
 * Needs plus-addressing turned on for the mailbox.
 */
export function addressFor(mailbox: string, tag: string): string {
  const [name, domain] = mailbox.split("@");
  return `${name}+${tag}@${domain}`;
}
