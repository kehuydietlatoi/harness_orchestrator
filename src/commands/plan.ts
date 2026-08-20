import pc from "picocolors";
import { loadConfig } from "../config.js";
import { planFromFile, assignRoundRobin } from "../plan.js";

export async function planCommand(file: string): Promise<void> {
  const cwd = process.cwd();
  loadConfig(cwd); // ensure initialised repo
  const created = await planFromFile(file, cwd);
  console.log(pc.green(`Created ${created.length} issue(s):`));
  created.forEach((c) =>
    console.log(`  #${c.number} ${c.title}${c.id ? pc.dim(` (${c.id})`) : ""}`),
  );
}

export async function assignCommand(): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const assignments = await assignRoundRobin(cfg, cwd);
  if (!assignments.length) {
    console.log(pc.yellow("Nothing eligible to assign."));
    return;
  }
  console.log(pc.bold("Assigned:"));
  assignments.forEach((a) => console.log(`  #${a.issue} -> ${a.agent}`));
}
