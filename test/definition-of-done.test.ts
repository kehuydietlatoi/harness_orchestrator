import { describe, expect, it } from "vitest";
import {
  DOD_HEADING,
  OUT_OF_SCOPE_HEADING,
  definitionOfDoneWarnings,
  hasDefinitionOfDone,
  namesACheck,
  openEndedWord,
  renderDefinitionOfDone,
} from "../src/tasks/definition-of-done.js";

describe("renderDefinitionOfDone / hasDefinitionOfDone", () => {
  it("renders a checklist and an out-of-scope list, and is detected by the heading", () => {
    const text = renderDefinitionOfDone(["`npm test` passes", "a test fails without the guard"], ["polish, owned by #97"]);
    expect(text).toBe(
      `${DOD_HEADING}\n- [ ] \`npm test\` passes\n- [ ] a test fails without the guard\n\n${OUT_OF_SCOPE_HEADING}\n- polish, owned by #97`,
    );
    expect(hasDefinitionOfDone(`Spec.\n\n${text}\n\nDepends-on: #1`)).toBe(true);
  });

  it("renders nothing without items, collapsing whitespace and applying the sanitizer to each item", () => {
    expect(renderDefinitionOfDone([], undefined)).toBe("");
    expect(renderDefinitionOfDone(["  ", ""], [" "])).toBe("");
    expect(renderDefinitionOfDone(["line one\n  line two"], undefined, (s) => s.toUpperCase())).toBe(`${DOD_HEADING}\n- [ ] LINE ONE LINE TWO`);
    expect(renderDefinitionOfDone(undefined, ["only out of scope"])).toBe(`${OUT_OF_SCOPE_HEADING}\n- only out of scope`);
  });

  it("only recognises a real section heading, not prose or bold text", () => {
    expect(hasDefinitionOfDone("### Definition of done\n- [ ] x")).toBe(true);
    expect(hasDefinitionOfDone("The definition of done is unclear.")).toBe(false);
    expect(hasDefinitionOfDone("**Definition of done (supervisor decision).** Review against...")).toBe(false);
    expect(hasDefinitionOfDone("# Definition of done")).toBe(false); // top-level title, not a ticket section
    expect(hasDefinitionOfDone("")).toBe(false);
  });
});

describe("open-ended wording lint", () => {
  it("finds unbounded words on word boundaries only", () => {
    expect(openEndedWord("Model every flow")).toBe("every");
    expect(openEndedWord("A CANONICAL model")).toBe("canonical");
    expect(openEndedWord("overall, fully done recall")).toBeNull(); // not the words themselves
    expect(openEndedWord("Add a flag")).toBeNull();
  });

  it("recognises acceptance items that name a check", () => {
    for (const item of ["`npm test` passes", "the command exits 0", "returns 401 for a missing cookie", "a snapshot pins the frames"]) {
      expect(namesACheck(item), item).toBe(true);
    }
    for (const item of ["handles errors well", "looks good", "is robust"]) expect(namesACheck(item), item).toBe(false);
  });

  it("builds both warnings with the ticket number", () => {
    expect(definitionOfDoneWarnings(3, { title: "Cover all cases" })).toEqual([
      expect.stringMatching(/^ticket 3 has no definition of done/),
      expect.stringMatching(/^ticket 3 reads as open-ended \("all"\)/),
    ]);
    expect(definitionOfDoneWarnings(3, { title: "Cover all cases", acceptance: ["a test fails if a case is missing"] })).toEqual([]);
  });
});
