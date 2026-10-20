import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenarioFile, outDir] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioFile, "utf8"));
if (scenario.mode === "timeout") {
  setInterval(() => {}, 1000);
} else {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const info = { cwd: process.cwd(), sha, env: process.env };
  writeFileSync(join(outDir, "info.json"), JSON.stringify(info));
  if (scenario.mode !== "missing") {
    writeFileSync(join(outDir, "run.json"), scenario.mode === "invalid" ? "{" : JSON.stringify({
      ok: !["failed", "false"].includes(scenario.mode),
      sha: scenario.mode === "mismatch" ? "wrong" : sha,
      ...(scenario.mode === "failed" ? { error: "the player fell through the floor" } : {}),
    }));
  }
  console.error("fixture output tail");
  process.exitCode = ["failed", "exit"].includes(scenario.mode) ? 7 : 0;
}
