import { describe, expect, it } from "vitest";
import { telemetryFact } from "../src/tasks/facts.js";

describe("telemetryFact", () => {
  it("maps the latest run outcome for the issue", () => {
    expect(telemetryFact([{ issue: 1, outcome: "failed" }], 1)).toBe("failed");
    expect(telemetryFact([{ issue: 1, outcome: "auto-submitted" }], 1)).toBe("submitted");
    expect(telemetryFact([{ issue: 1, outcome: "needs-attention" }], 1)).toBe("no-commits");
    expect(telemetryFact([{ issue: 2, outcome: "failed" }], 1)).toBe("none");
  });

  // A run that died on a usage limit is requeued to status:todo. If it read as "failed" the lifecycle would
  // park the requeued task as needs-attention ("run-failed"), defeating the requeue.
  it("treats a usage-limited run as no unresolved run at all", () => {
    expect(telemetryFact([{ issue: 1, outcome: "usage-limited" }], 1)).toBe("none");
  });

  it("lets a later usage-limited run supersede an earlier failure", () => {
    expect(telemetryFact([{ issue: 1, outcome: "failed" }, { issue: 1, outcome: "usage-limited" }], 1)).toBe("none");
  });
});
