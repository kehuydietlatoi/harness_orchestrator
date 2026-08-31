import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLogLevel, log, parseLogLevel, setLogLevel, setLogSink, type LogLevel } from "../src/util/log.js";

describe("log", () => {
  let out: string[];
  let restoreSink: (text: string) => void;
  let originalLevel: LogLevel;

  beforeEach(() => {
    out = [];
    restoreSink = setLogSink((text) => out.push(text));
    originalLevel = getLogLevel();
  });

  afterEach(() => {
    setLogSink(restoreSink);
    setLogLevel(originalLevel);
  });

  it("parses known level names case-insensitively and rejects everything else", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel(" warn ")).toBe("warn");
    expect(parseLogLevel("loud")).toBeNull();
    expect(parseLogLevel(undefined)).toBeNull();
  });

  it("gates messages quieter than the active level", () => {
    setLogLevel("warn");
    log.error("boom");
    log.warn("careful");
    log.info("fyi");
    log.debug("trace");
    const text = out.join("");
    expect(text).toContain("boom");
    expect(text).toContain("careful");
    expect(text).not.toContain("fyi");
    expect(text).not.toContain("trace");
  });

  it("emits everything at debug and nothing at silent", () => {
    setLogLevel("debug");
    log.debug("detail");
    expect(out.join("")).toContain("detail");

    out.length = 0;
    setLogLevel("silent");
    log.error("boom");
    log.warn("careful");
    expect(out.join("")).toBe("");
  });

  it("tags warn/error and terminates each line", () => {
    setLogLevel("info");
    log.warn("hmm");
    expect(out[0]).toContain("warn:");
    expect(out[0].endsWith("\n")).toBe(true);
  });
});
