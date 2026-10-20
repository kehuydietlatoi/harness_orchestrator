import { describe, expect, it } from "vitest";
import { escapeCmdArgument, resolveWindowsCommand, windowsCommandCandidates, windowsInvocation } from "../src/util/win-command.js";

const env = { Path: 'C:\\tools;"C:\\other tools"', PATHEXT: ".EXE;.CMD;.BAT;.COM", SystemRoot: "C:\\Windows" };

describe("Windows resolution (pure on every platform)", () => {
  it("searches cwd then PATH in PATHEXT order with Windows environment casing", () => {
    expect(windowsCommandCandidates("npm", "C:\\repo", env)).toEqual([
      "C:\\repo\\npm.EXE", "C:\\repo\\npm.CMD", "C:\\repo\\npm.BAT", "C:\\repo\\npm.COM",
      "C:\\tools\\npm.EXE", "C:\\tools\\npm.CMD", "C:\\tools\\npm.BAT", "C:\\tools\\npm.COM",
      "C:\\other tools\\npm.EXE", "C:\\other tools\\npm.CMD", "C:\\other tools\\npm.BAT", "C:\\other tools\\npm.COM",
    ]);
    expect(resolveWindowsCommand("npm", "C:\\repo", env, file => file === "C:\\tools\\npm.CMD")).toBe("C:\\tools\\npm.CMD");
  });
  it("resolves explicit and relative paths without searching PATH", () => {
    expect(windowsCommandCandidates(".\\bin\\run.cmd", "C:\\repo", env)).toEqual(["C:\\repo\\bin\\run.cmd"]);
    expect(windowsCommandCandidates("D:\\bin\\run.exe", "C:\\repo", env)).toEqual(["D:\\bin\\run.exe"]);
  });
  it("refuses missing commands, invalid first words and unsupported PATHEXT types", () => {
    expect(() => resolveWindowsCommand("absent", "C:\\repo", env, () => false)).toThrow("not found");
    expect(() => windowsCommandCandidates('"npm"', "C:\\repo", env)).toThrow("first word");
    expect(() => resolveWindowsCommand("script", "C:\\repo", { PATHEXT: ".VBS;.EXE" }, () => true)).toThrow("cannot run");
  });
});

describe("Windows launch planning", () => {
  it.each([".exe", ".com"])("keeps native %s argv unchanged", extension => {
    const args = ["space & here", "%PATH%", 'a"b', "line\nbreak"];
    expect(windowsInvocation("C:\\node" + extension, args, env)).toEqual({ command: "C:\\node" + extension, args, env });
  });
  it("quotes empty arguments, backslashes, quotes and cmd metacharacters for both parses", () => {
    expect(escapeCmdArgument("")).toBe('^^^"^^^"');
    expect(escapeCmdArgument("a&b")).toContain("a^^^&b");
    expect(escapeCmdArgument("a^b")).toContain("a^^^^b");
    expect(escapeCmdArgument('a"b')).toContain('a\\^^^"b');
    expect(escapeCmdArgument("trail\\")).toContain('trail\\\\^^^"');
    for (const ch of ["%", "!", "|", "<", ">", "(", ")"]) expect(escapeCmdArgument(ch)).toContain("^^^" + ch);
  });
  it("uses single expansion indirection and disables delayed expansion", () => {
    const original = { ...env, orch_cmd_arg_0: "stale", ORCH_CMD_ARG_99: "stale" };
    const plan = windowsInvocation("C:\\space here\\npm.cmd", ["%PATH%", "!PATH!", 'a"b'], original);
    expect(plan.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(plan.args).toEqual(["/d", "/s", "/v:off", "/c", '"%ORCH_CMD_ARG_0% %ORCH_CMD_ARG_1% %ORCH_CMD_ARG_2% %ORCH_CMD_ARG_3%"']);
    expect(plan.env.ORCH_CMD_ARG_0).toBe("C:\\space^ here\\npm.cmd");
    expect(plan.env.ORCH_CMD_ARG_1).toBe(escapeCmdArgument("%PATH%"));
    expect(plan.env).not.toHaveProperty("orch_cmd_arg_0");
    expect(plan.env).not.toHaveProperty("ORCH_CMD_ARG_99");
    expect(original.orch_cmd_arg_0).toBe("stale");
    expect(plan.windowsVerbatimArguments).toBe(true);
  });
  it.each(["\0", "\r", "\n", "\t", "\x7f"])("refuses unsupported control character %j", ch => {
    expect(() => windowsInvocation("C:\\shim.bat", ["a" + ch + "b"], env)).toThrow("Cannot pass argument literally");
  });
  it("refuses expansion and reference lines exceeding cmd limits", () => {
    expect(() => windowsInvocation("C:\\shim.cmd", ["x".repeat(8100)], env)).toThrow("length limit");
    expect(() => windowsInvocation("C:\\shim.cmd", Array(500).fill(""), env)).toThrow("too many arguments");
  });
});
