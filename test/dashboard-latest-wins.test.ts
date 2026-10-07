import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = /\/\/ BEGIN latest-wins[^\n]*\n([\s\S]*?)\/\/ END latest-wins/.exec(html)?.[1];
const makeLatestWins = new Function(`${block}\nreturn makeLatestWins;`)() as () => <T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
) => Promise<boolean>;

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("dashboard status refresh ordering", () => {
  it("renders the board of the newest frame when /status responses arrive out of order", async () => {
    const run = makeLatestWins();
    const rendered: string[] = [];
    const frame1 = deferred<string>();
    const frame2 = deferred<string>();
    const first = run(() => frame1.promise, (b) => rendered.push(b));
    const second = run(() => frame2.promise, (b) => rendered.push(b));
    frame2.resolve("board@frame2");
    frame1.resolve("board@frame1"); // delayed response for the older request
    expect(await second).toBe(true);
    expect(await first).toBe(false);
    expect(rendered).toEqual(["board@frame2"]);
  });

  it("ignores a stale failure but surfaces the newest one", async () => {
    const run = makeLatestWins();
    const a = deferred<string>();
    const b = deferred<string>();
    const first = run(() => a.promise, () => {});
    const second = run(() => b.promise, () => {});
    a.reject(new Error("old"));
    expect(await first).toBe(false);
    b.reject(new Error("new"));
    await expect(second).rejects.toThrow("new");
  });
});
