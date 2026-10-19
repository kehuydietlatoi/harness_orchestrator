/** Issue-supplied argv is host-executable only as a constrained extension of local config. */
export function verifyTrustErrors(commands: readonly string[][], project: readonly string[][]): string[] {
  return commands.flatMap((argv) => {
    const prefixes = project.filter((prefix) => prefix.length > 0 && prefix.length <= argv.length &&
      prefix.every((arg, i) => arg === argv[i]));
    if (!prefixes.length) {
      const closest = project.reduce<string[]>((best, prefix) => {
        let length = 0;
        while (length < prefix.length && length < argv.length && prefix[length] === argv[length]) length++;
        const common = prefix.slice(0, length);
        return common.length > best.length ? common : best;
      }, []);
      return [`verify argument ${JSON.stringify(argv[closest.length] ?? argv[0])} in ${JSON.stringify(argv)} does not match a project verify prefix`];
    }
    const prefix = prefixes.sort((a, b) => b.length - a.length)[0];
    return argv.slice(prefix.length).filter((arg) => {
      if (arg === "--" || /^\d+(?:\.\d+)?$/.test(arg)) return false;
      const path = arg.replace(/\\/g, "/");
      return !path || path.startsWith("-") || path.startsWith("/") || path.includes(":") ||
        path.split("/").includes("..") || [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
    }).map((arg) => `verify argument ${JSON.stringify(arg)} must be a repository-relative path, --, or plain number`);
  });
}

export { cleanEnvironment as verifyEnvironment } from "../util/environment.js";
