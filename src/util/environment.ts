/** Shared credential stripping for workers and host verification, on every OS. */
export function cleanEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(?:ANTHROPIC_|OPENAI_|OPENCODE_|CODEX_)/i.test(key) &&
    !/(?:^|_)(?:TOKEN|API_KEY|AUTH|PASSWORD|SECRET|CREDENTIALS?)(?:_|$)/i.test(key)));
}

/** Restore only explicitly configured credentials; GitHub tokens are never worker input. */
export function workerEnvironment(agent: string, names: readonly string[] = [], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = cleanEnvironment(source);
  const allowed = new Set([...names, ...(agent === "codex" ? ["CODEX_HOME"] : [])]
    .map(name => process.platform === "win32" ? name.toUpperCase() : name));
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !/^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)$/i.test(key) &&
        allowed.has(process.platform === "win32" ? key.toUpperCase() : key)) env[key] = value;
  }
  return env;
}
