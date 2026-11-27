import type { Plan, Task } from "./model";

/** The schedule as an ordered tree of phases and activities. The WBS codes
 * and phase names of the plan are derived from this order, so moving,
 * grouping or inserting rows only has to rebuild the tree. */
export type Node =
  | { kind: "phase"; code: string; name: string; children: Node[] }
  | { kind: "task"; id: number };

export type Row =
  | { kind: "phase"; code: string; name: string; depth: number; size: number }
  | { kind: "task"; id: number; depth: number };

export function compareCodes(a: string, b: string) {
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

export function buildTree(plan: Plan): Node[] {
  const root: { key: string; node: Node }[] = [];
  const phases = new Map<string, Extract<Node, { kind: "phase" }>>();
  const tasks = [...plan.tasks].sort((a, b) => compareCodes(a.wbs, b.wbs));
  for (const t of tasks) {
    const parts = t.wbs.split(".");
    let list: Node[] | null = null;
    for (let i = 1; i < parts.length; i++) {
      const code = parts.slice(0, i).join(".");
      let phase = phases.get(code);
      if (!phase) {
        phase = {
          kind: "phase",
          code,
          name: plan.groups[code] ?? `Fase ${code}`,
          children: [],
        };
        phases.set(code, phase);
        if (list) list.push(phase);
        else root.push({ key: code, node: phase });
      }
      list = phase.children;
    }
    if (list) list.push({ kind: "task", id: t.id });
    else root.push({ key: t.wbs, node: { kind: "task", id: t.id } });
  }
  // Phases created before their first activity.
  for (const [code, name] of Object.entries(plan.groups))
    if (!code.includes(".") && !phases.has(code))
      root.push({
        key: code,
        node: { kind: "phase", code, name, children: [] },
      });
  return root
    .sort((a, b) => compareCodes(a.key, b.key))
    .map((entry) => entry.node);
}

/** Rewrite WBS codes and phase names from the tree order. Returns the plan
 * and the new code of every phase (to keep folded phases folded). */
export function renumber(tree: Node[], plan: Plan) {
  const wbs = new Map<number, string>();
  const groups: Record<string, string> = {};
  const codes = new Map<string, string>();
  const walk = (nodes: Node[], prefix: string) =>
    nodes.forEach((n, i) => {
      const code = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      if (n.kind === "phase") {
        groups[code] = n.name;
        codes.set(n.code, code);
        walk(n.children, code);
      } else wbs.set(n.id, code);
    });
  walk(tree, "");
  return {
    plan: {
      ...plan,
      groups,
      tasks: plan.tasks.map((t) => ({ ...t, wbs: wbs.get(t.id) ?? t.wbs })),
    },
    codes,
  };
}

export function rows(tree: Node[], folded: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (nodes: Node[], depth: number) => {
    for (const n of nodes) {
      if (n.kind === "phase") {
        out.push({
          kind: "phase",
          code: n.code,
          name: n.name,
          depth,
          size: n.children.length,
        });
        if (!folded.has(n.code)) walk(n.children, depth + 1);
      } else out.push({ kind: "task", id: n.id, depth });
    }
  };
  walk(tree, 0);
  return out;
}

/** The list that holds a node, and its position in it. */
function locate(
  tree: Node[],
  match: (n: Node) => boolean,
): { list: Node[]; index: number } | null {
  for (let i = 0; i < tree.length; i++) {
    const n = tree[i];
    if (match(n)) return { list: tree, index: i };
    if (n.kind === "phase") {
      const found = locate(n.children, match);
      if (found) return found;
    }
  }
  return null;
}

const clone = (tree: Node[]): Node[] => structuredClone(tree);
const isTask = (id: number) => (n: Node) => n.kind === "task" && n.id === id;
const isPhase = (code: string) => (n: Node) =>
  n.kind === "phase" && n.code === code;

/** Insert activities after an activity, at the end of a phase or at the end. */
export function insert(
  tree: Node[],
  ids: number[],
  at: { after: number } | { phase: string } | null,
): Node[] {
  const next = clone(tree);
  const nodes: Node[] = ids.map((id) => ({ kind: "task", id }));
  const spot =
    at && "after" in at
      ? locate(next, isTask(at.after))
      : at && "phase" in at
        ? (() => {
            const found = locate(next, isPhase(at.phase));
            if (!found) return null;
            const phase = found.list[found.index] as Extract<
              Node,
              { kind: "phase" }
            >;
            return { list: phase.children, index: phase.children.length - 1 };
          })()
        : null;
  if (spot) spot.list.splice(spot.index + 1, 0, ...nodes);
  else next.push(...nodes);
  return next;
}

export function remove(tree: Node[], ids: number[]): Node[] {
  const drop = new Set(ids);
  const walk = (nodes: Node[]): Node[] =>
    nodes
      .filter((n) => !(n.kind === "task" && drop.has(n.id)))
      .map((n) =>
        n.kind === "phase" ? { ...n, children: walk(n.children) } : n,
      );
  return walk(tree);
}

/** Move the selected activities into a new phase placed where the first
 * of them was. */
export function group(
  tree: Node[],
  ids: number[],
  name: string,
  order: number[],
): Node[] {
  if (!ids.length) return tree;
  const chosen = order.filter((id) => ids.includes(id));
  const next = clone(tree);
  const first = locate(next, isTask(chosen[0]))!;
  const marker: Node = { kind: "phase", code: "\u0000new", name, children: [] };
  first.list.splice(first.index, 0, marker);
  const without = remove(next, chosen);
  const phase = locate(without, isPhase("\u0000new"))!;
  (phase.list[phase.index] as Extract<Node, { kind: "phase" }>).children =
    chosen.map((id) => ({ kind: "task", id }));
  return without;
}

/** Replace a phase by its contents. */
export function ungroup(tree: Node[], code: string): Node[] {
  const next = clone(tree);
  const found = locate(next, isPhase(code));
  if (!found) return tree;
  const phase = found.list[found.index] as Extract<Node, { kind: "phase" }>;
  found.list.splice(found.index, 1, ...phase.children);
  return next;
}

export function renamePhase(tree: Node[], code: string, name: string): Node[] {
  const next = clone(tree);
  const found = locate(next, isPhase(code));
  if (found)
    (found.list[found.index] as Extract<Node, { kind: "phase" }>).name = name;
  return next;
}

export function move(tree: Node[], id: number, step: -1 | 1): Node[] {
  const next = clone(tree);
  const found = locate(next, isTask(id));
  if (!found) return tree;
  const to = found.index + step;
  if (to < 0 || to >= found.list.length) return tree;
  const [node] = found.list.splice(found.index, 1);
  found.list.splice(to, 0, node);
  return next;
}

/** Link each selected activity to the previous one (finish to start), in
 * the order shown. Existing links between them are kept. */
export function chain(tasks: Task[], ids: number[], order: number[]): Task[] {
  const chosen = order.filter((id) => ids.includes(id));
  const previous = new Map(chosen.slice(1).map((id, i) => [id, chosen[i]]));
  return tasks.map((t) => {
    const before = previous.get(t.id);
    if (before === undefined || t.links.some((l) => l.predecessor === before))
      return t;
    return {
      ...t,
      links: [...t.links, { predecessor: before, relation: "FS", lag: 0 }],
    };
  });
}

/** Rows copied from Excel: name, and optionally the duration in days.
 * A header row («Actividad», «Duración»…) is skipped. */
export function parsePaste(text: string): { name: string; duration: number }[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.split("\t").map((cell) => cell.trim()))
    .filter((cells) => cells.some(Boolean));
  const out: { name: string; duration: number }[] = [];
  lines.forEach((cells, i) => {
    const name = cells[0] ?? "";
    const raw = (cells[1] ?? "").replace(",", ".");
    const number = raw.match(/^-?\d+(?:\.\d+)?/);
    if (
      i === 0 &&
      !number &&
      /actividad|nombre|tarea|duraci/i.test(cells.join(" "))
    )
      return;
    if (!name) return;
    const duration = number ? Math.max(0, Math.round(Number(number[0]))) : 1;
    out.push({ name: name.slice(0, 160), duration: Math.min(duration, 3650) });
  });
  return out;
}
