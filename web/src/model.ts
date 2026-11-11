export type Row = Record<string, string | number | null>;
export type QuantityTab = "Resumen" | "Detalle" | "Incidencias";
export type Page =
  | "Resumen"
  | "Proyectos"
  | "Tablas de origen"
  | "Cuantificación"
  | "Programación"
  | "Reportes";
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
  Object.values(s?.results ?? {}).flatMap((x) => x.issues);
