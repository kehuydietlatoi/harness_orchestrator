import { statSync } from "node:fs";
import { win32 as path } from "node:path";

const hasControl = (value: string): boolean => [...value].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/** Case-insensitive Windows environment lookup, including explicit empty values. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Pure Windows search order, shared by execution and doctor. */
export function windowsCommandCandidates(command: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
  if (!command || hasControl(command) || command.includes('"')) throw new Error("Invalid Windows command first word");
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(ext => /^\.[a-z0-9]+$/i.test(ext));
  const names = path.extname(command) ? [command] : extensions.map(ext => command + ext);
  const dirs = /[\\/:]/.test(command) ? [cwd] : [cwd, ...(envValue(env, "PATH") ?? "").split(";").map(dir => dir.replace(/^"(.*)"$/, "$1"))];
  return [...new Set(dirs.flatMap(dir => names.map(name => path.resolve(cwd, dir, name))))];
}

export function resolveWindowsCommand(command: string, cwd: string, env: NodeJS.ProcessEnv,
  isFile: (file: string) => boolean = file => { try { return statSync(file).isFile(); } catch { return false; } },
): string {
  const file = windowsCommandCandidates(command, cwd, env).find(isFile);
  if (!file) throw new Error(`Windows command not found: ${command}`);
  if (!/\.(exe|com|cmd|bat)$/i.test(file)) throw new Error(`Windows command cannot run: ${file} (expected .exe, .com, .cmd or .bat)`);
  return file;
}

const meta = /([()%!^"<>&|;, *?])/g;
const caretEscape = (value: string): string => value.replace(meta, "^$1");

/** CRT quoting, then protect both cmd's launch parse and the shim's %* forwarding parse. */
export function escapeCmdArgument(value: string): string {
  if (hasControl(value)) throw new Error("Cannot pass argument literally to a Windows batch shim: control characters are unsupported");
  const quoted = '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1") + '"';
  return caretEscape(caretEscape(quoted));
}

/**
 * Percent references in user data must not undergo cmd's initial environment
 * expansion. Expand our own variables once instead; their contents are not
 * recursively expanded. No CALL, shell syntax, or delayed expansion is used.
 */
export function windowsInvocation(file: string, args: string[], env: NodeJS.ProcessEnv): {
  command: string; args: string[]; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean;
} {
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args, env };
  if (hasControl(file) || file.includes('"')) throw new Error("Cannot pass batch shim path literally: invalid path characters");
  const values = [caretEscape(file), ...args.map(escapeCmdArgument)];
  // cmd has an 8191-character limit, including expanded variables. Leave room
  // for the interpreter and switches; never allow cmd to truncate a command.
  if (values.join(" ").length > 8000) throw new Error("Cannot pass argv literally to a Windows batch shim: command exceeds cmd's length limit");
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^ORCH_CMD_ARG_/i.test(key)));
  const refs = values.map((value, i) => {
    const key = `ORCH_CMD_ARG_${i}`;
    childEnv[key] = value;
    return `%${key}%`;
  });
  const line = '"' + refs.join(" ") + '"';
  if (line.length > 8000) throw new Error("Cannot pass argv literally to a Windows batch shim: too many arguments");
  return {
    command: path.join(envValue(env, "SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe"),
    args: ["/d", "/s", "/v:off", "/c", line], env: childEnv, windowsVerbatimArguments: true,
  };
}
