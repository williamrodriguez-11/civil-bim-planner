export type Row = Record<string, string | number | null>;
export type QuantityTab = "Resumen" | "Detalle" | "Incidencias";
export type Page =
  | "Resumen"
  | "Proyectos"
  | "Tablas de origen"
  | "Cuantificación"
  | "Programación"
  | "Reportes"
  | "Papelera";
export interface Project {
  id: number;
  name: string;
  description: string;
  kind: string;
  location: string;
  status: string;
  created: string;
  revision: number;
  deleted_at: string | null;
}
export interface Options {
  header_row: number;
  sheet: string | number;
  delimiter: string;
  encoding: string;
  trim: boolean;
}
export interface Mapping {
  category_field?: string;
  category_confirmed?: boolean;
  attributes?: string[];
  category: string;
  fields: Record<string, string>;
  units: Record<string, string>;
  decimal: string;
  mode: string;
  direct_basis: string;
  excluded_rows: number[];
  filter_column: string | null;
  filter_values: string[];
  family: string;
  material: string;
  strength: string;
}
export interface Source {
  id: number;
  name: string;
  created: string;
  sheet: string;
  options: Options;
  mapping: Mapping | null;
  /** The server found that the category column repeats the level. */
  levels_as_category?: boolean;
}
export interface Table {
  columns: string[];
  fields: { name: string; kind: string; empty: number; unit: string | null }[];
  count: number;
  duplicates: number;
  indexes: number[];
  rows: Row[];
}
export interface Link {
  predecessor: number;
  relation: string;
  lag: number;
}
export interface Task {
  id: number;
  name: string;
  wbs: string;
  duration: number;
  earliest: string | null;
  fixed_finish?: string | null;
  progress: number;
  links: Link[];
  quantity: null | {
    table: number;
    unit: string;
    level: string;
    category?: string;
    rate: number;
  };
}
export interface Plan {
  start: string;
  status_date?: string | null;
  weekdays: number[];
  holidays: string[];
  tasks: Task[];
  groups: Record<string, string>;
}
export interface Scheduled extends Task {
  start: string;
  finish: string;
  critical: boolean;
  slack: number;
  planned: number;
  amount: number | null;
}
export interface State {
  project: Project;
  tables: Source[];
  trashed_tables: Pick<Source, "id" | "name" | "sheet">[];
  templates: Record<string, Mapping>;
  results: Record<number, { detail: Row[]; issues: Row[] }>;
  issue_review?: Record<number, {
    pending: number[];
    history: { id: string; row: Row; archived_at: string; current: boolean }[];
  }>;
  plan: Plan;
  schedule: Scheduled[];
  events: { message: string; created: string }[];
  reports: { id: number; created: string; name: string }[];
}
export type Mutation = (
  path: string,
  body: object | FormData,
  method?: string,
) => Promise<{ id: number }>;
export const fmt = (n: number) =>
  n.toLocaleString("es-CO", { maximumFractionDigits: 3 });
export const dateLabel = (s: string) =>
  new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(s.slice(0, 10) + "T12:00:00"));
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch("/api" + path, init);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) {
      window.dispatchEvent(new Event("civil-session-expired"));
    }
    const data = await res.json().catch(() => ({}));
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : Array.isArray(data.detail)
          ? data.detail
              .map(
                (x: { loc: unknown[]; msg: string }) =>
                  x.loc.join(".") + " · " + x.msg,
              )
              .join(" / ")
          : "No se pudo completar la operación.",
    );
  }
  return res.json();
}
export const cleanError = (e: unknown) =>
  e instanceof Error ? e.message : "Error de conexión.";
export const details = (s: State | null) =>
  Object.values(s?.results ?? {}).flatMap((x) => x.detail);
export const issues = (s: State | null) =>
  Object.entries(s?.results ?? {}).flatMap(([id, result]) =>
    s?.issue_review?.[Number(id)]?.pending.map((index) => result.issues[index]) ??
    result.issues,
  );
export interface Usage {
  total: number;
  trash: number;
  reports: number;
  projects: Record<string, number>;
  database?: { used: number; limit: number };
}
export const bytesLabel = (n: number) =>
  n < 1024 * 1024
    ? Math.max(n ? 1 : 0, Math.round(n / 1024)) + " KB"
    : (n / 1024 / 1024).toLocaleString("es-CO", { maximumFractionDigits: 1 }) +
      " MB";
const elementWords: [string, RegExp][] = [
  ["Columnas", /\b(columnas?|pilares?)\b/],
  ["Vigas", /\bvigas?\b/],
  ["Losas", /\b(losas?|placas? de entrepiso)\b/],
  ["Muros", /\bmuros?\b/],
  ["Zapatas", /\bzapatas?\b/],
  ["Pilotes", /\bpilotes?\b/],
  ["Escaleras", /\bescaleras?\b/],
];
/** Element named by a file or sheet, e.g. «CANT - COLUMNAS.csv» → Columnas. */
export function elementFromName(...names: string[]) {
  const text = names
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  const found = elementWords.filter(([, words]) => words.test(text));
  return found.length === 1 ? found[0][0] : "";
}
/** Tables whose «category from a column» repeats the level of each row.
 * The server compares every source row, including excluded and rejected ones. */
export function levelsAsCategories(state: State | null) {
  return (state?.tables ?? []).filter(
    (source) => !!source.mapping && !!source.levels_as_category,
  );
}
