// Pure, deterministic geometry for the flow graph: orthogonal edge routes through the
// gutters between nodes, label placement, and a checker that defines "readable".
// Imports only the model from flow-graph.ts; no IO, clocks or randomness.
import { NODE_H, NODE_W } from "./flow-graph.js";
import type { FlowEdge, FlowLane, FlowNode } from "./flow-graph.js";

export { NODE_H, NODE_W };

/** Average glyph width of the 10px edge-label font (deliberately conservative). */
export const LABEL_CHAR_W = 6;
export const LABEL_LINE_H = 12;
export const LABEL_PAD = 3;
export const LABEL_MAX_W = 138;

const GRID = 10;
const MIN_NODE_GAP = 24;
const ROUTE_CLEARANCE = 4;
const LABEL_NODE_MARGIN = 2;

export interface Point {
  x: number;
  y: number;
}

/** `x`/`y` are the label box centre. */
export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
}

export interface Route {
  points: Point[];
  label: LabelBox;
}

export interface FlowModel {
  lanes: readonly FlowLane[];
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
}

export interface FlowLayout {
  width: number;
  height: number;
  lanes: { id: string; y: number; height: number }[];
  routes: Record<string, Route>;
}

export type ViolationKind =
  | "node-overlap"
  | "node-outside-lane"
  | "route-through-node"
  | "route-endpoint"
  | "label-on-node"
  | "label-overlap-in-flow"
  | "label-overlap-at-node"
  | "out-of-bounds";

export interface Violation {
  kind: ViolationKind;
  ids: string[];
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const nodeRect = (n: FlowNode): Rect => ({
  left: n.x - NODE_W / 2,
  right: n.x + NODE_W / 2,
  top: n.y - NODE_H / 2,
  bottom: n.y + NODE_H / 2,
});

const labelRect = (l: LabelBox): Rect => ({
  left: l.x - l.w / 2,
  right: l.x + l.w / 2,
  top: l.y - l.h / 2,
  bottom: l.y + l.h / 2,
});

const inflate = (r: Rect, d: number): Rect => ({ left: r.left - d, right: r.right + d, top: r.top - d, bottom: r.bottom + d });

/** Open-interior overlap: touching edges do not count. */
const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** True when the segment has a positive-length part strictly inside the open rectangle. */
function segmentCrossesRect(a: Point, b: Point, r: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!clip(-dx, a.x - r.left) || !clip(dx, r.right - a.x) || !clip(-dy, a.y - r.top) || !clip(dy, r.bottom - a.y)) return false;
  const tm = (t0 + t1) / 2;
  const mx = a.x + dx * tm;
  const my = a.y + dy * tm;
  return mx > r.left && mx < r.right && my > r.top && my < r.bottom;
}

function pointOnBoundary(p: Point, r: Rect): boolean {
  const eps = 0.5;
  const inX = p.x >= r.left - eps && p.x <= r.right + eps;
  const inY = p.y >= r.top - eps && p.y <= r.bottom + eps;
  if (!inX || !inY) return false;
  return (
    Math.abs(p.x - r.left) <= eps || Math.abs(p.x - r.right) <= eps || Math.abs(p.y - r.top) <= eps || Math.abs(p.y - r.bottom) <= eps
  );
}

/** Greedy word wrap; a word longer than the limit keeps its own line. */
export function wrapLabel(text: string): string[] {
  const maxChars = Math.max(1, Math.floor((LABEL_MAX_W - 2 * LABEL_PAD) / LABEL_CHAR_W));
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > maxChars) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function labelSize(lines: string[]): { w: number; h: number } {
  const chars = Math.max(...lines.map((l) => l.length));
  return { w: chars * LABEL_CHAR_W + 2 * LABEL_PAD, h: lines.length * LABEL_LINE_H + 2 * LABEL_PAD };
}

// ---------------------------------------------------------------------------
// Routing: A* over a GRID-pixel lattice with a bend penalty, congestion costs and
// per-node ports. Node boxes are blocked, so a route keeps at least one cell
// (10px) from every node except where it leaves/enters its own endpoints.
// ---------------------------------------------------------------------------

const STEP = 10;
const BEND = 30;
const REUSE = 25;
const CROSS = 12;
const PORT_REUSE = 80;
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

interface Port {
  key: string;
  edge: Point; // on the node boundary
  out: Point; // one cell outside, where the search begins/ends
  dir: number; // outward direction
}

function portsOf(n: FlowNode): Port[] {
  const r = nodeRect(n);
  const ports: Port[] = [];
  const add = (side: string, k: number, edge: Point, dir: number): void =>
    ports.push({ key: `${n.id}:${side}:${k}`, edge, out: { x: edge.x + DX[dir] * GRID, y: edge.y + DY[dir] * GRID }, dir });
  for (const k of [0, -1, 1]) {
    add("e", k, { x: r.right, y: n.y + k * GRID }, 0);
    add("w", k, { x: r.left, y: n.y + k * GRID }, 2);
  }
  for (const k of [-1, 1]) {
    add("s", k, { x: n.x + k * 15, y: r.bottom }, 1);
    add("n", k, { x: n.x + k * 15, y: r.top }, 3);
  }
  return ports;
}

class MinHeap {
  private f: number[] = [];
  private s: number[] = [];
  private v: number[] = [];
  private seq = 0;
  get size(): number {
    return this.f.length;
  }
  push(f: number, v: number): void {
    const i0 = this.f.length;
    this.f.push(f);
    this.s.push(this.seq++);
    this.v.push(v);
    this.up(i0);
  }
  pop(): { f: number; v: number } {
    const top = { f: this.f[0]!, v: this.v[0]! };
    const lf = this.f.pop()!;
    const ls = this.s.pop()!;
    const lv = this.v.pop()!;
    if (this.f.length) {
      this.f[0] = lf;
      this.s[0] = ls;
      this.v[0] = lv;
      this.down(0);
    }
    return top;
  }
  private less(i: number, j: number): boolean {
    return this.f[i]! < this.f[j]! || (this.f[i] === this.f[j] && this.s[i]! < this.s[j]!);
  }
  private swap(i: number, j: number): void {
    [this.f[i], this.f[j]] = [this.f[j]!, this.f[i]!];
    [this.s[i], this.s[j]] = [this.s[j]!, this.s[i]!];
    [this.v[i], this.v[j]] = [this.v[j]!, this.v[i]!];
  }
  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  private down(i: number): void {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.f.length && this.less(l, m)) m = l;
      if (r < this.f.length && this.less(r, m)) m = r;
      if (m === i) return;
      this.swap(i, m);
      i = m;
    }
  }
}

function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
    while (out.length >= 3) {
      const a = out[out.length - 3]!;
      const b = out[out.length - 2]!;
      const c = out[out.length - 1]!;
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(out.length - 2, 1);
      else break;
    }
  }
  return out;
}

class Router {
  readonly cols: number;
  readonly rows: number;
  private blocked: Uint8Array;
  private useH: Uint8Array;
  private useV: Uint8Array;
  private portUse = new Map<string, number>();

  constructor(width: number, height: number, nodes: readonly FlowNode[]) {
    this.cols = Math.floor(width / GRID) + 1;
    this.rows = Math.floor(height / GRID) + 1;
    this.blocked = new Uint8Array(this.cols * this.rows);
    this.useH = new Uint8Array(this.cols * this.rows);
    this.useV = new Uint8Array(this.cols * this.rows);
    for (const n of nodes) {
      const r = nodeRect(n);
      for (let gy = Math.ceil(r.top / GRID); gy <= Math.floor(r.bottom / GRID); gy++) {
        for (let gx = Math.ceil(r.left / GRID); gx <= Math.floor(r.right / GRID); gx++) {
          if (gx >= 0 && gx < this.cols && gy >= 0 && gy < this.rows) this.blocked[gy * this.cols + gx] = 1;
        }
      }
    }
  }

  private inside(gx: number, gy: number): boolean {
    return gx >= 1 && gy >= 1 && gx < this.cols - 1 && gy < this.rows - 1;
  }

  route(from: FlowNode, to: FlowNode): Point[] {
    const starts = portsOf(from);
    const goals = portsOf(to);
    const goalAt = new Map<number, Port[]>();
    for (const g of goals) {
      const gx = g.out.x / GRID;
      const gy = g.out.y / GRID;
      if (!this.inside(gx, gy) || this.blocked[gy * this.cols + gx]) continue;
      const k = gy * this.cols + gx;
      (goalAt.get(k) ?? goalAt.set(k, []).get(k)!).push(g);
    }
    const tr = nodeRect(to);
    const hx0 = tr.left - GRID;
    const hx1 = tr.right + GRID;
    const hy0 = tr.top - GRID;
    const hy1 = tr.bottom + GRID;
    const h = (gx: number, gy: number): number => {
      const x = gx * GRID;
      const y = gy * GRID;
      return (Math.max(0, hx0 - x, x - hx1) + Math.max(0, hy0 - y, y - hy1)) * (STEP / GRID);
    };

    const n = this.cols * this.rows * 4;
    const g = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const startPort = new Map<number, Port>();
    const heap = new MinHeap();
    // Terminal pseudo-states live above the lattice: n + index into `terminals`.
    const terminals: { state: number; port: Port }[] = [];

    for (const p of starts) {
      const gx = p.out.x / GRID;
      const gy = p.out.y / GRID;
      if (!this.inside(gx, gy) || this.blocked[gy * this.cols + gx]) continue;
      const s = (gy * this.cols + gx) * 4 + p.dir;
      const cost = STEP + (this.portUse.get(p.key) ?? 0) * PORT_REUSE;
      if (cost < g[s]!) {
        g[s] = cost;
        startPort.set(s, p);
        heap.push(cost + h(gx, gy), s);
      }
    }

    let found: { state: number; port: Port } | null = null;
    while (heap.size) {
      const { v } = heap.pop();
      if (v >= n) {
        found = terminals[v - n]!;
        break;
      }
      const cell = v >> 2;
      const dir = v & 3;
      const gx = cell % this.cols;
      const gy = (cell - gx) / this.cols;
      const gv = g[v]!;
      const ends = goalAt.get(cell);
      if (ends) {
        for (const port of ends) {
          const inward = (port.dir + 2) % 4;
          const total = gv + STEP + (dir === inward ? 0 : BEND) + (this.portUse.get(port.key) ?? 0) * PORT_REUSE;
          terminals.push({ state: v, port });
          heap.push(total, n + terminals.length - 1);
        }
      }
      for (let nd = 0; nd < 4; nd++) {
        if (nd === (dir + 2) % 4) continue;
        const nx = gx + DX[nd]!;
        const ny = gy + DY[nd]!;
        if (!this.inside(nx, ny)) continue;
        const nc = ny * this.cols + nx;
        if (this.blocked[nc]) continue;
        const horizontal = nd === 0 || nd === 2;
        let cost = gv + STEP + (nd === dir ? 0 : BEND);
        cost += (horizontal ? this.useH[nc]! : this.useV[nc]!) * REUSE;
        cost += (horizontal ? this.useV[nc]! : this.useH[nc]!) * CROSS;
        const ns = nc * 4 + nd;
        if (cost < g[ns]!) {
          g[ns] = cost;
          parent[ns] = v;
          heap.push(cost + h(nx, ny), ns);
        }
      }
    }

    if (!found) {
      const a = starts[0]!;
      const b = goals[0]!;
      return simplify([a.edge, b.edge]);
    }

    const cells: Point[] = [];
    let s = found.state;
    let first = s;
    while (s !== -1) {
      first = s;
      const cell = s >> 2;
      const gx = cell % this.cols;
      cells.push({ x: gx * GRID, y: ((cell - gx) / this.cols) * GRID });
      s = parent[s]!;
    }
    cells.reverse();
    const sp = startPort.get(first)!;
    this.portUse.set(sp.key, (this.portUse.get(sp.key) ?? 0) + 1);
    this.portUse.set(found.port.key, (this.portUse.get(found.port.key) ?? 0) + 1);
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1]!;
      const b = cells[i]!;
      const k = (b.y / GRID) * this.cols + b.x / GRID;
      if (a.y === b.y) this.useH[k] = Math.min(255, this.useH[k]! + 1);
      else this.useV[k] = Math.min(255, this.useV[k]! + 1);
    }
    return simplify([sp.edge, ...cells, found.port.edge]);
  }
}

// ---------------------------------------------------------------------------
// Label placement
// ---------------------------------------------------------------------------

function segmentsOf(points: Point[]): [Point, Point][] {
  const segs: [Point, Point][] = [];
  for (let i = 1; i < points.length; i++) segs.push([points[i - 1]!, points[i]!]);
  return segs;
}

function candidateCenters(points: Point[], w: number, h: number): Point[] {
  const out: Point[] = [];
  const segs = segmentsOf(points);
  for (const [a, b] of segs) {
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const steps = Math.max(2, 2 * Math.round(len / 20));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = a.x + (b.x - a.x) * t;
      const cy = a.y + (b.y - a.y) * t;
      const horizontal = a.y === b.y;
      const offs = horizontal ? [0, -(h / 2 + 6), h / 2 + 6] : [0, -(w / 2 + 6), w / 2 + 6];
      for (const o of offs) out.push(horizontal ? { x: cx, y: cy + o } : { x: cx + o, y: cy });
    }
  }
  return out;
}

function placeLabels(
  model: FlowModel,
  routes: Record<string, Point[]>,
  width: number,
  height: number,
): Record<string, LabelBox> {
  const nodeBoxes = model.nodes.map((n) => inflate(nodeRect(n), LABEL_NODE_MARGIN));
  const placed = new Map<string, Rect>();
  const labels: Record<string, LabelBox> = {};
  const shares = (a: FlowEdge, b: FlowEdge): boolean =>
    a.flows.some((f) => b.flows.includes(f)) || a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;
  const allSegs = model.edges.map((e) => ({ id: e.id, segs: segmentsOf(routes[e.id]!) }));

  for (const e of model.edges) {
    const lines = wrapLabel(e.label);
    const { w, h } = labelSize(lines);
    const pts = routes[e.id]!;
    const conflicting = model.edges.filter((o) => o.id !== e.id && placed.has(o.id) && shares(e, o)).map((o) => placed.get(o.id)!);
    const others = model.edges.filter((o) => o.id !== e.id && placed.has(o.id) && !shares(e, o)).map((o) => placed.get(o.id)!);
    let best: { c: Point; score: number } | null = null;
    const cands = candidateCenters(pts, w, h);
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]!;
      const r: Rect = { left: c.x - w / 2, right: c.x + w / 2, top: c.y - h / 2, bottom: c.y + h / 2 };
      let score = i * 0.01;
      if (r.left < 0 || r.top < 0 || r.right > width || r.bottom > height) score += 1e6;
      for (const nb of nodeBoxes) if (rectsOverlap(r, nb)) score += 1e5;
      const pad = inflate(r, 2);
      for (const cb of conflicting) if (rectsOverlap(pad, cb)) score += 1e5;
      if (best && score >= best.score) continue;
      for (const ob of others) if (rectsOverlap(r, ob)) score += 30;
      for (const other of allSegs) {
        if (other.id === e.id) continue;
        for (const [a, b] of other.segs) if (segmentCrossesRect(a, b, r)) score += 4;
      }
      if (!best || score < best.score) best = { c, score };
    }
    const c = best?.c ?? pts[0]!;
    labels[e.id] = { x: c.x, y: c.y, w, h, lines };
    placed.set(e.id, labelRect(labels[e.id]!));
  }
  return labels;
}

export function layoutFlow(model: FlowModel): FlowLayout {
  const maxX = Math.max(...model.nodes.map((n) => nodeRect(n).right));
  const width = Math.ceil((maxX + 40) / GRID) * GRID;
  const height = Math.ceil(Math.max(...model.lanes.map((l) => l.y + l.height)) / GRID) * GRID + 20;
  const router = new Router(width, height, model.nodes);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const points: Record<string, Point[]> = {};
  for (const e of model.edges) points[e.id] = router.route(byId.get(e.from)!, byId.get(e.to)!);
  const labels = placeLabels(model, points, width, height);
  const routes: Record<string, Route> = {};
  for (const e of model.edges) routes[e.id] = { points: points[e.id]!, label: labels[e.id]! };
  return { width, height, lanes: model.lanes.map((l) => ({ id: l.id, y: l.y, height: l.height })), routes };
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export function layoutViolations(model: FlowModel, layout: FlowLayout): Violation[] {
  const out: Violation[] = [];
  const add = (kind: ViolationKind, ...ids: string[]): void => {
    out.push({ kind, ids });
  };
  const nodes = model.nodes;
  const rects = new Map(nodes.map((n) => [n.id, nodeRect(n)]));
  const bounds: Rect = { left: 0, top: 0, right: layout.width, bottom: layout.height };
  const within = (r: Rect): boolean => r.left >= bounds.left && r.top >= bounds.top && r.right <= bounds.right && r.bottom <= bounds.bottom;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (rectsOverlap(inflate(rects.get(nodes[i]!.id)!, MIN_NODE_GAP / 2), inflate(rects.get(nodes[j]!.id)!, MIN_NODE_GAP / 2))) {
        add("node-overlap", nodes[i]!.id, nodes[j]!.id);
      }
    }
  }
  const laneById = new Map(layout.lanes.map((l) => [l.id, l]));
  for (const n of nodes) {
    const r = rects.get(n.id)!;
    const lane = laneById.get(n.lane);
    if (!lane || r.top < lane.y || r.bottom > lane.y + lane.height) add("node-outside-lane", n.id);
    if (!within(r)) add("out-of-bounds", n.id);
  }

  for (const e of model.edges) {
    const route = layout.routes[e.id];
    if (!route) {
      add("route-endpoint", e.id);
      continue;
    }
    const pts = route.points;
    const from = rects.get(e.from);
    const to = rects.get(e.to);
    if (pts.length < 2 || !from || !to || !pointOnBoundary(pts[0]!, from) || !pointOnBoundary(pts[pts.length - 1]!, to)) {
      add("route-endpoint", e.id);
    }
    for (const n of nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      const box = inflate(rects.get(n.id)!, ROUTE_CLEARANCE);
      if (segmentsOf(pts).some(([a, b]) => segmentCrossesRect(a, b, box))) add("route-through-node", e.id, n.id);
    }
    const lr = labelRect(route.label);
    for (const n of nodes) if (rectsOverlap(lr, rects.get(n.id)!)) add("label-on-node", e.id, n.id);
    if (!within(lr) || pts.some((p) => p.x < 0 || p.y < 0 || p.x > layout.width || p.y > layout.height)) add("out-of-bounds", e.id);
  }

  const edges = model.edges.filter((e) => layout.routes[e.id]);
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!;
      const b = edges[j]!;
      if (!rectsOverlap(labelRect(layout.routes[a.id]!.label), labelRect(layout.routes[b.id]!.label))) continue;
      if (a.flows.some((f) => b.flows.includes(f))) add("label-overlap-in-flow", a.id, b.id);
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) add("label-overlap-at-node", a.id, b.id);
    }
  }
  return out;
}
