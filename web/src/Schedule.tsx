import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Diamond,
  Download,
  Flag,
  FolderPlus,
  Link2,
  Maximize2,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  cleanError,
  fmt,
  type ErrorInfo,
  type Mutation,
  type Phase,
  type Plan,
  type Scheduled,
  type State,
  type Task,
  type WorkCalendar,
} from "./model";
import { Modal } from "./shared";
import { availableMeasures, unitLabel } from "./measurements";
import {
  buildTree,
  chain,
  group,
  insert,
  move,
  parsePaste,
  remove,
  renamePhase,
  renumber,
  rows as outlineRows,
  ungroup,
  type Node,
} from "./outline";

const RELATIONS: Record<
  string,
  { short: string; label: string; sentence: string }
> = {
  FS: {
    short: "FC",
    label: "Fin a comienzo (FC)",
    sentence: "Empieza cuando termine",
  },
  SS: {
    short: "CC",
    label: "Comienzo a comienzo (CC)",
    sentence: "Empieza cuando empiece",
  },
  FF: {
    short: "FF",
    label: "Fin a fin (FF)",
    sentence: "Termina cuando termine",
  },
  SF: {
    short: "CF",
    label: "Comienzo a fin (CF)",
    sentence: "Termina cuando empiece",
  },
};
const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const ROW = 38;
const HEAD = 46;
const SCALES = { day: 30, week: 11, month: 3.2 } as const;
type Scale = keyof typeof SCALES | "fit";
type Timeline = { schedule: Scheduled[]; phases: Phase[] };
type Active = { kind: "task"; id: number } | { kind: "phase"; code: string };
type Problem = { message: string; info?: ErrorInfo };

const DAY = 86400000;
const toDay = (s: string) => Math.round(Date.parse(s + "T00:00:00Z") / DAY);
const fromDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const label = (s: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", ...options }).format(
    new Date(s + "T00:00:00Z"),
  );
const shortDate = (s: string) =>
  label(s, { weekday: "short", day: "numeric", month: "short" });
const cellDate = (s: string) =>
  `${Number(s.slice(8, 10))} ${label(s, { month: "short" }).replace(".", "")}`;
const longDate = (s: string) =>
  label(s, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const days = (n: number) => `${n} ${Math.abs(n) === 1 ? "día" : "días"}`;
const today = () => new Date().toISOString().slice(0, 10);
const variance = (n: number) =>
  n
    ? `${n > 0 ? "atraso" : "adelanto"} de ${days(Math.abs(n))}`
    : "sin cambios";

/** Only named activities reach the server; links to unnamed rows drop. */
function cleaned(plan: Plan): Plan {
  const kept = plan.tasks.filter((t) => t.name.trim());
  const ids = new Set(kept.map((t) => t.id));
  return {
    ...plan,
    tasks: kept.map((t) => ({
      ...t,
      name: t.name.trim(),
      links: t.links.filter((l) => ids.has(l.predecessor)),
    })),
  };
}

function order(tree: Node[]): number[] {
  const out: number[] = [];
  const walk = (nodes: Node[]) =>
    nodes.forEach((n) =>
      n.kind === "task" ? out.push(n.id) : walk(n.children),
    );
  walk(tree);
  return out;
}

/** Plain-language reasons for an activity's dates. */
function explain(row: Scheduled, names: Map<number, string>, plan: Plan) {
  const lines: string[] = [];
  const d = row.driver;
  if (!d || d.type === "start")
    lines.push(`Empieza con el proyecto, el ${longDate(plan.start)}.`);
  else if (d.type === "earliest")
    lines.push(`Restricción: no puede comenzar antes del ${longDate(d.date)}.`);
  else if (d.type === "fixed_finish")
    lines.push(`Restricción: debe finalizar el ${longDate(d.date)}.`);
  else {
    const r = RELATIONS[d.relation];
    const wait =
      d.lag > 0
        ? `, más ${days(d.lag)} laborables de espera`
        : d.lag < 0
          ? `, con ${days(-d.lag)} laborables de adelanto`
          : "";
    lines.push(
      `${r.sentence} «${names.get(d.predecessor) ?? "?"}» (${r.short})${wait}.`,
    );
  }
  const describe = (list: { date: string; kind: string }[]) =>
    list
      .map(
        (n) =>
          `${label(n.date, { weekday: "long", day: "numeric", month: "short" })} ${
            n.kind === "festivo" ? "es festivo" : "no es laborable"
          }`,
      )
      .join("; ");
  if (row.shifted?.length)
    lines.push(
      `Por eso pasó al ${longDate(row.start)}: ${describe(row.shifted)}.`,
    );
  if (row.spanned?.length)
    lines.push(
      `Dura ${days(row.duration)} laborables y ocupa ${days(
        toDay(row.finish) - toDay(row.start) + 1,
      )} de calendario porque ${describe(row.spanned)}.`,
    );
  if (row.calendar)
    lines.push(
      `Usa el calendario «${row.calendar}» en lugar del del proyecto.`,
    );
  return lines;
}

export function Schedule({
  state,
  mutate,
}: {
  state: State;
  mutate: Mutation;
}) {
  const pid = state.project.id;
  const storeKey = `civil-plan-draft:${pid}`;
  // An unsaved draft survives a module change or a reload in this tab.
  const stored = useMemo(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storeKey) ?? "null") as {
        revision: number;
        plan: Plan;
        base?: string;
      } | null;
    } catch {
      return null;
    }
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The draft still applies if nothing changed, or if only other parts of
  // the project changed since (the saved schedule is the one it started from).
  const restored =
    stored &&
    (stored.revision === state.project.revision ||
      stored.base === JSON.stringify(state.plan))
      ? stored.plan
      : null;
  // A draft from before another change in the project: offer to recover it.
  const [stale, setStale] = useState<Plan | null>(
    stored && !restored ? stored.plan : null,
  );
  const [draft, setDraftState] = useState<Plan>(restored ?? state.plan);
  const [dirty, setDirty] = useState(!!restored);
  const [timeline, setTimeline] = useState<Timeline>({
    schedule: state.schedule,
    phases: state.phases ?? [],
  });
  const [problem, setProblem] = useState<Problem | null>(null);
  // Whether the timeline shown was computed for the current draft.
  const [fresh, setFresh] = useState(!restored);
  const latest = useRef<Plan>(restored ?? state.plan);
  const [durations, setDurations] = useState<Record<number, string>>({});
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [scale, setScale] = useState<Scale>("week");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [phaseName, setPhaseName] = useState<string | null>(null);
  const focusNext = useRef<{ id: number; field: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);

  function setDraft(plan: Plan) {
    latest.current = plan;
    setDraftState(plan);
    setDirty(true);
    setFresh(false);
    setNotice("");
    try {
      sessionStorage.setItem(
        storeKey,
        JSON.stringify({
          revision: state.project.revision,
          plan,
          base: JSON.stringify(state.plan),
        }),
      );
    } catch {
      // Keeping the draft across reloads is only a convenience.
    }
  }

  // Saved elsewhere (or just saved here): show the stored plan.
  useEffect(() => {
    if (dirty) return;
    latest.current = state.plan;
    setDraftState(state.plan);
    setTimeline({ schedule: state.schedule, phases: state.phases ?? [] });
    setFresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.project.revision]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const saved = useMemo(
    () => new Set(state.plan.tasks.map((t) => t.id)),
    [state.plan.tasks],
  );
  // Durations typed but not valid yet stay in the cell and block the preview.
  const localErrors = useMemo(() => {
    const errors: Record<number, Record<string, string>> = {};
    const present = new Set(draft.tasks.map((t) => t.id));
    // Saved activities keep their name: clearing it is an error, not a delete.
    for (const t of draft.tasks)
      if (saved.has(t.id) && !t.name.trim())
        errors[t.id] = { name: "Escribe un nombre o elimina la actividad." };
    for (const [id, raw] of Object.entries(durations))
      if (!present.has(+id)) continue;
      else if (!/^\d{1,4}$/.test(raw.trim()) || Number(raw) > 3650)
        errors[+id] = {
          duration: "Escribe días laborables enteros (0 para un hito).",
        };
    return errors;
  }, [durations, draft.tasks, saved]);

  // Live recalculation of the draft on the server, without saving it.
  useEffect(() => {
    if (!dirty || Object.keys(localErrors).length) return;
    let live = true;
    const id = window.setTimeout(async () => {
      try {
        const result = await api<Timeline>(`/projects/${pid}/plan/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cleaned(draft)),
        });
        if (live) {
          setTimeline(result);
          setProblem(null);
          setFresh(true);
        }
      } catch (e) {
        if (live)
          setProblem({
            message: cleanError(e),
            info: (e as Error & { info?: ErrorInfo }).info,
          });
      }
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [draft, dirty, localErrors, pid]);

  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    document.getElementById(`cell-${target.id}-${target.field}`)?.focus();
  });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tree = useMemo(() => buildTree(draft), [draft]);
  const visible = useMemo(() => outlineRows(tree, folded), [tree, folded]);
  const sequence = useMemo(() => order(tree), [tree]);
  const tasks = useMemo(
    () => new Map(draft.tasks.map((t) => [t.id, t])),
    [draft.tasks],
  );
  const computed = useMemo(
    () => new Map(timeline.schedule.map((r) => [r.id, r])),
    [timeline],
  );
  const phaseRows = useMemo(
    () => new Map(timeline.phases.map((p) => [p.code, p])),
    [timeline],
  );
  const names = useMemo(
    () => new Map(draft.tasks.map((t) => [t.id, t.name || "Sin nombre"])),
    [draft.tasks],
  );

  function restructure(next: Node[], change?: (plan: Plan) => Plan) {
    const { plan, codes } = renumber(next, change ? change(draft) : draft);
    setFolded(
      (f) =>
        new Set([...f].map((c) => codes.get(c)).filter(Boolean) as string[]),
    );
    if (active?.kind === "phase" && codes.get(active.code))
      setActive({ kind: "phase", code: codes.get(active.code)! });
    setDraft(plan);
  }

  // New ids never reuse one still present in the baseline.
  const nextId = () =>
    Math.max(
      0,
      ...draft.tasks.map((t) => t.id),
      ...Object.keys(draft.baseline ?? {}).map(Number),
    );

  function patchTask(id: number, change: Partial<Task>) {
    setDraft({
      ...draft,
      tasks: draft.tasks.map((t) => (t.id === id ? { ...t, ...change } : t)),
    });
  }

  function addTasks(
    items: { name: string; duration: number }[],
    at: { after: number } | { phase: string } | null,
    focus = true,
  ) {
    let id = nextId();
    const created: Task[] = items.map((item) => ({
      id: ++id,
      name: item.name,
      wbs: "1",
      duration: item.duration,
      earliest: null,
      fixed_finish: null,
      progress: 0,
      links: [],
      quantity: null,
      calendar: "",
    }));
    restructure(
      insert(
        tree,
        created.map((t) => t.id),
        at,
      ),
      (p) => ({ ...p, tasks: [...p.tasks, ...created] }),
    );
    if (focus && created.length)
      focusNext.current = { id: created[0].id, field: "name" };
    return created;
  }

  function addLink(to: number, from: number) {
    const t = tasks.get(to)!;
    if (t.links.some((l) => l.predecessor === from)) return;
    patchTask(to, {
      links: [...t.links, { predecessor: from, relation: "FS", lag: 0 }],
    });
  }

  function removeTasks(ids: number[]) {
    const drop = new Set(ids);
    setDurations((raw) =>
      Object.fromEntries(Object.entries(raw).filter(([id]) => !drop.has(+id))),
    );
    restructure(remove(tree, ids), (p) => ({
      ...p,
      baseline: Object.fromEntries(
        Object.entries(p.baseline ?? {}).filter(([id]) => !drop.has(+id)),
      ),
      tasks: p.tasks
        .filter((t) => !drop.has(t.id))
        .map((t) => ({
          ...t,
          links: t.links.filter((l) => !drop.has(l.predecessor)),
        })),
    }));
    setSelected(new Set());
    if (active?.kind === "task" && drop.has(active.id)) setActive(null);
  }

  function onPaste(e: ClipboardEvent) {
    const text = e.clipboardData.getData("text/plain");
    if (!/[\n\t]/.test(text.trim())) return; // a single value: normal paste
    const items = parsePaste(text);
    if (!items.length) return;
    e.preventDefault();
    const focused = Number(
      (document.activeElement as HTMLElement | null)?.dataset.task,
    );
    const current = tasks.get(focused);
    if (current && !current.name.trim()) {
      // Fill the empty row first, then add the rest after it.
      const [first, ...rest] = items;
      const filled = {
        ...draft,
        tasks: draft.tasks.map((t) =>
          t.id === focused
            ? { ...t, name: first.name, duration: first.duration }
            : t,
        ),
      };
      let id = nextId();
      const created: Task[] = rest.map((item) => ({
        id: ++id,
        name: item.name,
        wbs: "1",
        duration: item.duration,
        earliest: null,
        fixed_finish: null,
        progress: 0,
        links: [],
        quantity: null,
        calendar: "",
      }));
      const { plan, codes } = renumber(
        insert(
          tree,
          created.map((t) => t.id),
          { after: focused },
        ),
        { ...filled, tasks: [...filled.tasks, ...created] },
      );
      setFolded(
        (f) =>
          new Set([...f].map((c) => codes.get(c)).filter(Boolean) as string[]),
      );
      setDraft(plan);
    } else addTasks(items, current ? { after: focused } : null, false);
    setNotice(
      `Se pegaron ${items.length} ${items.length === 1 ? "actividad" : "actividades"}.`,
    );
  }

  function onCellKey(e: KeyboardEvent<HTMLInputElement>, id: number) {
    const field = e.currentTarget.dataset.field!;
    const taskRows = visible.filter((r) => r.kind === "task") as {
      id: number;
    }[];
    const here = taskRows.findIndex((r) => r.id === id);
    if (e.key === "Enter") {
      e.preventDefault();
      if (!tasks.get(id)?.name.trim()) return;
      const next = taskRows[here + 1];
      if (next && !tasks.get(next.id)?.name.trim())
        focusNext.current = { id: next.id, field: "name" };
      else addTasks([{ name: "", duration: 1 }], { after: id });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = taskRows[here + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        document.getElementById(`cell-${next.id}-${field}`)?.focus();
      }
    }
  }

  function toggleSelect(id: number, range: boolean) {
    const next = new Set(selected);
    if (range && anchor !== null) {
      const a = sequence.indexOf(anchor),
        b = sequence.indexOf(id);
      for (const i of sequence.slice(Math.min(a, b), Math.max(a, b) + 1))
        next.add(i);
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    setAnchor(id);
  }

  async function save() {
    setSaving(true);
    setNotice("");
    const sent = draft;
    try {
      await mutate("/plan", cleaned(sent), "PUT");
      // Editing is locked while saving; this guards any change that slips in.
      if (latest.current !== sent) return;
      try {
        sessionStorage.removeItem(storeKey);
      } catch {
        // Nothing to clean.
      }
      setDirty(false);
      setDurations({});
      setNotice("Cronograma guardado.");
    } catch (e) {
      setProblem({
        message: cleanError(e),
        info: (e as Error & { info?: ErrorInfo }).info,
      });
    } finally {
      setSaving(false);
    }
  }

  function setBaseline(clear: boolean) {
    setDraft({
      ...draft,
      baseline: clear
        ? {}
        : Object.fromEntries(
            timeline.schedule.map((r) => [
              r.id,
              {
                start: r.start,
                finish: r.finish,
                duration: r.duration,
                at_day_end: !!r.at_day_end,
              },
            ]),
          ),
      baseline_saved: clear ? null : today(),
    });
  }

  // Errors per cell: the server's (one activity and field, or a cycle)
  // plus durations that are not valid numbers yet.
  const cellError = (id: number, field: string) => {
    if (localErrors[id]?.[field]) return localErrors[id][field];
    const info = problem?.info;
    if (!info) return "";
    if (field === "links" && info.cycle.includes(id)) return problem!.message;
    if (info.task !== id) return "";
    const where =
      info.field === "wbs" || info.field === "id"
        ? "name"
        : info.field === "duration"
          ? "duration"
          : info.field === "links"
            ? "links"
            : "row";
    return where === field ? problem!.message : "";
  };

  // ----- Gantt geometry -----
  const starts = [
    draft.start,
    ...timeline.schedule.map((r) => r.start),
    ...timeline.schedule.flatMap((r) => (r.baseline ? [r.baseline.start] : [])),
  ];
  const ends = [
    ...timeline.schedule.map((r) => r.finish),
    ...timeline.schedule.flatMap((r) =>
      r.baseline ? [r.baseline.finish] : [],
    ),
    ...(draft.status_date ? [draft.status_date] : []),
  ];
  const origin = Math.min(...starts.map(toDay)) - 2;
  const last = Math.max(origin + 28, ...ends.map(toDay)) + 4;
  const span = last - origin + 1;
  const tableWidth =
    width < 760 ? Math.max(320, width - 40) : width < 1250 ? 580 : 640;
  const px =
    scale === "fit"
      ? Math.max(0.05, (width - tableWidth - 4) / span)
      : SCALES[scale];
  const timelineWidth = Math.ceil(span * px);
  const x = (date: string, end = false) =>
    (toDay(date) - origin + (end ? 1 : 0)) * px;

  const ticks = useMemo(() => {
    const top: { left: number; text: string }[] = [];
    const bottom: { left: number; text: string; off?: boolean }[] = [];
    const project = new Set(draft.weekdays);
    const holidays = new Set(draft.holidays);
    for (let d = origin; d <= last; d++) {
      const iso = fromDay(d);
      const dt = new Date(d * DAY);
      const left = (d - origin) * px;
      const first = dt.getUTCDate() === 1 || d === origin;
      if (scale === "month" || px < 4) {
        if ((dt.getUTCMonth() === 0 && dt.getUTCDate() === 1) || d === origin)
          top.push({ left, text: String(dt.getUTCFullYear()) });
        // Fewer month labels when months are narrow.
        const month = dt.getUTCMonth();
        const every = 30 * px >= 26 ? 1 : 90 * px >= 26 ? 3 : 0;
        if (first && every && month % every === 0)
          bottom.push({ left, text: label(iso, { month: "short" }) });
      } else {
        // The partial month at the left edge is labelled only if it is wide.
        if (dt.getUTCDate() === 1 || (d === origin && dt.getUTCDate() <= 20))
          top.push({
            left,
            text: label(iso, {
              month: px >= 20 ? "long" : "short",
              year: "numeric",
            }),
          });
        const weekday = (dt.getUTCDay() + 6) % 7;
        if (scale === "day")
          bottom.push({
            left,
            text: `${WEEKDAYS[weekday][0]} ${dt.getUTCDate()}`,
            off: !project.has(weekday) || holidays.has(iso),
          });
        else if (weekday === 0)
          bottom.push({ left, text: String(dt.getUTCDate()) });
      }
    }
    return { top, bottom };
  }, [origin, last, px, scale, draft.weekdays, draft.holidays]);

  const nonWorking = useMemo(() => {
    if (px < 5) return [];
    const out: number[] = [];
    const project = new Set(draft.weekdays);
    const holidays = new Set(draft.holidays);
    for (let d = origin; d <= last; d++) {
      const weekday = (new Date(d * DAY).getUTCDay() + 6) % 7;
      if (!project.has(weekday) || holidays.has(fromDay(d))) out.push(d);
    }
    return out;
  }, [origin, last, px, draft.weekdays, draft.holidays]);

  const rowIndex = new Map<number, number>();
  visible.forEach((r, i) => r.kind === "task" && rowIndex.set(r.id, i));
  const arrows: { d: string; critical: boolean; key: string }[] = [];
  for (const t of draft.tasks) {
    const to = computed.get(t.id);
    const yTo = rowIndex.get(t.id);
    if (!to || yTo === undefined) continue;
    for (const link of t.links) {
      const from = computed.get(link.predecessor);
      const yFrom = rowIndex.get(link.predecessor);
      if (!from || yFrom === undefined) continue;
      const edge = (r: Scheduled, finish: boolean) =>
        r.milestone
          ? x(r.start, !!r.at_day_end)
          : finish
            ? x(r.finish, true)
            : x(r.start);
      const x1 = edge(from, link.relation === "FS" || link.relation === "FF");
      const x2 = edge(to, link.relation === "FF" || link.relation === "SF");
      const y1 = yFrom * ROW + ROW / 2,
        y2 = yTo * ROW + ROW / 2;
      const toEnd = link.relation === "FF" || link.relation === "SF";
      const d =
        !toEnd && x2 >= x1 + 10
          ? `M${x1} ${y1} H${x1 + 6} V${y2} H${x2 - 1}`
          : `M${x1} ${y1} H${x1 + 6} V${y2 + (y2 > y1 ? -ROW / 2 + 4 : ROW / 2 - 4)} H${
              toEnd ? x2 + 10 : x2 - 10
            } V${y2} H${toEnd ? x2 + 1 : x2 - 1}`;
      // Critical only when this link is the one driving the successor.
      const driving =
        to.driver?.type === "link" &&
        to.driver.predecessor === link.predecessor;
      arrows.push({
        d,
        critical: !!(from.critical && to.critical && driving),
        key: `${link.predecessor}-${t.id}`,
      });
    }
  }

  const fitScroll = () => {
    setScale("fit");
    scroller.current?.scrollTo({ left: 0 });
  };
  const activeTask = active?.kind === "task" ? tasks.get(active.id) : undefined;
  const activePhase =
    active?.kind === "phase" ? phaseRows.get(active.code) : undefined;
  const chosen = sequence.filter((id) => selected.has(id));
  const pickList = draft.tasks
    .filter((t) => t.name.trim())
    .map((t) => ({ id: t.id, text: `${t.wbs} · ${t.name}` }));
  const baselineSet = Object.keys(draft.baseline ?? {}).length > 0;

  return (
    <section className="panel planner">
      <div className="planner-top">
        <label className="planner-start">
          Inicio del proyecto
          <input
            type="date"
            disabled={saving}
            value={draft.start}
            onChange={(e) =>
              e.target.value && setDraft({ ...draft, start: e.target.value })
            }
          />
        </label>
        <button disabled={saving} onClick={() => setCalendarOpen(true)}>
          <CalendarDays size={15} /> Calendario y seguimiento
        </button>
        <div className="planner-save">
          {dirty && <span className="unsaved">Cambios sin guardar</span>}
          {notice && (
            <span className="saved" role="status">
              {notice}
            </span>
          )}
          <button
            className="primary"
            disabled={
              !dirty || saving || !!problem || !!Object.keys(localErrors).length
            }
            onClick={save}
          >
            <Save size={15} /> {saving ? "Guardando…" : "Guardar cronograma"}
          </button>
        </div>
      </div>

      <div
        className="planner-toolbar"
        role="toolbar"
        aria-label="Edición del cronograma"
        inert={saving}
      >
        <button
          onClick={() =>
            addTasks(
              [{ name: "", duration: 1 }],
              active?.kind === "task"
                ? { after: active.id }
                : active?.kind === "phase"
                  ? { phase: active.code }
                  : null,
            )
          }
        >
          <Plus size={15} /> Actividad
        </button>
        <button
          onClick={() =>
            addTasks(
              [{ name: "Entrega", duration: 0 }],
              active?.kind === "task" ? { after: active.id } : null,
            )
          }
        >
          <Diamond size={15} /> Hito
        </button>
        <span className="planner-divider" />
        <button
          disabled={chosen.length < 2}
          onClick={() => {
            setDraft({ ...draft, tasks: chain(draft.tasks, chosen, sequence) });
            setNotice(`Se encadenaron ${chosen.length} actividades en orden.`);
          }}
        >
          <Link2 size={15} /> Encadenar
        </button>
        {phaseName === null ? (
          <button disabled={!chosen.length} onClick={() => setPhaseName("")}>
            <FolderPlus size={15} /> Agrupar en fase
          </button>
        ) : (
          <form
            className="phase-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!phaseName.trim()) return;
              restructure(group(tree, chosen, phaseName.trim(), sequence));
              setSelected(new Set());
              setPhaseName(null);
            }}
          >
            <input
              autoFocus
              aria-label="Nombre de la nueva fase"
              placeholder="Ej. Cimentación"
              value={phaseName}
              maxLength={160}
              onChange={(e) => setPhaseName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setPhaseName(null)}
            />
            <button className="primary" disabled={!phaseName.trim()}>
              Crear fase
            </button>
            <button
              type="button"
              aria-label="Cancelar"
              onClick={() => setPhaseName(null)}
            >
              <X size={14} />
            </button>
          </form>
        )}
        <button disabled={!chosen.length} onClick={() => removeTasks(chosen)}>
          <Trash2 size={15} /> Eliminar
        </button>
        {!!chosen.length && (
          <span className="planner-count">
            {chosen.length}{" "}
            {chosen.length === 1 ? "seleccionada" : "seleccionadas"}
          </span>
        )}
        <span className="planner-divider" />
        <label className="planner-scale">
          Escala
          <select
            value={scale}
            onChange={(e) => setScale(e.target.value as Scale)}
          >
            <option value="day">Días</option>
            <option value="week">Semanas</option>
            <option value="month">Meses</option>
            <option value="fit">Todo el cronograma</option>
          </select>
        </label>
        <button onClick={fitScroll} title="Ajustar al cronograma completo">
          <Maximize2 size={15} /> Ajustar
        </button>
        <button
          onClick={() => setBaseline(false)}
          disabled={!timeline.schedule.length || !fresh || !!problem}
          title={!fresh ? "Espera a que se recalculen las fechas" : undefined}
        >
          <Flag size={15} />{" "}
          {baselineSet ? "Actualizar línea base" : "Fijar línea base"}
        </button>
        {baselineSet && (
          <button onClick={() => setBaseline(true)}>Quitar línea base</button>
        )}
        <a
          className={"btn" + (dirty ? " disabled" : "")}
          aria-disabled={dirty}
          title={dirty ? "Guarda el cronograma antes de exportarlo" : undefined}
          href={dirty ? undefined : `/api/projects/${pid}/schedule.xml`}
          download
        >
          <Download size={15} /> Exportar XML
        </a>
      </div>

      {stale && (
        <div className="notice planner-problem" role="status">
          Tienes cambios sin guardar de antes, pero el cronograma guardado
          cambió después (por ejemplo, desde otra pestaña). Si los recuperas,
          reemplazarán esa versión al guardar.
          <button
            onClick={() => {
              setDraft(stale);
              setStale(null);
            }}
          >
            Reemplazar con mis cambios
          </button>
          <button
            onClick={() => {
              try {
                sessionStorage.removeItem(storeKey);
              } catch {
                // Nothing to clean.
              }
              setStale(null);
            }}
          >
            Descartar mis cambios
          </button>
        </div>
      )}
      {problem && (
        <div className="error planner-problem" role="alert">
          {problem.message}
          {problem.info?.task && (
            <button
              onClick={() => {
                setActive({ kind: "task", id: problem.info!.task! });
                document
                  .getElementById(`cell-${problem.info!.task}-name`)
                  ?.focus();
              }}
            >
              Ir a la actividad
            </button>
          )}
        </div>
      )}

      <div
        className={"planner-body" + (active ? " with-details" : "")}
        inert={saving}
        aria-busy={saving}
      >
        <div
          className={"planner-scroll" + (width < 560 ? " narrow" : "")}
          ref={scroller}
          onPaste={onPaste}
          style={{ ["--table-w" as string]: tableWidth + "px" }}
        >
          <div
            className="planner-canvas"
            style={{ width: tableWidth + timelineWidth }}
          >
            <div className="planner-row planner-head" style={{ height: HEAD }}>
              <div className="planner-cells">
                <span />
                <span>EDT</span>
                <span>Actividad</span>
                <span title="Duración en días laborables">Días</span>
                <span>Inicio</span>
                <span>Fin</span>
                <span>Predecesoras</span>
              </div>
              <div className="planner-axis" style={{ width: timelineWidth }}>
                {ticks.top.map((t) => (
                  <span
                    key={"t" + t.left}
                    className="axis-top"
                    style={{ left: t.left }}
                  >
                    {t.text}
                  </span>
                ))}
                {ticks.bottom.map((t) => (
                  <span
                    key={"b" + t.left}
                    className={"axis-bottom" + (t.off ? " off" : "")}
                    style={{
                      left: t.left,
                      width: scale === "day" ? px : undefined,
                    }}
                  >
                    {t.text}
                  </span>
                ))}
              </div>
            </div>

            <div
              className="planner-rows"
              style={{ height: Math.max(1, visible.length) * ROW }}
            >
              <div
                className="planner-shade"
                style={{ left: tableWidth, width: timelineWidth }}
                aria-hidden="true"
              >
                {nonWorking.map((d) => (
                  <i key={d} style={{ left: (d - origin) * px, width: px }} />
                ))}
                {draft.status_date && (
                  <b
                    className="status-marker"
                    style={{ left: x(draft.status_date, true) }}
                    title={`Fecha de seguimiento: ${longDate(draft.status_date)}`}
                  />
                )}
              </div>
              <svg
                className="planner-links"
                style={{ left: tableWidth }}
                width={timelineWidth}
                height={Math.max(1, visible.length) * ROW}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id="arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M0 0 L8 4 L0 8 z" fill="var(--link-color)" />
                  </marker>
                  <marker
                    id="arrow-critical"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M0 0 L8 4 L0 8 z" fill="var(--critical)" />
                  </marker>
                </defs>
                {arrows.map((a) => (
                  <path
                    key={a.key}
                    d={a.d}
                    className={a.critical ? "critical" : ""}
                    markerEnd={`url(#${a.critical ? "arrow-critical" : "arrow"})`}
                  />
                ))}
              </svg>

              {visible.map((r) => {
                if (r.kind === "phase") {
                  const p = phaseRows.get(r.code);
                  const isActive =
                    active?.kind === "phase" && active.code === r.code;
                  return (
                    <div
                      key={"p" + r.code}
                      className={
                        "planner-row phase" + (isActive ? " active" : "")
                      }
                    >
                      <div className="planner-cells">
                        <span />
                        <span className="wbs">{r.code}</span>
                        <span
                          className="name"
                          style={{ paddingLeft: r.depth * 14 }}
                        >
                          <button
                            className="fold"
                            aria-expanded={!folded.has(r.code)}
                            aria-label={
                              (folded.has(r.code) ? "Mostrar " : "Plegar ") +
                              r.name
                            }
                            onClick={() => {
                              const next = new Set(folded);
                              if (next.has(r.code)) next.delete(r.code);
                              else next.add(r.code);
                              setFolded(next);
                            }}
                          >
                            {folded.has(r.code) ? (
                              <ChevronRight size={14} />
                            ) : (
                              <ChevronDown size={14} />
                            )}
                          </button>
                          <input
                            className="cell"
                            aria-label={`Nombre de la fase ${r.code}`}
                            value={r.name}
                            maxLength={160}
                            onFocus={() =>
                              setActive({ kind: "phase", code: r.code })
                            }
                            onChange={(e) =>
                              restructure(
                                renamePhase(
                                  tree,
                                  r.code,
                                  e.target.value || " ",
                                ),
                              )
                            }
                          />
                        </span>
                        <span
                          className="num"
                          title={
                            p ? days(p.duration) + " laborables" : undefined
                          }
                        >
                          {p ? p.duration : "—"}
                        </span>
                        <span title={p ? longDate(p.start) : undefined}>
                          {p ? cellDate(p.start) : ""}
                        </span>
                        <span title={p ? longDate(p.finish) : undefined}>
                          {p ? cellDate(p.finish) : ""}
                        </span>
                        <span className="muted">
                          {r.size} {r.size === 1 ? "actividad" : "actividades"}
                        </span>
                      </div>
                      <div
                        className="planner-track"
                        style={{ width: timelineWidth }}
                      >
                        {p && (
                          <button
                            className={
                              "bar phase-bar" + (p.critical ? " critical" : "")
                            }
                            style={{
                              left: x(p.start),
                              width: Math.max(
                                4,
                                x(p.finish, true) - x(p.start),
                              ),
                            }}
                            onClick={() =>
                              setActive({ kind: "phase", code: r.code })
                            }
                            aria-label={`Fase ${r.name}: ${shortDate(p.start)} a ${shortDate(p.finish)}`}
                          ></button>
                        )}
                      </div>
                    </div>
                  );
                }
                const t = tasks.get(r.id)!;
                const c = computed.get(r.id);
                const isActive = active?.kind === "task" && active.id === r.id;
                const rowError = cellError(r.id, "row");
                const milestone = t.duration === 0 && !t.quantity;
                return (
                  <div
                    key={r.id}
                    className={
                      "planner-row" +
                      (isActive ? " active" : "") +
                      (selected.has(r.id) ? " selected" : "") +
                      (c?.critical ? " is-critical" : "") +
                      (rowError ? " has-error" : "")
                    }
                  >
                    <div
                      className="planner-cells"
                      onFocus={() => setActive({ kind: "task", id: r.id })}
                    >
                      <span>
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar ${t.name || "actividad nueva"}`}
                          checked={selected.has(r.id)}
                          onClick={(e) => toggleSelect(r.id, e.shiftKey)}
                          readOnly
                        />
                      </span>
                      <span className="wbs">{t.wbs}</span>
                      <span
                        className="name"
                        style={{ paddingLeft: r.depth * 14 }}
                      >
                        {milestone && (
                          <Diamond
                            size={11}
                            className="milestone-icon"
                            aria-label="Hito"
                          />
                        )}
                        <input
                          id={`cell-${r.id}-name`}
                          className="cell"
                          data-task={r.id}
                          data-field="name"
                          aria-label={`Nombre de la actividad ${t.wbs}`}
                          aria-invalid={!!cellError(r.id, "name") || undefined}
                          title={cellError(r.id, "name") || undefined}
                          placeholder="Nombre de la actividad"
                          value={t.name}
                          maxLength={160}
                          onChange={(e) =>
                            patchTask(r.id, { name: e.target.value })
                          }
                          onKeyDown={(e) => onCellKey(e, r.id)}
                        />
                      </span>
                      <span className="num">
                        <input
                          id={`cell-${r.id}-duration`}
                          className="cell"
                          data-task={r.id}
                          data-field="duration"
                          inputMode="numeric"
                          aria-label={`Duración en días laborables de ${t.name || "la actividad"}`}
                          aria-invalid={
                            !!cellError(r.id, "duration") || undefined
                          }
                          title={
                            cellError(r.id, "duration") ||
                            (t.quantity
                              ? "Calculada con las cantidades vinculadas"
                              : undefined)
                          }
                          readOnly={!!t.quantity}
                          value={
                            durations[r.id] ??
                            String(
                              t.quantity
                                ? (c?.duration ?? t.duration)
                                : t.duration,
                            )
                          }
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (
                              /^\d{1,4}$/.test(raw.trim()) &&
                              Number(raw) <= 3650
                            ) {
                              const { [r.id]: _, ...rest } = durations;
                              setDurations(rest);
                              patchTask(r.id, { duration: Number(raw) });
                            } else setDurations({ ...durations, [r.id]: raw });
                          }}
                          onKeyDown={(e) => onCellKey(e, r.id)}
                        />
                      </span>
                      <span
                        className="date"
                        title={c ? longDate(c.start) : undefined}
                      >
                        {c ? cellDate(c.start) : "—"}
                      </span>
                      <span
                        className="date"
                        title={c ? longDate(c.finish) : undefined}
                      >
                        {c && !c.milestone
                          ? cellDate(c.finish)
                          : c
                            ? "Hito"
                            : "—"}
                      </span>
                      <span className="preds">
                        {t.links.map((l) => (
                          <span
                            key={l.predecessor}
                            className="pred-chip"
                            title={`${RELATIONS[l.relation].sentence} «${names.get(l.predecessor)}»`}
                          >
                            <b>{RELATIONS[l.relation].short}</b>
                            <span className="pred-text">
                              <small>
                                {RELATIONS[l.relation].sentence}
                                {l.lag
                                  ? ` (${l.lag > 0 ? "+" : ""}${l.lag} d)`
                                  : ""}
                              </small>
                              <strong>{names.get(l.predecessor)}</strong>
                            </span>
                            <button
                              aria-label={`Quitar predecesora ${names.get(l.predecessor)}`}
                              onClick={() =>
                                patchTask(r.id, {
                                  links: t.links.filter(
                                    (x) => x.predecessor !== l.predecessor,
                                  ),
                                })
                              }
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ))}
                        <input
                          id={`cell-${r.id}-links`}
                          className="cell pred-search"
                          list="planner-tasks"
                          data-task={r.id}
                          data-field="links"
                          aria-label={`Buscar predecesora de ${t.name || "la actividad"}`}
                          aria-invalid={!!cellError(r.id, "links") || undefined}
                          title={cellError(r.id, "links") || undefined}
                          placeholder={
                            t.links.length ? "+" : "Buscar predecesora…"
                          }
                          onChange={(e) => {
                            const match = pickList.find(
                              (o) => o.text === e.target.value && o.id !== r.id,
                            );
                            if (match) {
                              addLink(r.id, match.id);
                              e.target.value = "";
                            }
                          }}
                        />
                      </span>
                    </div>
                    <div
                      className="planner-track"
                      style={{ width: timelineWidth }}
                    >
                      {c?.baseline && (
                        <i
                          className="baseline-bar"
                          style={{
                            left: x(c.baseline.start),
                            width: Math.max(
                              3,
                              x(c.baseline.finish, true) - x(c.baseline.start),
                            ),
                          }}
                          title={`Línea base: ${shortDate(c.baseline.start)} a ${shortDate(c.baseline.finish)}`}
                        />
                      )}
                      {c &&
                        (c.milestone ? (
                          <button
                            className={
                              "milestone" + (c.critical ? " critical" : "")
                            }
                            style={{ left: x(c.start, !!c.at_day_end) - 8 }}
                            onClick={() =>
                              setActive({ kind: "task", id: r.id })
                            }
                            aria-label={`Hito ${t.name}: ${shortDate(c.start)}`}
                          />
                        ) : (
                          <button
                            className={"bar" + (c.critical ? " critical" : "")}
                            style={{
                              left: x(c.start),
                              width: Math.max(
                                3,
                                x(c.finish, true) - x(c.start),
                              ),
                            }}
                            onClick={() =>
                              setActive({ kind: "task", id: r.id })
                            }
                            aria-label={`${t.name}: ${shortDate(c.start)} a ${shortDate(c.finish)}`}
                          ></button>
                        ))}
                    </div>
                    {rowError && (
                      <p className="row-error" style={{ left: 8 }}>
                        {rowError}
                      </p>
                    )}
                  </div>
                );
              })}
              {!draft.tasks.length && (
                <div className="planner-row">
                  <div className="planner-cells">
                    <span />
                    <span className="wbs">1</span>
                    <span className="name">
                      <input
                        className="cell"
                        aria-label="Primera actividad"
                        placeholder="Escribe una actividad o pega filas desde Excel"
                        onChange={(e) => {
                          const [created] = addTasks(
                            [{ name: e.target.value, duration: 1 }],
                            null,
                          );
                          focusNext.current = { id: created.id, field: "name" };
                        }}
                      />
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <datalist id="planner-tasks">
            {pickList.map((o) => (
              <option key={o.id} value={o.text} />
            ))}
          </datalist>
        </div>

        {active && (
          <div
            className="planner-details"
            role="region"
            aria-label="Detalles de la selección"
          >
            <button
              className="close"
              aria-label="Cerrar detalles"
              onClick={() => setActive(null)}
            >
              <X size={16} />
            </button>
            {activeTask ? (
              <TaskDetails
                key={activeTask.id}
                task={activeTask}
                row={computed.get(activeTask.id)}
                plan={draft}
                state={state}
                names={names}
                pickList={pickList}
                problem={cellError(activeTask.id, "row")}
                patch={(change) => patchTask(activeTask.id, change)}
                addLink={(from) => addLink(activeTask.id, from)}
                onMove={(step) => restructure(move(tree, activeTask.id, step))}
                onDelete={() => removeTasks([activeTask.id])}
              />
            ) : activePhase || active.kind === "phase" ? (
              <PhaseDetails
                phase={activePhase}
                code={active.kind === "phase" ? active.code : ""}
                name={
                  draft.groups[active.kind === "phase" ? active.code : ""] ?? ""
                }
                onUngroup={() => {
                  restructure(ungroup(tree, (active as { code: string }).code));
                  setActive(null);
                }}
              />
            ) : null}
          </div>
        )}
      </div>

      <div className="schedule-legend planner-legend">
        <span>
          <i className="key-bar" /> Actividad
        </span>
        <span>
          <i className="key-critical" /> Ruta crítica
        </span>
        <span>
          <i className="key-phase" /> Fase
        </span>
        <span>
          <i className="key-milestone" /> Hito
        </span>
        {baselineSet && (
          <span>
            <i className="key-baseline" /> Línea base
          </span>
        )}
        {draft.status_date && (
          <span>
            <i className="key-status" /> Fecha de seguimiento
          </span>
        )}
      </div>
      <p className="field-help">
        Escribe el nombre y la duración, pulsa Enter para otra fila y Tab para
        pasar de celda. Puedes pegar varias filas copiadas de Excel (nombre y
        duración). Selecciona actividades para encadenarlas o agruparlas en una
        fase. Las fechas se calculan con el inicio y el calendario del proyecto.
      </p>

      {calendarOpen && (
        <CalendarDialog
          plan={draft}
          close={() => setCalendarOpen(false)}
          apply={(change) => {
            setDraft({ ...draft, ...change });
            setCalendarOpen(false);
          }}
        />
      )}
    </section>
  );
}

function TaskDetails({
  task,
  row,
  plan,
  state,
  names,
  pickList,
  problem,
  patch,
  addLink,
  onMove,
  onDelete,
}: {
  task: Task;
  row?: Scheduled;
  plan: Plan;
  state: State;
  names: Map<number, string>;
  pickList: { id: number; text: string }[];
  problem: string;
  patch: (change: Partial<Task>) => void;
  addLink: (from: number) => void;
  onMove: (step: -1 | 1) => void;
  onDelete: () => void;
}) {
  const sources = state.tables.filter(
    (s) => state.results[s.id]?.detail.length,
  );
  const milestone = task.duration === 0 && !task.quantity;
  const setLink = (i: number, change: Partial<Task["links"][number]>) =>
    patch({
      links: task.links.map((x, j) => (j === i ? { ...x, ...change } : x)),
    });
  return (
    <div className="details-body">
      <div className="details-head">
        <span className="eyebrow">
          {milestone ? "Hito" : "Actividad"} {task.wbs}
        </span>
        <h3>{task.name || "Actividad nueva"}</h3>
        {problem && (
          <p className="error" role="alert">
            {problem}
          </p>
        )}
      </div>

      <div className="details-columns">
        <div className="details-col">
          {row && (
            <section className="details-card">
              <h4>Resumen</h4>
              <dl className="details-dates">
                <div>
                  <dt>{milestone ? "Fecha" : "Empieza"}</dt>
                  <dd>{longDate(row.start)}</dd>
                </div>
                {!milestone && (
                  <div>
                    <dt>Termina</dt>
                    <dd>{longDate(row.finish)}</dd>
                  </div>
                )}
                {!milestone && (
                  <div>
                    <dt>Dura</dt>
                    <dd>{days(row.duration)} laborables</dd>
                  </div>
                )}
                <div>
                  <dt>Margen</dt>
                  <dd>
                    {row.critical ? (
                      <strong className="critical-tag">
                        Ninguno: es parte de la ruta crítica
                      </strong>
                    ) : (
                      `${days(row.slack)} laborables`
                    )}
                  </dd>
                </div>
              </dl>
              <p className="muted">
                {row.critical
                  ? "Si se retrasa, se mueve el final del cronograma o se incumple una fecha obligatoria."
                  : `Puede retrasarse hasta ${days(row.slack)} laborables sin mover el final del cronograma.`}
              </p>
              {row.baseline && (
                <p className="muted">
                  Línea base: {shortDate(row.baseline.start)} a{" "}
                  {shortDate(row.baseline.finish)}. Inicio:{" "}
                  {variance(row.baseline.start_variance)}. Fin:{" "}
                  {variance(row.baseline.finish_variance)}.
                </p>
              )}
            </section>
          )}
          {row && (
            <section className="details-card details-why">
              <h4>¿Por qué estas fechas?</h4>
              {explain(row, names, plan).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </section>
          )}
        </div>

        <div className="details-col">
          <section className="details-card">
            <h4>¿De qué depende?</h4>
            <p className="muted">
              Actividades que tienen que avanzar antes que esta.
            </p>
            {task.links.length === 0 && (
              <p className="details-empty">No depende de ninguna actividad.</p>
            )}
            {task.links.map((l, i) => (
              <div key={l.predecessor} className="details-link">
                <div className="details-link-head">
                  <strong>«{names.get(l.predecessor)}»</strong>
                  <button
                    aria-label={`Quitar dependencia de ${names.get(l.predecessor)}`}
                    onClick={() =>
                      patch({ links: task.links.filter((_, j) => j !== i) })
                    }
                  >
                    <X size={13} /> Quitar
                  </button>
                </div>
                <label>
                  Cómo se relacionan
                  <select
                    value={l.relation}
                    onChange={(e) => setLink(i, { relation: e.target.value })}
                  >
                    {Object.entries(RELATIONS).map(([code, r]) => (
                      <option key={code} value={code}>
                        {r.sentence} «{names.get(l.predecessor)}» ({r.short})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Días de espera
                  <input
                    type="number"
                    step="1"
                    min="-3650"
                    max="3650"
                    value={l.lag}
                    onChange={(e) =>
                      setLink(i, {
                        lag: Math.trunc(Number(e.target.value) || 0),
                      })
                    }
                  />
                </label>
                <small>
                  {l.lag > 0
                    ? `Espera ${days(l.lag)} laborables más.`
                    : l.lag < 0
                      ? `Se adelanta ${days(-l.lag)} laborables (se solapan).`
                      : "Sin espera. Escribe un número negativo para solaparlas."}
                </small>
              </div>
            ))}
            <label>
              Añadir dependencia
              <input
                list="planner-tasks"
                placeholder="Busca una actividad por nombre"
                onChange={(e) => {
                  const match = pickList.find(
                    (o) => o.text === e.target.value && o.id !== task.id,
                  );
                  if (match) {
                    addLink(match.id);
                    e.target.value = "";
                  }
                }}
              />
            </label>
          </section>

          <section className="details-card">
            <h4>
              Fechas obligatorias <small>(opcional)</small>
            </h4>
            <p className="muted">
              Úsalas solo si hay una fecha que no se puede mover.
            </p>
            <label>
              No empezar antes del
              <span className="date-field">
                <input
                  type="date"
                  value={task.earliest ?? ""}
                  onChange={(e) => patch({ earliest: e.target.value || null })}
                />
                {task.earliest && (
                  <button
                    aria-label="Quitar «No empezar antes del»"
                    onClick={() => patch({ earliest: null })}
                  >
                    <X size={13} />
                  </button>
                )}
              </span>
            </label>
            <label>
              Terminar exactamente el
              <span className="date-field">
                <input
                  type="date"
                  value={task.fixed_finish ?? ""}
                  onChange={(e) =>
                    patch({ fixed_finish: e.target.value || null })
                  }
                />
                {task.fixed_finish && (
                  <button
                    aria-label="Quitar «Terminar exactamente el»"
                    onClick={() => patch({ fixed_finish: null })}
                  >
                    <X size={13} />
                  </button>
                )}
              </span>
            </label>
          </section>

          <details className="details-card" open={!!task.calendar}>
            <summary>Días de trabajo de esta actividad</summary>
            <label>
              Calendario
              <select
                value={task.calendar ?? ""}
                onChange={(e) => patch({ calendar: e.target.value })}
              >
                <option value="">El del proyecto</option>
                {Object.keys(plan.calendars ?? {}).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <p className="muted">
              Por ejemplo, un curado que sigue el fin de semana. Los calendarios
              se crean en «Calendario y seguimiento».
            </p>
          </details>

          <details className="details-card" open={!!task.quantity}>
            <summary>Calcular la duración con cantidades (opcional)</summary>
            <label>
              Origen de la duración
              <select
                value={task.quantity?.table ?? ""}
                onChange={(e) =>
                  patch({
                    quantity: e.target.value
                      ? {
                          table: +e.target.value,
                          unit: availableMeasures(
                            state.results[+e.target.value].detail,
                          )[0].unit,
                          rate: 1,
                          level: "",
                          category: "",
                        }
                      : null,
                  })
                }
              >
                <option value="">Duración escrita a mano</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.mapping?.category}
                  </option>
                ))}
              </select>
            </label>
            {task.quantity && state.results[task.quantity.table] && (
              <>
                <label>
                  Nivel
                  <select
                    value={task.quantity.level}
                    onChange={(e) =>
                      patch({
                        quantity: { ...task.quantity!, level: e.target.value },
                      })
                    }
                  >
                    <option value="">Todos los niveles</option>
                    {[
                      ...new Set(
                        state.results[task.quantity.table].detail.map((r) =>
                          String(r.Nivel),
                        ),
                      ),
                    ].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Categoría
                  <select
                    value={task.quantity.category ?? ""}
                    onChange={(e) =>
                      patch({
                        quantity: {
                          ...task.quantity!,
                          category: e.target.value,
                        },
                      })
                    }
                  >
                    <option value="">Todas las categorías</option>
                    {[
                      ...new Set(
                        state.results[task.quantity.table].detail.map((r) =>
                          String(r.Categoría),
                        ),
                      ),
                    ].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Magnitud
                  <select
                    value={task.quantity.unit}
                    onChange={(e) =>
                      patch({
                        quantity: { ...task.quantity!, unit: e.target.value },
                      })
                    }
                  >
                    {availableMeasures(
                      state.results[task.quantity.table].detail,
                    ).map((m) => (
                      <option key={m.unit} value={m.unit}>
                        {m.label} ({unitLabel(m.unit)})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Rendimiento ({unitLabel(task.quantity.unit)}/día)
                  <input
                    type="number"
                    min="0.000000001"
                    step="any"
                    value={task.quantity.rate || ""}
                    onChange={(e) =>
                      patch({
                        quantity: {
                          ...task.quantity!,
                          rate: Number(e.target.value) || 0,
                        },
                      })
                    }
                  />
                </label>
                {row?.amount != null && (
                  <p className="notice">
                    {fmt(row.amount)} {unitLabel(task.quantity.unit)} ÷{" "}
                    {fmt(task.quantity.rate)} ={" "}
                    <strong>{days(row.duration)} laborables</strong>
                  </p>
                )}
              </>
            )}
          </details>
        </div>
      </div>

      <div className="details-actions">
        <button onClick={() => onMove(-1)}>Subir</button>
        <button onClick={() => onMove(1)}>Bajar</button>
        <button onClick={onDelete}>
          <Trash2 size={14} /> Eliminar
        </button>
      </div>
    </div>
  );
}

function PhaseDetails({
  phase,
  code,
  name,
  onUngroup,
}: {
  phase?: Phase;
  code: string;
  name: string;
  onUngroup: () => void;
}) {
  return (
    <div className="details-body">
      <span className="eyebrow">Fase {code}</span>
      <h3>{name}</h3>
      {phase ? (
        <dl className="details-dates">
          <div>
            <dt>Inicio</dt>
            <dd>{longDate(phase.start)}</dd>
          </div>
          <div>
            <dt>Fin</dt>
            <dd>{longDate(phase.finish)}</dd>
          </div>
          <div>
            <dt>Duración</dt>
            <dd>{days(phase.duration)} laborables del proyecto</dd>
          </div>
        </dl>
      ) : (
        <p className="muted">
          Añade actividades a esta fase para ver sus fechas.
        </p>
      )}
      <p className="muted">
        Las fechas de la fase van del primer inicio al último fin de sus
        actividades.
      </p>
      <div className="details-actions">
        <button onClick={onUngroup}>Desagrupar fase</button>
      </div>
    </div>
  );
}

function CalendarDialog({
  plan,
  apply,
  close,
}: {
  plan: Plan;
  apply: (change: Partial<Plan>) => void;
  close: () => void;
}) {
  const [weekdays, setWeekdays] = useState(plan.weekdays),
    [holidays, setHolidays] = useState(plan.holidays),
    [statusDate, setStatusDate] = useState(plan.status_date ?? ""),
    [holiday, setHoliday] = useState(""),
    [calendars, setCalendars] = useState<Record<string, WorkCalendar>>(
      plan.calendars ?? {},
    ),
    [newName, setNewName] = useState("");
  const toggle = (list: number[], d: number) =>
    list.includes(d) ? list.filter((x) => x !== d) : [...list, d].sort();
  return (
    <Modal
      title="Calendario y seguimiento"
      close={close}
      className="calendar-dialog"
    >
      <form
        className="calendar-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply({
            weekdays,
            holidays,
            status_date: statusDate || null,
            calendars,
          });
        }}
      >
        <label>
          Fecha de seguimiento (opcional)
          <input
            type="date"
            value={statusDate}
            onChange={(e) => setStatusDate(e.target.value)}
          />
        </label>
        <p className="field-help">
          Corte para comparar el avance previsto con el real. Vacía usa hoy.
        </p>
        <h3>Días de trabajo del proyecto</h3>
        <div className="weekdays">
          {WEEKDAYS.map((d, i) => (
            <label className="check" key={d}>
              <input
                type="checkbox"
                checked={weekdays.includes(i)}
                disabled={weekdays.length === 1 && weekdays.includes(i)}
                onChange={() => setWeekdays(toggle(weekdays, i))}
              />
              {d}
            </label>
          ))}
        </div>
        <h3>Festivos</h3>
        <div className="holiday-entry">
          <input
            type="date"
            aria-label="Nuevo festivo"
            value={holiday}
            onChange={(e) => setHoliday(e.target.value)}
          />
          <button
            type="button"
            disabled={!holiday || holidays.includes(holiday)}
            onClick={() => {
              setHolidays([...holidays, holiday].sort());
              setHoliday("");
            }}
          >
            <Plus size={14} /> Añadir festivo
          </button>
        </div>
        <div className="chips">
          {holidays.map((h) => (
            <button
              type="button"
              key={h}
              aria-label={`Quitar festivo ${h}`}
              onClick={() => setHolidays(holidays.filter((x) => x !== h))}
            >
              {shortDate(h)} <X size={12} />
            </button>
          ))}
        </div>
        <h3>Calendarios para actividades</h3>
        <p className="field-help">
          Por ejemplo, «Curado continuo» de lunes a domingo. Se asigna en el
          detalle de cada actividad.
        </p>
        {Object.entries(calendars).map(([name, c]) => (
          <div key={name} className="calendar-extra">
            <strong>{name}</strong>
            <div className="weekdays">
              {WEEKDAYS.map((d, i) => (
                <label className="check" key={d}>
                  <input
                    type="checkbox"
                    checked={c.weekdays.includes(i)}
                    disabled={c.weekdays.length === 1 && c.weekdays.includes(i)}
                    onChange={() =>
                      setCalendars({
                        ...calendars,
                        [name]: { ...c, weekdays: toggle(c.weekdays, i) },
                      })
                    }
                  />
                  {d}
                </label>
              ))}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={c.project_holidays}
                onChange={(e) =>
                  setCalendars({
                    ...calendars,
                    [name]: { ...c, project_holidays: e.target.checked },
                  })
                }
              />
              Respeta los festivos del proyecto
            </label>
            <button
              type="button"
              onClick={() => {
                const { [name]: _, ...rest } = calendars;
                setCalendars(rest);
              }}
            >
              <Trash2 size={13} /> Quitar calendario
            </button>
          </div>
        ))}
        <div className="holiday-entry">
          <input
            aria-label="Nombre del calendario"
            placeholder="Ej. Curado continuo"
            value={newName}
            maxLength={160}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            type="button"
            disabled={!newName.trim() || !!calendars[newName.trim()]}
            onClick={() => {
              setCalendars({
                ...calendars,
                [newName.trim()]: {
                  weekdays: [0, 1, 2, 3, 4, 5, 6],
                  holidays: [],
                  project_holidays: true,
                },
              });
              setNewName("");
            }}
          >
            <Plus size={14} /> Crear calendario
          </button>
        </div>
        <div className="actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary">Aplicar al cronograma</button>
        </div>
      </form>
    </Modal>
  );
}
