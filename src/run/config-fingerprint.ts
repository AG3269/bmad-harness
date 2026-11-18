import { createHash } from "node:crypto";
import type { Config } from "../config.js";

export function recoveryConfigFingerprint(cfg: Config, fakeAzure: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, config: cfg, fakeAzure }))
    .digest("hex");
}

export function assertRecoveryConfig(cfg: Config, fakeAzure: boolean, original?: string): void {
  if (!original || !/^[0-9a-f]{64}$/.test(original)) {
    throw new Error("The original run has no valid configuration fingerprint; inspect it manually rather than continuing automatically.");
  }
  if (recoveryConfigFingerprint(cfg, fakeAzure) !== original) {
    throw new Error("The harness configuration or Azure fake mode changed since the run began; automatic continuation is unsafe.");
  }
}
