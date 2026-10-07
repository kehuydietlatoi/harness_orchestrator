import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = /\/\/ BEGIN flow-route-path[^\n]*\n([\s\S]*?)\/\/ END flow-route-path/.exec(html)?.[1];
const { flowRoutePath } = new Function(`${block}\nreturn { flowRoutePath };`)() as {
  flowRoutePath: (points: { x: number; y: number }[]) => string;
};

describe("flow route path", () => {
  it("turns route points into an SVG path string", () => {
    expect(flowRoutePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }])).toBe("M0,0 L10,0 L10,5");
  });
});
