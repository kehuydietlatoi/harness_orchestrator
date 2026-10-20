import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareReviewCheckout, type ReviewCheckout } from "../board/review-run.js";
import { projectStateDir } from "../board/telemetry.js";
import { DEFAULT_CONFIG, type OrchConfig } from "../config.js";
import { exec, type ExecResult } from "../util/exec.js";
import { appendEvent } from "./events.js";
import { verifyEnvironment } from "./verify.js";

export interface EvidenceResult {
  scenario: string;
  status: "ok" | "failed";
  error?: string;
  outDir: string;
  durationMs: number;
}

export interface EvidenceRunDeps {
  runner: typeof exec;
  checkout: typeof prepareReviewCheckout;
  appendEvent: typeof appendEvent;
  now(): number;
}

const defaultDeps: EvidenceRunDeps = {
  runner: exec, checkout: prepareReviewCheckout, appendEvent, now: Date.now,
};

function commandError(result: ExecResult): string {
  return `exit code ${result.code}: ${(result.stdout + "\n" + result.stderr).trim().slice(-4000)}`;
}

/** Run trusted local evidence argv against an exact, detached head checkout.
 * Ownership of the checkout passes to the caller, including on scenario failure.
 */
export async function runEvidence(
  params: { cfg: OrchConfig; cwd: string; issue: number; prNumber: number; sha: string; scenarios: readonly string[] },
  deps: EvidenceRunDeps = defaultDeps,
): Promise<{ checkout: ReviewCheckout; results: EvidenceResult[] }> {
  const { cfg, cwd, issue, prNumber, sha, scenarios } = params;
  if (!cfg.evidence?.length) throw new Error("evidence command is not configured");
  // These names become paths, so enforce the same boundary as ticket metadata.
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error("evidence requires a full head SHA");
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error("evidence requires an issue number");
  for (const name of scenarios) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid evidence scenario: ${name}`);
  }
  const checkout = await deps.checkout({ number: prNumber, headSha: sha }, cwd);
  try {
    const options = {
      contain: true,
      cwd: checkout.path,
      env: { ...verifyEnvironment(), PWD: resolve(checkout.path) },
      timeoutMs: cfg.evidenceTimeoutMs ?? DEFAULT_CONFIG.evidenceTimeoutMs!,
    };
    const started = deps.now();
    let setupError: string | undefined;
    for (const argv of cfg.evidenceSetup ?? []) {
      try {
        const result = await deps.runner(argv[0], argv.slice(1), options);
        if (result.code !== 0) setupError = `evidence setup failed (${JSON.stringify(argv)}): ${commandError(result)}`;
      } catch (error) {
        setupError = `evidence setup failed: ${String(error)}`;
      }
      if (setupError) break;
    }
    const results: EvidenceResult[] = [];
    for (const scenario of scenarios) {
      const scenarioStarted = setupError ? started : deps.now();
      const outDir = resolve(cwd, cfg.evidenceDir ?? join(projectStateDir(cwd), "evidence"), String(issue), sha, scenario);
      let error = setupError;
      try {
        rmSync(outDir, { recursive: true, force: true });
        mkdirSync(outDir, { recursive: true });
        const scenarioFile = resolve(checkout.path, cfg.scenariosDir ?? DEFAULT_CONFIG.scenariosDir!, `${scenario}.json`);
        if (!error) {
          try {
            if (!statSync(scenarioFile).isFile()) error = `missing scenario file: ${scenarioFile}`;
          } catch { error = `missing scenario file: ${scenarioFile}`; }
        }
        if (!error) {
          const argv = cfg.evidence!;
          const result = await deps.runner(argv[0], [...argv.slice(1), scenarioFile, outDir], options);
          let manifest: unknown;
          try { manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf8")); }
          catch (readError) { error = `missing or invalid run.json: ${String(readError)}`; }
          const run = manifest as { ok?: unknown; sha?: unknown; error?: unknown } | null | undefined;
          // A runner's own failure diagnosis is more useful than its exit code.
          if (run && typeof run.error === "string" && run.error.trim() && (result.code !== 0 || run.ok !== true)) {
            error = run.error;
          } else if (result.code !== 0) {
            error = commandError(result);
          } else if (!error) {
            if (run?.sha !== sha) error = `run.json SHA mismatch: expected ${sha}, got ${String(run?.sha)}`;
            else if (run?.ok !== true) error = "run.json did not report ok: true";
          }
        }
      } catch (failure) {
        error = error ?? `evidence failed: ${String(failure)}`;
      }
      const result: EvidenceResult = {
        scenario, status: error ? "failed" : "ok", ...(error ? { error } : {}),
        outDir, durationMs: deps.now() - scenarioStarted,
      };
      results.push(result);
      deps.appendEvent({
        type: "observe.evidence", issue, pr: prNumber, sha, scenario,
        ok: result.status === "ok", ...(error ? { error } : {}), outDir, durationMs: result.durationMs,
      }, cwd);
    }
    return { checkout, results };
  } catch (error) {
    await checkout.release();
    throw error;
  }
}
