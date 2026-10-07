import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NODES } from "../src/demo/flow-graph.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = /\/\/ BEGIN flow-adr-link[^\n]*\n([\s\S]*?)\/\/ END flow-adr-link/.exec(html)?.[1];
const { flowAdrLink, ORCH_DOCS_URL } = new Function(`${block}\nreturn { flowAdrLink, ORCH_DOCS_URL };`)() as {
  flowAdrLink: (adr: string) => { path: string; href: string };
  ORCH_DOCS_URL: string;
};

describe("flow node ADR links", () => {
  it("links every node's ADR to the real orch file, independent of snapshot.repoUrl (demo or normal)", () => {
    const withAdr = NODES.filter((n) => n.adr);
    expect(withAdr.length).toBeGreaterThan(0);
    for (const node of withAdr) {
      const { path, href } = flowAdrLink(node.adr!);
      expect(existsSync(new URL(`../${path}`, import.meta.url)), `${node.id} -> ${path}`).toBe(true);
      expect(path).toMatch(/^docs\/adr\/\d{4}-/);
      expect(href).toBe(`${ORCH_DOCS_URL}/${path}`);
      expect(href).not.toContain("acme");
    }
  });

  it("does not build ADR links from the project repoUrl", () => {
    expect(html).not.toMatch(/\$\{repoUrl\}\/blob/);
  });
});
