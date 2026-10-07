// The scenario registry. Each scenario module appends its list here.
import type { Scenario } from "../scenario-engine.js";
import { CORE_SCENARIOS } from "./core.js";
import { AUTOPILOT_SCENARIOS } from "./autopilot.js";
import { RECOVERY_SCENARIOS } from "./recovery.js";

export const SCENARIOS: readonly Scenario[] = [
  ...CORE_SCENARIOS,
  ...AUTOPILOT_SCENARIOS,
  ...RECOVERY_SCENARIOS,
];
