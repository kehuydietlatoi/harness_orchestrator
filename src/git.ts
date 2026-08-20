import { exec } from "./util/exec.js";

export async function isGitRepo(cwd: string = process.cwd()): Promise<boolean> {
  const r = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function gitVersion(): Promise<string> {
  const r = await exec("git", ["--version"]);
  return r.stdout.trim();
}

export async function remoteUrl(cwd: string = process.cwd()): Promise<string | null> {
  const r = await exec("git", ["remote", "get-url", "origin"], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** git worktree add landed in 2.5 and stabilised by 2.15. */
export async function supportsWorktree(): Promise<boolean> {
  const v = await gitVersion(); // e.g. "git version 2.40.0.windows.1"
  const m = v.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 2 || (major === 2 && minor >= 15);
}
