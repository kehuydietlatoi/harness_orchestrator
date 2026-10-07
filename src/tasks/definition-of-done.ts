/**
 * The definition of done (ADR-0010): a ticket's closed, checkable finish line. It exists so that a
 * reviewer can tell "contradicts the spec" from "could always be more complete", and so that the
 * planning session is pushed to give every ticket one. This module is pure and import-free: the
 * plan linter, issue rendering, and the reviewer prompt all share it.
 */

export const DOD_HEADING = "## Definition of done";
export const OUT_OF_SCOPE_HEADING = "## Out of scope";

const DOD_SECTION = /^#{2,3}[ \t]+Definition of done\b/im;

/** Does this issue body carry a definition of done (as rendered by `renderDefinitionOfDone`)? Pure. */
export function hasDefinitionOfDone(body: string): boolean {
  return DOD_SECTION.test(body);
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The issue-body sections for a ticket's acceptance items and out-of-scope list, or "" when it has neither.
 * `sanitize` is applied to each item so prose can never turn into a dependency link. Pure.
 */
export function renderDefinitionOfDone(
  acceptance: readonly string[] | undefined,
  outOfScope: readonly string[] | undefined,
  sanitize: (text: string) => string = (text) => text,
): string {
  const items = (list: readonly string[] | undefined): string[] =>
    (list ?? []).map((item) => sanitize(oneLine(item))).filter((item) => item.length > 0);
  const done = items(acceptance);
  const out = items(outOfScope);
  const parts: string[] = [];
  if (done.length) parts.push([DOD_HEADING, ...done.map((item) => `- [ ] ${item}`)].join("\n"));
  if (out.length) parts.push([OUT_OF_SCOPE_HEADING, ...out.map((item) => `- ${item}`)].join("\n"));
  return parts.join("\n\n");
}

/** Words that make a ticket read as unbounded: there is always one more case to find. */
const OPEN_ENDED = /\b(every|all|complete|comprehensive|canonical|exhaustive|entire|full)\b/i;
/** An acceptance item names a check when it points at something a test or command can verify. */
const CHECK_CUE = /\b(tests?|passes|pass|fails?|throws?|exits?|npm|commands?|output|asserts?|snapshots?|returns?|equals?)\b/i;

/** The first open-ended word in `text`, or null. Pure. */
export function openEndedWord(text: string): string | null {
  return OPEN_ENDED.exec(text)?.[1]?.toLowerCase() ?? null;
}

/** Does this acceptance item name something a test or command can verify? Pure. */
export function namesACheck(item: string): boolean {
  return CHECK_CUE.test(item);
}

/**
 * Advisory warnings for a ticket's finish line (never blocking, so existing plans keep working): no acceptance
 * items at all, or open-ended wording without a single acceptance item that names a check. Pure.
 */
export function definitionOfDoneWarnings(
  index: number,
  ticket: { title: string; body?: string; acceptance?: readonly string[] },
): string[] {
  const acceptance = (ticket.acceptance ?? []).map(oneLine).filter(Boolean);
  const warnings: string[] = [];
  if (acceptance.length === 0) {
    warnings.push(`ticket ${index} has no definition of done: add acceptance items that a test or command can verify`);
  }
  const word = openEndedWord(`${ticket.title}\n${ticket.body ?? ""}`);
  if (word && !acceptance.some(namesACheck)) {
    warnings.push(
      `ticket ${index} reads as open-ended ("${word}"): give it a closed checklist or a machine-checked invariant, ` +
        "and list what is out of scope",
    );
  }
  return warnings;
}
