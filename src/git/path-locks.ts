import { posix } from "node:path";

/** Lock paths are repository-relative and portable across worker platforms. */
export function normalizeLockPath(path: string): string {
  const value = path.trim().replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[a-z]:/i.test(value) || value.split("/").includes("..")) {
    throw new Error(`locks must be repository-relative paths: ${JSON.stringify(path)}`);
  }
  return posix.normalize(value).replace(/\/$/, "") || ".";
}

type Range = readonly [number, number];
type Edge = { to: number; ranges: Range[] };
type State = { epsilon: number[]; edges: Edge[] };
const ANY: Range[] = [[0, 65535]];
const COMPONENT: Range[] = [[0, 46], [48, 65535]];
const literal = (char: string): Range[] => [[char.charCodeAt(0), char.charCodeAt(0)]];

function characterClass(text: string): Range[] {
  const negated = text.startsWith("!") || text.startsWith("^");
  if (negated) text = text.slice(1);
  const ranges: Range[] = [];
  for (let i = 0; i < text.length; i++) {
    const start = text.charCodeAt(i);
    const end = text[i + 1] === "-" && i + 2 < text.length ? text.charCodeAt(i += 2) : start;
    ranges.push([Math.min(start, end), Math.max(start, end)]);
  }
  if (!negated) return ranges.flatMap(([lo, hi]) => COMPONENT.map(([a, b]) => [Math.max(lo, a), Math.min(hi, b)] as Range).filter(([a, b]) => a <= b));
  let allowed = COMPONENT;
  for (const [lo, hi] of ranges) allowed = allowed.flatMap(([a, b]) => {
    if (hi < a || lo > b) return [[a, b] as Range];
    return [...(a < lo ? [[a, lo - 1] as Range] : []), ...(b > hi ? [[hi + 1, b] as Range] : [])];
  });
  return allowed;
}

function braceVariants(pattern: string): string[] {
  // Innermost alternatives first; cap expansion and conservatively lock all
  // paths for an excessively large expression rather than under-locking it.
  let variants = [pattern];
  for (;;) {
    let changed = false;
    variants = variants.flatMap((value) => {
      const match = /\{([^{}]*,[^{}]*)\}/.exec(value);
      if (!match) return [value];
      changed = true;
      return match[1].split(",").map((part) => value.slice(0, match.index) + part + value.slice(match.index + match[0].length));
    });
    if (variants.length > 256) return ["**"];
    if (!changed) return variants;
  }
}

/** Glob automaton independent of the checkout: claims protect future files too. */
function automaton(pattern: string): State[] {
  const states: State[] = [{ epsilon: [], edges: [] }];
  const add = () => (states.push({ epsilon: [], edges: [] }), states.length - 1);
  let current = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = add();
    if (char === "*") {
      const globstar = pattern[i + 1] === "*";
      if (globstar) i++;
      states[current].epsilon.push(next);
      states[current].edges.push({ to: current, ranges: globstar ? ANY : COMPONENT });
      if (globstar && pattern[i + 1] === "/") {
        // **/ may consume zero directory components.
        states[current].edges.pop();
        states[next].edges.push({ to: next, ranges: ANY });
        const afterSlash = add();
        states[current].epsilon.push(afterSlash);
        states[next].edges.push({ to: afterSlash, ranges: literal("/") });
        current = afterSlash;
        i++;
        continue;
      }
    } else if (char === "[" && pattern.indexOf("]", i + 1) !== -1) {
      const end = pattern.indexOf("]", i + 1);
      states[current].edges.push({ to: next, ranges: characterClass(pattern.slice(i + 1, end)) });
      i = end;
    } else {
      states[current].edges.push({ to: next, ranges: char === "?" ? COMPONENT : literal(char) });
    }
    current = next;
  }
  return states;
}

/** Match a concrete repository path, without treating the filename as a glob or directory. */
export function pathMatchesGlob(pattern: string, path: string): boolean {
  const value = normalizeLockPath(path);
  return braceVariants(normalizeLockPath(pattern)).some((variant) => {
    const states = automaton(variant);
    const closure = (input: Set<number>): Set<number> => {
      const result = new Set(input);
      for (const state of result) for (const next of states[state].epsilon) result.add(next);
      return result;
    };
    let active = closure(new Set([0]));
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      const next = new Set<number>();
      for (const state of active) for (const edge of states[state].edges) {
        if (edge.ranges.some(([lo, hi]) => lo <= code && code <= hi)) next.add(edge.to);
      }
      active = closure(next);
    }
    return active.has(states.length - 1);
  });
}

/** Whether two glob languages intersect (including paths beneath a directory). */
export function lockPathsOverlap(left: string, right: string): boolean {
  const a = normalizeLockPath(left), b = normalizeLockPath(right);
  if (a === "." || b === "." || /[!@+?*]\(/.test(a + b)) return true;
  const intersects = (x: string, y: string): boolean => {
    const xs = automaton(x), ys = automaton(y);
    const queue: [number, number][] = [[0, 0]];
    const seen = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const [u, v] = queue[i];
      const key = `${u}:${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (u === xs.length - 1 && v === ys.length - 1) return true;
      for (const next of xs[u].epsilon) queue.push([next, v]);
      for (const next of ys[v].epsilon) queue.push([u, next]);
      for (const ex of xs[u].edges) for (const ey of ys[v].edges) {
        if (ex.ranges.some(([a, b]) => ey.ranges.some(([c, d]) => Math.max(a, c) <= Math.min(b, d)))) queue.push([ex.to, ey.to]);
      }
    }
    return false;
  };
  return braceVariants(a).some((x) => braceVariants(b).some((y) =>
    intersects(x, y) || intersects(`${x}/**`, y) || intersects(x, `${y}/**`)));
}
