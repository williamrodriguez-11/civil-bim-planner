import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
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
  Printer,
  Redo2,
  Save,
  Trash2,
  Undo2,
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
  type Row,
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
/** Working days from one date to another, both included, in the calendar
 * of an activity (or the project's). */
function workdays(from: string, to: string, plan: Plan, calendar?: string) {
  const own = calendar ? plan.calendars?.[calendar] : undefined;
  const weekdays = new Set(own ? own.weekdays : plan.weekdays);
  const holidays = new Set([
    ...(own ? own.holidays : []),
    ...(!own || own.project_holidays ? plan.holidays : []),
  ]);
  // Stops past the longest allowed duration, so far dates stay fast.
  let count = 0;
  for (let d = toDay(from), end = toDay(to); d <= end && count <= 3650; d++) {
    const weekday = (new Date(d * DAY).getUTCDay() + 6) % 7;
    if (weekdays.has(weekday) && !holidays.has(fromDay(d))) count++;
  }
  return count;
}

/** The first working day on or after a date (within ten years). */
function firstWorkday(from: string, plan: Plan, calendar?: string) {
  for (let d = toDay(from), end = d + 3660; d <= end; d++)
    if (workdays(fromDay(d), fromDay(d), plan, calendar)) return fromDay(d);
  return null;
}

/** JSON with object keys in order, to compare plans by value. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

const COLS_KEY = "civil-schedule-columns";
const DEFAULT_COLS = { name: 220, preds: 220 };
// Selection, EDT, Días, Inicio, Fin and the table's border.
const FIXED_COLS = 28 + 42 + 44 + 54 + 54 + 1;
const clampCol = (n: number) => Math.round(Math.min(640, Math.max(120, n)));

/** Drag handle on the right edge of a column header; arrows also work,
 * and a double click restores the default width. */
function ColumnResizer({
  label,
  value,
  onChange,
  reset,
}: {
  label: string;
  value: number;
  onChange: (width: number) => void;
  reset: () => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <span
      className="col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Ancho de la columna ${label}`}
      aria-valuenow={value}
      aria-valuemin={120}
      aria-valuemax={640}
      tabIndex={0}
      title="Arrastra para cambiar el ancho (doble clic: ancho normal)"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: value };
      }}
      onPointerMove={(e) => {
        if (start.current)
          onChange(clampCol(start.current.width + e.clientX - start.current.x));
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        const step =
          e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0;
        if (!step) return;
        e.preventDefault();
        onChange(clampCol(value + step));
      }}
    />
  );
}

const RELATION_CODES: Record<string, string> = {
  FC: "FS",
  FS: "FS",
  CC: "SS",
  SS: "SS",
  FF: "FF",
  CF: "SF",
  SF: "SF",
};

/** Predecessors typed as in Project: «1.1», «1.1CC», «1.2FC+2», «2-1»,
 * several separated by ; or , — or an activity name. */
function parsePredecessors(
  text: string,
  tasks: Task[],
  self: number,
): { links: Task["links"]; error: string; explicit?: number[] } {
  const links: Task["links"] = [];
  const explicit: number[] = []; // links with a relation or lag written out
  // A whole name may itself contain commas or semicolons.
  const whole = text.trim().toLowerCase();
  const code = /^[\d.]+\s*(FC|CC|FF|CF|FS|SS|SF)?\s*([+-]\s*\d+.*)?$/i.test(
    whole,
  );
  const exact = code
    ? []
    : tasks.filter((t) => t.name.trim().toLowerCase() === whole);
  if (exact.length > 1)
    return {
      links: [],
      error: `Hay varias actividades «${text.trim()}»: escribe su número.`,
    };
  const parts = exact.length === 1 ? [text.trim()] : text.split(/[;,]/);
  for (const raw of parts.map((x) => x.trim()).filter(Boolean)) {
    const token = raw;
    const m = token.match(
      /^(\d+(?:\.\d+)*)\s*(FC|CC|FF|CF|FS|SS|SF)?\s*(?:([+-])\s*(\d+)\s*(?:d|días?)?)?$/i,
    );
    const named = tasks.filter((t) => t.name.trim());
    const found = m
      ? named.filter((t) => t.wbs === m[1])
      : named.filter(
          (t) => t.name.trim().toLowerCase() === token.toLowerCase(),
        );
    if (found.length > 1)
      return {
        links: [],
        error: `Hay varias actividades «${raw}»: escribe su número.`,
      };
    const target = found[0];
    if (!target) return { links: [], error: `No hay una actividad «${raw}».` };
    if (target.id === self)
      return {
        links: [],
        error: "Una actividad no puede depender de sí misma.",
      };
    if (links.some((l) => l.predecessor === target.id))
      return {
        links: [],
        error: `«${target.name || raw}» aparece dos veces.`,
      };
    const lag = m?.[4] ? Number(m[3] + m[4]) : 0;
    if (Math.abs(lag) > 3650)
      return {
        links: [],
        error: "La espera no puede pasar de 3650 días.",
      };
    if (m?.[2] || m?.[4]) explicit.push(target.id);
    links.push({
      predecessor: target.id,
      relation: m?.[2] ? RELATION_CODES[m[2].toUpperCase()] : "FS",
      lag,
    });
  }
  return { links, error: "", explicit };
}

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
  // While true, the paper layout is mounted and the print dialog opens.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    // Let the paper layout render before the dialog takes its snapshot.
    const frame = requestAnimationFrame(() => {
      window.print();
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("afterprint", done);
    };
  }, [printing]);
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
  // The last start typed in the table. If the recalculated schedule cannot
  // honour it, a notice says why and offers a way out.
  const failedDraft = useRef<Plan | null>(null); // the draft a preview rejected
  // Whether a preview has succeeded since the last start edit: after that,
  // a failure comes from something else.
  const startChecked = useRef(false);
  // The last activity whose calculated duration was replaced by hand.
  const [unlinked, setUnlinked] = useState<{
    id: number;
    quantity: NonNullable<Task["quantity"]>;
  } | null>(null);
  const [request, setRequest] = useState<{
    id: number;
    value: string;
    before: string | null | undefined;
    removed: Task["links"]; // links taken out from the notice
  } | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [phaseName, setPhaseName] = useState<string | null>(null);
  const focusNext = useRef<{ id: number; field: string } | null>(null);
  const [editing, setEditing] = useState<{
    id: number;
    field: "start" | "finish";
    value: string; // shown when the editor opened
  } | null>(null);
  const [typed, setTyped] = useState<
    Record<number, { error: string; text: string }>
  >({});
  const [drag, setDrag] = useState<{
    from: number;
    x0: number;
    y0: number;
    x: number;
    y: number;
  } | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  // Widths of «Actividad» and «Predecesoras», adjustable by dragging the
  // edge of their header, as in Excel or Project. Kept in this browser.
  const [cols, setCols] = useState<{ name: number; preds: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) ?? "");
      if (Number.isFinite(saved?.name) && Number.isFinite(saved?.preds))
        return { name: clampCol(saved.name), preds: clampCol(saved.preds) };
    } catch {
      // Defaults below.
    }
    return DEFAULT_COLS;
  });
  useEffect(() => {
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(cols));
    } catch {
      // Not remembered; still works.
    }
  }, [cols]);

  // Undo and redo, as in Project: every change keeps the plan it replaced.
  // Changes within a moment of each other (typing a name) count as one.
  const past = useRef<Plan[]>([]);
  const future = useRef<Plan[]>([]);
  const lastChange = useRef<{ at: number; field: string | null }>({
    at: 0,
    field: null,
  });
  const [, setHistoryTick] = useState(0);

  function setDraft(plan: Plan, fromHistory = false) {
    if (!fromHistory && plan !== latest.current) {
      // Keystrokes in the same text cell make one step; anything else
      // (buttons, pasting, another cell) starts a new one.
      const now = Date.now();
      const el = document.activeElement as HTMLInputElement | null;
      const field =
        el?.tagName === "INPUT" && (el.dataset.task || "plan" in el.dataset)
          ? el.id || null
          : null;
      const typing =
        field !== null &&
        field === lastChange.current.field &&
        now - lastChange.current.at < 1500;
      if (!typing || !past.current.length) {
        past.current.push(latest.current);
        if (past.current.length > 100) past.current.shift();
      }
      lastChange.current = { at: now, field };
      future.current = [];
      setHistoryTick((n) => n + 1);
    }
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

  function travel(back: boolean) {
    const from = back ? past.current : future.current;
    const to = back ? future.current : past.current;
    const plan = from.pop();
    if (!plan || saving) return;
    to.push(latest.current);
    lastChange.current = { at: 0, field: null }; // the next edit is a new step
    setSelected(new Set());
    setAnchor(null);
    setActive(null);
    setFolded(new Set()); // phase codes may differ in the restored plan
    document
      .querySelectorAll<HTMLInputElement>(".pred-search")
      .forEach((input) => (input.value = ""));
    // Half-typed cells belong to the plan being left.
    setDurations({});
    setTyped({});
    setEditing(null);
    setRequest(null);
    setUnlinked(null);
    setDraft(plan, true);
    // Back at what is saved: nothing left to save.
    if (stableJson(cleaned(plan)) === stableJson(cleaned(state.plan))) {
      setDirty(false);
      setTimeline({ schedule: state.schedule, phases: state.phases ?? [] });
      setFresh(true);
      setProblem(null);
      try {
        sessionStorage.removeItem(storeKey);
      } catch {
        // Nothing to clean.
      }
    }
    setNotice(back ? "Se deshizo el último cambio." : "Se rehízo el cambio.");
    setHistoryTick((n) => n + 1);
  }

  function onUndoKeys(e: React.KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const redo = key === "y" || (key === "z" && e.shiftKey);
    if (key !== "z" && !redo) return;
    // Text that is not in the plan yet keeps the field's own undo: other
    // fields (a new phase name, dates being picked), a predecessor still
    // being typed, or a duration that is not valid yet.
    const target = e.target as HTMLInputElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      // Cells whose text is already in the plan go through its history.
      if (!target.dataset.task && !("plan" in target.dataset)) return;
      if (target.classList.contains("pred-search") && target.value) return;
      if (
        target.dataset.field === "duration" &&
        durations[Number(target.dataset.task)] !== undefined
      )
        return;
    }
    e.preventDefault();
    travel(!redo);
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
    for (const [id, entry] of Object.entries(typed))
      if (present.has(+id) && entry.error)
        errors[+id] = { ...errors[+id], links: entry.error };
    // Saved activities keep their name: clearing it is an error, not a delete.
    for (const t of draft.tasks)
      if (saved.has(t.id) && !t.name.trim())
        errors[t.id] = {
          ...errors[t.id],
          name: "Escribe un nombre o elimina la actividad.",
        };
    for (const [id, raw] of Object.entries(durations))
      if (!present.has(+id)) continue;
      else if (!/^\d{1,4}$/.test(raw.trim()) || Number(raw) > 3650)
        errors[+id] = {
          ...errors[+id],
          duration: "Escribe días laborables enteros (0 para un hito).",
        };
    return errors;
  }, [durations, draft.tasks, saved, typed]);

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
          startChecked.current = true;
        }
      } catch (e) {
        if (live) {
          setNotice("");
          failedDraft.current = draft;
          setProblem({
            message: cleanError(e),
            info: (e as Error & { info?: ErrorInfo }).info,
          });
        }
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
    lastChange.current = { at: 0, field: null }; // its own undo step
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

  // As in Project: typing a start sets «no empezar antes de» that date;
  // typing a finish changes the duration, counting working days.
  function setStart(id: number, value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    const t = tasks.get(id)!;
    // Retrying the same activity keeps what «Dejarla como estaba» restores.
    setRequest((r) =>
      r && r.id === id
        ? { ...r, value }
        : { id, value, before: t.earliest, removed: [] },
    );
    // If the draft already failed before this edit, a failure is not its.
    // A retry on the same activity whose failure was already its own keeps
    // being attributed to it.
    const retry = request?.id === id && !startChecked.current;
    startChecked.current = !!problem && !retry;
    patchTask(id, { earliest: value });
    if (!workdays(value, value, draft, t.calendar))
      setNotice(
        `El ${shortDate(value)} no es laborable para esta actividad: se pasa al siguiente día laborable posible.`,
      );
  }
  function setFinish(id: number, value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    const t = tasks.get(id)!;
    const start = computed.get(id)?.start ?? t.earliest ?? draft.start;
    if (!value) return;
    if (value < start) {
      setNotice(
        `No se cambió: el fin no puede ser anterior al inicio (${shortDate(start)}).`,
      );
      return;
    }
    if (!workdays(value, value, draft, t.calendar)) {
      setNotice(
        `No se cambió: el ${shortDate(value)} no es día laborable para esta actividad.`,
      );
      return;
    }
    const length = workdays(start, value, draft, t.calendar);
    if (length > 3650) {
      setNotice("No se cambió: la duración no puede pasar de 3650 días.");
      return;
    }
    const { [id]: _, ...rest } = durations;
    setDurations(rest);
    // A delivery date set under «Terminar exactamente el» moves with the
    // typed finish instead of being dropped.
    patchTask(id, {
      duration: Math.max(1, length),
      ...(t.fixed_finish ? { fixed_finish: value } : {}),
    });
  }

  function commitTyped(id: number, input: HTMLInputElement) {
    const text = input.value.trim();
    if (!text) {
      setTyped(({ [id]: _, ...rest }) => rest);
      return;
    }
    const t = tasks.get(id)!;
    const picked = pickList.find((o) => o.text === text);
    if (picked && t.links.some((l) => l.predecessor === picked.id)) {
      setTyped(({ [id]: _, ...rest }) => rest);
      input.value = "";
      return;
    }
    const {
      links: parsed,
      error,
      explicit = [],
    } = picked
      ? picked.id === id
        ? { links: [], error: "Una actividad no puede depender de sí misma." }
        : {
            links: [
              {
                predecessor: picked.id,
                relation: "FS" as const,
                lag: 0,
              },
            ],
            error: "",
          }
      : parsePredecessors(text, draft.tasks, id);
    if (error) {
      // Kept with its text, so it survives folding the phase.
      setTyped({ ...typed, [id]: { error, text } });
      return;
    }
    // An existing predecessor named again without a relation or lag
    // keeps its settings.
    const links = parsed.filter(
      (l) =>
        explicit.includes(l.predecessor) ||
        !t.links.some((x) => x.predecessor === l.predecessor),
    );
    const others = t.links.filter(
      (l) => !links.some((x) => x.predecessor === l.predecessor),
    );
    patchTask(id, { links: [...others, ...links] });
    setTyped(({ [id]: _, ...rest }) => rest);
    input.value = "";
  }

  function startDrag(e: React.PointerEvent, id: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    // Commit any open cell first, against the dates it was opened with.
    (document.activeElement as HTMLElement | null)?.blur();
    rowsRef.current?.setPointerCapture(e.pointerId);
    setDrag({
      from: id,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
    });
  }

  function finishDrag(e: React.PointerEvent) {
    if (!drag) return;
    const moved = Math.abs(drag.x - drag.x0) + Math.abs(drag.y - drag.y0);
    const from = drag.from;
    setDrag(null);
    if (moved < 6) {
      setActive({ kind: "task", id: from });
      return;
    }
    dragged.current = true;
    setTimeout(() => (dragged.current = false), 0);
    const target = (
      document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    )?.closest<HTMLElement>("[data-row-task]");
    const to = Number(target?.dataset.rowTask);
    if (!to || to === from) return;
    if (!tasks.get(to)?.name.trim() || !tasks.get(from)?.name.trim()) {
      setNotice("Ponle nombre a la actividad antes de enlazarla.");
      return;
    }
    const t = tasks.get(to)!;
    if (t.links.some((l) => l.predecessor === from)) {
      setNotice(
        `«${names.get(to)}» ya depende de «${names.get(from)}». Cambia cómo se relacionan en el detalle de la actividad.`,
      );
      return;
    }
    patchTask(to, {
      links: [...t.links, { predecessor: from, relation: "FS", lag: 0 }],
    });
    setNotice(
      `Vínculo añadido: «${names.get(to)}» empezará cuando termine «${names.get(from)}».`,
    );
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
    if (unlinked && drop.has(unlinked.id)) setUnlinked(null);
    setTyped((raw) =>
      Object.fromEntries(Object.entries(raw).filter(([id]) => !drop.has(+id))),
    );
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
    lastChange.current = { at: 0, field: null }; // its own undo step
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
      lastChange.current = { at: 0, field: null };
      setNotice("Cronograma guardado.");
      setUnlinked(null);
      setRequest(null);
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
  // Below this the dates don't fit; the planner's own width decides it.
  const narrow = width < 620;
  const canResize = !narrow && width - 240 - FIXED_COLS > 260;
  // The chosen widths, shrunk if needed so at least 240 px of Gantt shows.
  const room = Math.max(240, width - 240 - FIXED_COLS);
  // As chosen, within the room left for them: «Actividad» first, then
  // «Predecesoras»; each keeps at least 120 px.
  const shownName = Math.min(Math.max(cols.name, 120), room - 120);
  const shown = {
    name: shownName,
    preds: Math.min(Math.max(cols.preds, 120), room - shownName),
  };
  // A resize moves the edge one to one, up to the room available.
  const resize = (column: "name" | "preds", value: number) =>
    setCols((c) => ({
      ...c,
      [column]: clampCol(
        Math.min(value, column === "name" ? room - 120 : room - shown.name),
      ),
    }));
  const tableWidth = narrow
    ? Math.max(320, width - 40)
    : FIXED_COLS + shown.name + shown.preds;
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
  // Why a start typed in the table is not honoured, if it is not.
  const startHold = useMemo(() => {
    if (!request) return null;
    const t = tasks.get(request.id);
    if (!t || t.earliest !== request.value) return null;
    // The recalculation failed because of it: offer to undo.
    if (!fresh)
      // Only for the preview of this very draft, wherever the error is.
      return problem && failedDraft.current === draft && !startChecked.current
        ? { t, d: undefined, why: null as string | null, failed: true }
        : null;
    const row = computed.get(request.id);
    if (!row) return null;
    // Nothing can start before the project, so that is the floor.
    const early = request.value < draft.start;
    const floor = firstWorkday(
      early ? draft.start : request.value,
      draft,
      t.calendar,
    );
    if (!floor) return null;
    const held = row.start > floor;
    if (!held && !early) return { t, d: undefined, why: null, honoured: true };
    // Before the project start, that is the reason, whatever else holds it.
    const d = held && !early ? row.driver : undefined;
    const why = early
      ? `el proyecto empieza el ${shortDate(draft.start)}`
      : d?.type === "link"
        ? `depende de «${names.get(d.predecessor)}», que la deja empezar el ${shortDate(row.start)}`
        : d?.type === "fixed_finish"
          ? `debe terminar el ${shortDate(d.date)} y dura ${days(row.duration)}`
          : null;
    return why ? { t, d, why } : null;
  }, [request, tasks, fresh, problem, computed, draft, names]);
  // Once honoured, its undo is no longer offered.
  useEffect(() => {
    if (startHold && "honoured" in startHold) setRequest(null);
  }, [startHold]);

  const pickList = draft.tasks
    .filter((t) => t.name.trim())
    .map((t) => ({ id: t.id, text: `${t.wbs} · ${t.name}` }));
  const baselineSet = Object.keys(draft.baseline ?? {}).length > 0;

  return (
    <section className="panel planner" onKeyDown={onUndoKeys}>
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
          onClick={() => travel(true)}
          disabled={!past.current.length}
          title="Deshacer (Ctrl+Z)"
          aria-keyshortcuts="Control+Z"
        >
          <Undo2 size={15} /> Deshacer
        </button>
        <button
          onClick={() => travel(false)}
          disabled={!future.current.length}
          title="Rehacer (Ctrl+Y)"
          aria-keyshortcuts="Control+Y"
        >
          <Redo2 size={15} /> Rehacer
        </button>
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
        <button
          onClick={() => setPrinting(true)}
          disabled={!timeline.schedule.length || !fresh || printing}
          title={
            !fresh
              ? "Espera a que se recalculen las fechas"
              : "Imprime el cronograma o guárdalo en PDF"
          }
        >
          <Printer size={15} /> Imprimir / PDF
        </button>
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
      {unlinked &&
        tasks.get(unlinked.id) &&
        !tasks.get(unlinked.id)!.quantity && (
          <div className="notice planner-problem" role="status">
            <span>
              «{names.get(unlinked.id)}» ahora dura lo que escribiste; antes se
              calculaba con cantidades.
            </span>
            <button
              disabled={saving}
              onClick={() => {
                const { [unlinked.id]: _, ...rest } = durations;
                setDurations(rest);
                patchTask(unlinked.id, { quantity: unlinked.quantity });
                setUnlinked(null);
              }}
            >
              Volver a calcularla con cantidades
            </button>
            <button onClick={() => setUnlinked(null)}>Entendido</button>
          </div>
        )}
      {(() => {
        if (!request || !startHold || "honoured" in startHold) return null;
        const { t, d, why } = startHold;
        return (
          <div className="notice planner-problem" role="status">
            <span>
              {why
                ? `«${names.get(request.id)}» no puede empezar el ${shortDate(request.value)} porque ${why}.`
                : `El nuevo inicio de «${names.get(request.id)}» (${shortDate(request.value)}) no se puede aplicar.`}
            </span>
            {d?.type === "link" && (
              <button
                disabled={saving}
                onClick={() => {
                  setRequest({
                    ...request,
                    removed: [
                      ...request.removed,
                      ...t.links.filter((l) => l.predecessor === d.predecessor),
                    ],
                  });
                  patchTask(request.id, {
                    links: t.links.filter(
                      (l) => l.predecessor !== d.predecessor,
                    ),
                  });
                }}
              >
                Quitar el vínculo con «{names.get(d.predecessor)}»
              </button>
            )}
            <button
              disabled={saving}
              onClick={() => {
                // Back to how it was: date and any link taken out here.
                patchTask(request.id, {
                  earliest: request.before ?? null,
                  links: [
                    ...t.links,
                    ...request.removed.filter(
                      (l) =>
                        tasks.has(l.predecessor) &&
                        !t.links.some((x) => x.predecessor === l.predecessor),
                    ),
                  ],
                });
                setRequest(null);
              }}
            >
              Dejarla como estaba
            </button>
          </div>
        );
      })()}
      {(() => {
        // A cell error inside a folded phase still blocks saving: say where.
        const shown = new Set(
          visible.flatMap((r) => (r.kind === "task" ? [r.id] : [])),
        );
        const hidden = Object.keys(localErrors)
          .map(Number)
          .find((id) => !shown.has(id));
        if (hidden === undefined) return null;
        return (
          <div className="error planner-problem" role="alert">
            Hay un dato por corregir en «{names.get(hidden)}», dentro de una
            fase plegada.
            <button
              onClick={() => {
                setFolded(new Set());
                setActive({ kind: "task", id: hidden });
              }}
            >
              Mostrar
            </button>
          </div>
        );
      })()}
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
          className={
            "planner-scroll" +
            (narrow ? " compact" : "") +
            (width < 560 ? " narrow" : "")
          }
          ref={scroller}
          onPaste={onPaste}
          style={{
            ["--table-w" as string]: tableWidth + "px",
            ["--name-w" as string]: shown.name + "px",
            ["--preds-w" as string]: shown.preds + "px",
          }}
        >
          <div
            className="planner-canvas"
            style={{ width: tableWidth + timelineWidth }}
          >
            <div className="planner-row planner-head" style={{ height: HEAD }}>
              <div className="planner-cells">
                <span />
                <span>EDT</span>
                <span className="resizable">
                  Actividad
                  {canResize && (
                    <ColumnResizer
                      label="Actividad"
                      value={shown.name}
                      onChange={(name) => resize("name", name)}
                      reset={() =>
                        setCols((c) => ({ ...c, name: DEFAULT_COLS.name }))
                      }
                    />
                  )}
                </span>
                <span title="Duración en días laborables">Días</span>
                <span>Inicio</span>
                <span>Fin</span>
                <span className="resizable">
                  Predecesoras
                  {canResize && (
                    <ColumnResizer
                      label="Predecesoras"
                      value={shown.preds}
                      onChange={(preds) => resize("preds", preds)}
                      reset={() =>
                        setCols((c) => ({ ...c, preds: DEFAULT_COLS.preds }))
                      }
                    />
                  )}
                </span>
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
              className={"planner-rows" + (drag ? " linking" : "")}
              ref={rowsRef}
              style={{ height: Math.max(1, visible.length) * ROW }}
              onPointerMove={(e) =>
                drag && setDrag({ ...drag, x: e.clientX, y: e.clientY })
              }
              onPointerUp={finishDrag}
              onPointerCancel={() => setDrag(null)}
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
                {drag &&
                  rowsRef.current &&
                  (() => {
                    const box = rowsRef.current.getBoundingClientRect();
                    return (
                      <line
                        className="drag-link"
                        x1={drag.x0 - box.left - tableWidth}
                        y1={drag.y0 - box.top}
                        x2={drag.x - box.left - tableWidth}
                        y2={drag.y - box.top}
                      />
                    );
                  })()}
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
                            id={`phase-${r.code}-name`}
                            data-plan=""
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
                    data-row-task={r.id}
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
                              ? "Calculada con cantidades. Si escribes otra, se usa la tuya."
                              : undefined)
                          }
                          data-quantity={t.quantity ? "" : undefined}
                          // Typing replaces the value instead of adding to it.
                          onFocus={(e) => e.currentTarget.select()}
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
                              // A duration typed over one calculated with
                              // quantities wins, as in Project; it can be undone.
                              // The same number as calculated: keep the link.
                              if (
                                t.quantity &&
                                Number(raw) === (c?.duration ?? t.duration)
                              )
                                return;
                              if (t.quantity)
                                setUnlinked({ id: r.id, quantity: t.quantity });
                              patchTask(r.id, {
                                duration: Number(raw),
                                ...(t.quantity ? { quantity: null } : {}),
                              });
                            } else setDurations({ ...durations, [r.id]: raw });
                          }}
                          onKeyDown={(e) => onCellKey(e, r.id)}
                        />
                      </span>
                      {(["start", "finish"] as const).map((field) => {
                        const value = c ? c[field] : "";
                        const isMilestone = !!c?.milestone;
                        const locked =
                          !c ||
                          (field === "finish" &&
                            (isMilestone ||
                              !!t.quantity ||
                              t.links.some(
                                (l) =>
                                  l.relation === "FF" || l.relation === "SF",
                              )));
                        // Waiting for the recalculation: stays focusable.
                        const waiting = !locked && field === "finish" && !fresh;
                        const open =
                          editing?.id === r.id && editing.field === field;
                        return (
                          <span className="date" key={field}>
                            {open ? (
                              <input
                                type="date"
                                className="cell date-input"
                                autoFocus
                                aria-label={`${field === "start" ? "Inicio" : "Fin"} de ${t.name || "la actividad"}`}
                                defaultValue={editing.value}
                                onBlur={(e) => {
                                  if (
                                    e.target.value &&
                                    e.target.value !== editing.value
                                  )
                                    (field === "start" ? setStart : setFinish)(
                                      r.id,
                                      e.target.value,
                                    );
                                  setEditing(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter" && e.key !== "Escape")
                                    return;
                                  e.preventDefault();
                                  if (e.key === "Enter")
                                    (e.target as HTMLInputElement).blur();
                                  else {
                                    // Cancel: nothing to commit if it blurs.
                                    (e.target as HTMLInputElement).value =
                                      editing.value;
                                    setEditing(null);
                                  }
                                  // Back to the date cell, for the next edit.
                                  requestAnimationFrame(() =>
                                    document
                                      .getElementById(`date-${r.id}-${field}`)
                                      ?.focus(),
                                  );
                                }}
                              />
                            ) : (
                              <button
                                id={`date-${r.id}-${field}`}
                                className="cell date-button"
                                disabled={locked}
                                aria-disabled={waiting || undefined}
                                title={
                                  value
                                    ? `${longDate(value)}. ${
                                        waiting
                                          ? "Espera a que se recalculen las fechas."
                                          : !locked
                                            ? "Pulsa para cambiarla."
                                            : isMilestone
                                              ? "Un hito termina el mismo día que empieza."
                                              : t.quantity
                                                ? "La fija la duración calculada con cantidades."
                                                : "La fija un vínculo «Termina cuando…»; cambia la duración."
                                      }`
                                    : undefined
                                }
                                aria-label={`${field === "start" ? "Inicio" : "Fin"} de ${t.name || "la actividad"}: ${value ? longDate(value) : "sin fecha"}`}
                                onClick={() =>
                                  !waiting &&
                                  setEditing({ id: r.id, field, value })
                                }
                              >
                                {!c
                                  ? "—"
                                  : field === "finish" && isMilestone
                                    ? "Hito"
                                    : cellDate(value)}
                              </button>
                            )}
                          </span>
                        );
                      })}
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
                          placeholder={t.links.length ? "+" : "Nº o nombre…"}
                          defaultValue={typed[r.id]?.text}
                          onChange={(e) => {
                            // A suggestion picked from the list is added at once.
                            const match = pickList.find(
                              (o) => o.text === e.target.value,
                            );
                            if (match) commitTyped(r.id, e.target);
                            else if (typed[r.id])
                              setTyped(({ [r.id]: _, ...rest }) => rest);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitTyped(r.id, e.currentTarget);
                            }
                            // Escape throws away what was typed.
                            if (e.key === "Escape" && e.currentTarget.value) {
                              e.preventDefault();
                              e.currentTarget.value = "";
                              setTyped(({ [r.id]: _, ...rest }) => rest);
                            }
                          }}
                          onBlur={(e) => commitTyped(r.id, e.currentTarget)}
                        />
                        {typed[r.id] && (
                          <button
                            type="button"
                            className="pred-clear"
                            title="Borrar lo escrito"
                            aria-label={`Borrar la predecesora escrita en ${t.name || "la actividad"}`}
                            // Before the field's blur commits the text again.
                            onPointerDown={(e) => e.preventDefault()}
                            onClick={() => {
                              const field = document.getElementById(
                                `cell-${r.id}-links`,
                              ) as HTMLInputElement | null;
                              if (field) field.value = "";
                              setTyped(({ [r.id]: _, ...rest }) => rest);
                              field?.focus();
                            }}
                          >
                            <X size={13} />
                          </button>
                        )}
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
                            title="Arrastra hasta otra barra para que empiece después de este hito"
                            onPointerDown={(e) => startDrag(e, r.id)}
                            onClick={() => {
                              // Keyboard and assistive activation; a drag
                              // that just ended must not also open details.
                              if (!dragged.current)
                                setActive({ kind: "task", id: r.id });
                            }}
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
                            title="Arrastra hasta otra barra para que empiece cuando termine esta"
                            onPointerDown={(e) => startDrag(e, r.id)}
                            onClick={() => {
                              // Keyboard and assistive activation; a drag
                              // that just ended must not also open details.
                              if (!dragged.current)
                                setActive({ kind: "task", id: r.id });
                            }}
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
                patch={(change) => {
                  // A duration set from the panel replaces any value
                  // half-typed in the table cell.
                  // A new quantity choice replaces any pending undo.
                  if ("quantity" in change && unlinked?.id === activeTask.id)
                    setUnlinked(null);
                  if ("duration" in change || change.quantity)
                    setDurations(({ [activeTask.id]: _, ...rest }) => rest);
                  patchTask(activeTask.id, change);
                }}
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
      {printing &&
        createPortal(
          <div className="print-root">
            <PrintSchedule
              title={state.project.name}
              rows={outlineRows(tree, new Set())}
              schedule={computed}
              phases={new Map(timeline.phases.map((p) => [p.code, p]))}
              names={names}
              unsaved={dirty}
            />
          </div>,
          document.body,
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
              Para mover una actividad basta con cambiar su Inicio o su Fin en
              la tabla. Usa estas fechas solo si hay una que no se puede mover,
              por ejemplo la llegada de un material o una entrega pactada.
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

          {task.earliest &&
            task.fixed_finish &&
            !task.quantity &&
            task.duration > 0 &&
            // Only when nothing else moves the start: otherwise the span
            // between the two dates is not the one the activity can use.
            !task.links.length &&
            task.earliest >= plan.start &&
            task.fixed_finish >= task.earliest &&
            workdays(
              task.fixed_finish,
              task.fixed_finish,
              plan,
              task.calendar,
            ) > 0 &&
            workdays(task.earliest, task.fixed_finish, plan, task.calendar) <=
              3650 &&
            Math.max(
              1,
              workdays(task.earliest, task.fixed_finish, plan, task.calendar),
            ) !== task.duration && (
              <p className="notice">
                Del {shortDate(task.earliest)} al {shortDate(task.fixed_finish)}{" "}
                hay{" "}
                {days(
                  Math.max(
                    1,
                    workdays(
                      task.earliest,
                      task.fixed_finish,
                      plan,
                      task.calendar,
                    ),
                  ),
                )}{" "}
                de trabajo, pero la actividad dura {days(task.duration)}.
                <button
                  onClick={() =>
                    patch({
                      duration: Math.max(
                        1,
                        workdays(
                          task.earliest!,
                          task.fixed_finish!,
                          plan,
                          task.calendar,
                        ),
                      ),
                    })
                  }
                >
                  Que dure del {shortDate(task.earliest)} al{" "}
                  {shortDate(task.fixed_finish)}
                </button>
              </p>
            )}

          {/* Only useful when the project has more than its own calendar. */}
          {(!!task.calendar || !!Object.keys(plan.calendars ?? {}).length) && (
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
                Por ejemplo, un curado que sigue el fin de semana. Los
                calendarios se crean en «Calendario y seguimiento».
              </p>
            </details>
          )}

          <details className="details-card" open={!!task.quantity}>
            <summary>Calcular la duración con cantidades (opcional)</summary>
            <p className="muted">
              En vez de escribir los días, la app los calcula con lo que
              cuantificaste: cantidad ÷ lo que avanza la cuadrilla por día. Por
              ejemplo, 30 m³ de concreto a 5 m³ por día son 6 días. Si cambian
              las cantidades, la duración se actualiza sola.
            </p>
            {!sources.length && !task.quantity && (
              <p className="details-empty">
                Todavía no hay tablas cuantificadas en este proyecto. Prepáralas
                en «Tablas de origen» y vuelve aquí.
              </p>
            )}
            <label>
              Tabla de cantidades
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
                <option value="">No, escribo los días en la tabla</option>
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
                  Qué se mide
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
                  Avance de la cuadrilla por día (
                  {unitLabel(task.quantity.unit)}/día)
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

/** The whole schedule laid out for paper: every phase unfolded, the table
 * on the left and the Gantt scaled to the page width. The browser's print
 * dialog prints it or saves it as PDF. */
function PrintSchedule({
  title,
  rows,
  schedule,
  phases,
  names,
  unsaved,
}: {
  title: string;
  rows: Row[];
  schedule: Map<number, Scheduled>;
  phases: Map<string, Phase>;
  names: Map<number, string>;
  unsaved: boolean;
}) {
  const spans = [
    ...[...schedule.values()].map((r) => [r.start, r.finish]),
    ...[...phases.values()].map((p) => [p.start, p.finish]),
  ];
  if (!spans.length) return null;
  // A day of margin on each side, so nothing touches the edges.
  const origin = Math.min(...spans.map(([s]) => toDay(s))) - 1;
  const end = Math.max(...spans.map(([, f]) => toDay(f))) + 2;
  const span = Math.max(1, end - origin);
  const pos = (date: string, after = false) =>
    ((toDay(date) + (after ? 1 : 0) - origin) / span) * 100;
  // Weeks for short schedules, months otherwise.
  const ticks: { left: number; text: string }[] = [];
  // Weeks for short schedules; then months, quarters or years, so the
  // labels never crowd the page.
  const weekly = span <= 70;
  const months = span / 30.4;
  const step = months <= 14 ? 1 : months <= 40 ? 3 : 12;
  for (let d = origin; d < end; d++) {
    const date = new Date(d * DAY);
    const tick = weekly
      ? date.getUTCDay() === 1
      : date.getUTCDate() === 1 && date.getUTCMonth() % step === 0;
    if (tick)
      ticks.push({
        left: ((d - origin) / span) * 100,
        text:
          step === 12 && !weekly
            ? String(date.getUTCFullYear())
            : label(
                fromDay(d),
                weekly
                  ? { day: "numeric", month: "short" }
                  : { month: "short", year: "2-digit" },
              ),
      });
  }
  const first = fromDay(origin + 1);
  const last = fromDay(end - 2);
  // Short dates with the year when the schedule crosses one.
  const crosses = first.slice(0, 4) !== last.slice(0, 4);
  const day = (s: string) => cellDate(s) + (crosses ? ` ${s.slice(2, 4)}` : "");
  return (
    <div className="print-sheet">
      <div className="print-header">
        <div>
          <h1>{title}</h1>
          <p>
            Cronograma del {longDate(first)} al {longDate(last)}
            {unsaved && " · incluye cambios sin guardar"}
          </p>
        </div>
        <p className="print-meta">
          Impreso el {longDate(today())}
          <br />
          CIVIL BIM Planner
        </p>
      </div>
      <table className="print-table">
        <thead>
          <tr>
            <th className="p-wbs">EDT</th>
            <th className="p-name">Actividad</th>
            <th className="p-num">Días</th>
            <th className="p-date">Inicio</th>
            <th className="p-date">Fin</th>
            <th className="p-gantt">
              <div className="print-axis">
                {ticks.map((t) => (
                  <span key={t.left} style={{ left: `${t.left}%` }}>
                    {t.text}
                  </span>
                ))}
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            if (r.kind === "phase") {
              const p = phases.get(r.code);
              return (
                <tr key={"p" + r.code} className="p-phase">
                  <td className="p-wbs">{r.code}</td>
                  <td
                    className="p-name"
                    style={{ paddingLeft: 4 + r.depth * 10 }}
                  >
                    {r.name}
                  </td>
                  <td className="p-num">{p ? p.duration : ""}</td>
                  <td className="p-date">{p ? day(p.start) : ""}</td>
                  <td className="p-date">{p ? day(p.finish) : ""}</td>
                  <td className="p-gantt">
                    <div className="print-track">
                      {ticks.map((t) => (
                        <i
                          key={t.left}
                          className="print-grid"
                          style={{ left: `${t.left}%` }}
                        />
                      ))}
                      {p && (
                        <b
                          className="print-phase"
                          style={{
                            left: `${pos(p.start)}%`,
                            width: `${pos(p.finish, true) - pos(p.start)}%`,
                          }}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            }
            const c = schedule.get(r.id);
            if (!c) return null;
            return (
              <tr key={r.id}>
                <td className="p-wbs">{c.wbs}</td>
                <td
                  className="p-name"
                  style={{ paddingLeft: 4 + r.depth * 10 }}
                >
                  {names.get(r.id)}
                </td>
                <td className="p-num">{c.milestone ? "Hito" : c.duration}</td>
                <td className="p-date">{day(c.start)}</td>
                <td className="p-date">{day(c.finish)}</td>
                <td className="p-gantt">
                  <div className="print-track">
                    {ticks.map((t) => (
                      <i
                        key={t.left}
                        className="print-grid"
                        style={{ left: `${t.left}%` }}
                      />
                    ))}
                    {c.milestone ? (
                      <b
                        className={
                          "print-milestone" + (c.critical ? " critical" : "")
                        }
                        style={{ left: `${pos(c.start, !!c.at_day_end)}%` }}
                      />
                    ) : (
                      <b
                        className={
                          "print-bar" + (c.critical ? " critical" : "")
                        }
                        style={{
                          left: `${pos(c.start)}%`,
                          width: `${Math.max(0.3, pos(c.finish, true) - pos(c.start))}%`,
                        }}
                      />
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="print-legend">
        <span>
          <b className="print-bar" /> Actividad
        </span>
        <span>
          <b className="print-bar critical" /> Ruta crítica
        </span>
        <span>
          <b className="print-phase" /> Fase
        </span>
        <span>
          <b className="print-milestone" /> Hito
        </span>
        <span>Duraciones en días laborables.</span>
      </p>
    </div>
  );
}
