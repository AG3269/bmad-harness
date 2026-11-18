/**
 * What the harness needs from VS Code.
 *
 * The session already exists: the harness attaches to it rather than creating
 * a new VS Code session or configuring BMAD.
 *
 * Kept small on purpose, so the stub and the real one stay interchangeable.
 */

export type Turn = {
  /** Stable identifier recorded before dispatch so an interrupted turn can be found. */
  id?: string;
  /** Reconciliation turns must not execute tools. */
  noTools?: boolean;
  /** Which BMAD agent to switch to, by name. */
  agent: string;
  /** Which model to switch to. Pinned so runs are repeatable. */
  model: string;
  /** What to say. */
  say: string;
  timeoutMs?: number;
};

export type Reply = {
  /** What came back as text. */
  text: string;
  /** Files it reported changing, if the driver can tell. */
  changed: string[];
  /** True if the session went idle without producing anything. */
  idle: boolean;
};

export interface VSCode {
  /** Connect to the running session. Fails loudly if there isn't one. */
  attach(): Promise<void>;

  /** Which session we're driving — shown to the user so they can find it. */
  readonly describe: string;

  /** The folder the session has open. Diffs and file reads happen here. */
  readonly folder: string;

  /** Switch agent and model, send a message, wait for it to finish. */
  send(turn: Turn): Promise<Reply>;

  /** Read a file in the session folder. */
  readFile(relativePath: string): string | null;

  /** Delete a file in the session folder. */
  removeFile(relativePath: string): void;

  detach(): Promise<void>;
}
