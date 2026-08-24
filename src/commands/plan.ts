import pc from "picocolors";
import { loadConfig } from "../config.js";
import { planFromFile } from "../plan.js";

export async function planCommand(file: string): Promise<void> {
  const cwd = process.cwd();
  loadConfig(cwd); // ensure initialised repo
  const created = await planFromFile(file, cwd);
  console.log(pc.green(`Created ${created.length} issue(s):`));
  created.forEach((c) =>
    console.log(`  #${c.number} ${c.title}${c.id ? pc.dim(` (${c.id})`) : ""}`),
  );
}
