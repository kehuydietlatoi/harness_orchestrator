import pc from "picocolors";
import { addFact, listFacts } from "../memory.js";

export async function memoryAddCommand(text: string, opts: { type?: string }): Promise<void> {
  addFact(text, opts.type ?? "note", process.cwd());
  console.log(pc.green("Recorded to AGENTS.md (shared by every harness)."));
}

export async function memoryListCommand(): Promise<void> {
  const facts = listFacts(process.cwd());
  if (!facts.length) {
    console.log(pc.dim("(no logged facts yet)"));
    return;
  }
  console.log(pc.bold("Shared memory log:"));
  facts.forEach((f) => console.log("  " + f));
}
