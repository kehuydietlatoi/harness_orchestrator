import { describe, it, expect } from "vitest";
import { renderTicketBody } from "../src/tasks/plan.js";

describe("renderTicketBody", () => {
  it("includes body, file-ownership hints, and resolved deps", () => {
    const body = renderTicketBody(
      { title: "x", body: "do the thing", files: ["src/a.ts", "src/b.ts"] },
      [3, 4],
    );
    expect(body).toContain("do the thing");
    expect(body).toContain("`src/a.ts`");
    expect(body).toContain("Depends-on: #3, #4");
  });

  it("falls back to a placeholder for an empty ticket", () => {
    expect(renderTicketBody({ title: "x" }, [])).toBe("_(no description)_");
  });
});
