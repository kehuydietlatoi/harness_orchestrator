import type { OrchConfig } from "../config.js";
import type { HarnessAdapter } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

/** Construct the adapter for an agent id, using its configured command. */
export function makeAdapter(agent: string, cfg: OrchConfig): HarnessAdapter {
  const acfg = cfg.adapters[agent] ?? { cmd: agent };
  switch (agent) {
    case "claude":
      return new ClaudeAdapter(acfg);
    case "codex":
      return new CodexAdapter(acfg);
    default:
      throw new Error(`No adapter registered for agent '${agent}'. Add one in src/adapters/.`);
  }
}

export type { HarnessAdapter, RunContext, ReviewContext, RunResult } from "./types.js";
