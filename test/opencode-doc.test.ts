import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps OpenCode spec repository links and spike fixture references valid", () => {
  const doc = new URL("../docs/opencode-adapter.md", import.meta.url);
  const text = readFileSync(doc, "utf8");
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)]
    .map(match => match[1]).filter(link => !link.startsWith("#") && !/^https?:/.test(link));
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(existsSync(new URL(link, doc)), link).toBe(true);
  }
  const fixtures = [...text.matchAll(/`([\w-]+\.(?:jsonl|stderr\.txt))`/g)].map(match => match[1]);
  expect(fixtures.length).toBeGreaterThan(0);
  for (const file of fixtures) {
    expect(existsSync(new URL(`./fixtures/opencode-1.19.3/${file}`, import.meta.url)), file).toBe(true);
  }
});
