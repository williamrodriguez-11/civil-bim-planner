import { useState } from "react";
import {
  Activity,
  ArrowRight,
  Box,
  CalendarDays,
  ChartColumn,
  Files,
  Layers3,
  MapPin,
  Plus,
  Ruler,
} from "lucide-react";
import { Blueprint } from "./Blueprint";
import {
  details,
  fmt,
  issues,
  type Page,
  type QuantityTab,
  type Row,
  type State,
} from "./model";
import { Empty, Grid } from "./shared";
import {
  measurementName,
  measurementTotal,
  summarizeMeasurements,
  unitLabel,
  type Measurement,
} from "./measurements";

function totalLabel(measure: Measurement) {
  const total = measurementTotal(measure);
  return total === null
    ? "Área incompleta"
    : fmt(total) + " " + unitLabel(measure.unit);
}
export function Overview({
  state,
  projects,
  go,
  create,
}: {
  state: State | null;
  projects: number;
  go: (p: Page) => void;
  create: () => void;
}) {
  const data = details(state),
    tables = state?.tables ?? [],
    tasks = state?.schedule ?? [],
    [groupBy, setGroupBy] = useState("Nivel"),
    [selectedKey, setSelectedKey] = useState("");
  const quantities = summarizeMeasurements(data);
  const selected =
    quantities.find((m) => m.key === selectedKey) ?? quantities[0];
  const groups = new Map<string, Row[]>();
  for (const row of data) {
    if (
      !selected ||
      (selected.category !== undefined && row.Categoría !== selected.category)
    )
      continue;
    const group = String(row[groupBy]);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(row);
  }
  const sums = Array.from(groups)
    .flatMap(([name, rows]) =>
      summarizeMeasurements(rows, [selected]).map((measure) => ({
        name,
        measure,
      })),
    )
    .sort(
      (a, b) =>
        (measurementTotal(b.measure) ?? -1) -
        (measurementTotal(a.measure) ?? -1),
    );
  const peak = sums.reduce(
    (max, g) => Math.max(max, measurementTotal(g.measure) ?? 0),
    0,
  );
  const errors = issues(state).filter((r) => r.Estado === "Rechazada").length,
    pending = tables.filter((s) => !s.mapping).length;
  const totalDays = tasks.reduce((n, t) => n + t.duration, 0);
  const stats = [
    {
      name: "Tablas importadas",
      value: tables.length,
      Icon: Files,
      caption: "Fuentes del proyecto",
      page: "Tablas de origen",
    },
    {
      name: "Elementos cuantificados",
      value: data.reduce((n, r) => n + Number(r.Elementos), 0),
      Icon: Layers3,
      caption: new Set(data.map((r) => r.Categoría)).size + " categorías",
      page: "Cuantificación",
    },
    {
      name: "Cantidades de obra",
      measurement: true,
      value: selected ? totalLabel(selected) : "—",
      Icon: Box,
      caption: selected
        ? measurementName(selected)
        : "ud · m lineales · m² · m³ · kg",
      page: "Cuantificación",
    },
    {
      name: "Actividades",
      value: tasks.length,
      Icon: CalendarDays,
      caption: totalDays
        ? fmt(
            tasks.reduce((n, t) => n + t.duration * t.progress, 0) / totalDays,
          ) + " % de avance ponderado"
        : "Sin avance registrado",
      page: "Programación",
    },
  ];
  const action = () => (state ? go("Tablas de origen") : create());
  return (
    <>
      <div className="hero">
        <div className="hero-text">
          <div className="eyebrow light">
            <span className="dot" />
            {state ? "PROYECTO ACTIVO" : "ESPACIO DE TRABAJO"}
          </div>
          <h2>{state ? state.project.name : "Tu centro de control BIM"}</h2>
          <p>
            {state
              ? state.project.description || state.project.kind
              : "Reúne tablas de Revit, cantidades de obra y programación en un mismo proyecto."}
          </p>
          {state?.project.location && (
            <small>
              <MapPin size={13} />
              {state.project.location}
            </small>
          )}
          <button className="accent" onClick={action}>
            {state ? <Files size={16} /> : <Plus size={16} />}{" "}
            {state ? "Importar tablas" : "Crear primer proyecto"}
          </button>
        </div>
        <Blueprint />
      </div>
      <div className="section-title outside">
        <h2>Indicadores del proyecto</h2>
        <small className="right">
          {projects} {projects === 1 ? "proyecto" : "proyectos"} en el espacio
        </small>
      </div>
      <div className="stats">
        {stats.map(({ name, value, caption, Icon, page, measurement }, i) =>
          measurement ? (
            <article
              className={"stat measure-stat tint" + i}
              key={name}
              aria-label={name}
            >
              <div>
                <span className="stat-icon">
                  <Icon size={19} />
                </span>
                {state && (
                  <button
                    title="Ver cantidades consolidadas"
                    onClick={() => go("Cuantificación")}
                  >
                    <ArrowRight size={14} />
                  </button>
                )}
              </div>
              <small>{name}</small>
              <strong>{value}</strong>
              {selected ? (
                <select
                  aria-label="Magnitud cuantificada"
                  value={selected.key}
                  onChange={(e) => setSelectedKey(e.target.value)}
                >
                  {quantities.map((m) => (
                    <option key={m.key} value={m.key}>
                      {measurementName(m)} ({unitLabel(m.unit)})
                    </option>
                  ))}
                </select>
              ) : (
                <span>{caption}</span>
              )}
            </article>
          ) : (
            <button
              key={name}
              onClick={() => (state ? go(page as Page) : create())}
              className={"stat tint" + i}
            >
              <div>
                <span className="stat-icon">
                  <Icon size={19} />
                </span>
                <ArrowRight size={14} />
              </div>
              <small>{name}</small>
              <strong>{typeof value === "number" ? fmt(value) : value}</strong>
              <span>{caption}</span>
            </button>
          ),
        )}
      </div>
      <div className="columns">
        <section className="panel">
          <div className="section-title">
            <ChartColumn />
            <h2>
              {selected
                ? "Distribución · " + measurementName(selected)
                : "Distribución de cantidades"}
            </h2>
          </div>
          <div className="tabs">
            {["Nivel", "Categoría"].map((k) => (
              <button
                key={k}
                aria-pressed={k === groupBy}
                onClick={() => setGroupBy(k)}
              >
                Por {k.toLowerCase()}
              </button>
            ))}
          </div>
          {sums.length ? (
            <div className="bars">
              {selected.measuredRows < selected.sourceRows && (
                <small>
                  {selected.measuredRows} de {selected.sourceRows} filas con
                  medición
                </small>
              )}
              {sums.map(({ name, measure }) => (
                <div key={name}>
                  <label>
                    {name}
                    <b>{totalLabel(measure)}</b>
                  </label>
                  {measurementTotal(measure) !== null && (
                    <i
                      style={{
                        width: (peak ? (measure.total / peak) * 100 : 0) + "%",
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="chart-empty">
              <ChartColumn size={27} />
              <b>Sin cantidades registradas</b>
              <small>Las cantidades validadas aparecerán aquí.</small>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="section-title">
            <Activity />
            <h2>Actividad reciente</h2>
          </div>
          {state?.events.length ? (
            <ol className="events">
              {state.events.slice(0, 5).map((e, i) => (
                <li key={i}>
                  <strong>{e.message}</strong>
                  <small>
                    {new Date(e.created.replace(" ", "T") + "Z").toLocaleString(
                      "es-CO",
                    )}
                  </small>
                </li>
              ))}
            </ol>
          ) : (
            <Empty title="Aún no hay movimientos">
              Aquí podrás seguir las importaciones, cálculos y reportes de tu
              proyecto.
            </Empty>
          )}
        </section>
      </div>
      {(pending > 0 || errors > 0) && (
        <div className="notice">
          <b>Revisión pendiente</b> · {pending} tablas por configurar · {errors}{" "}
          filas rechazadas{" "}
          <button
            onClick={() => go(pending ? "Tablas de origen" : "Cuantificación")}
          >
            Revisar <ArrowRight size={14} />
          </button>
        </div>
      )}
    </>
  );
}
export function Quantities({
  state,
  initialTab,
}: {
  state: State;
  initialTab?: QuantityTab;
}) {
  const all = details(state);
  const exceptions = issues(state);
  const [filters, setFilters] = useState<Record<string, string>>({}),
    [tab, setTab] = useState<QuantityTab>(
      initialTab ??
        (!all.length && exceptions.length ? "Incidencias" : "Resumen"),
    ),
    [group, setGroup] = useState("Nivel");
  const filtered = all.filter((r) =>
    Object.entries(filters).every(([k, v]) => !v || r[k] === v),
  );
  const measures = ["Volumen (m³)", "Longitud (m)", "Masa (kg)"];
  if (group === "Categoría" || filters["Categoría"]) measures.push("Área (m²)");
  const map = new Map<string, Row>();
  for (const r of filtered) {
    const k = String(r[group] || "Sin asignar"),
      v = map.get(k) ?? { [group]: k, Elementos: 0 };
    v.Elementos = Number(v.Elementos) + Number(r.Elementos);
    for (const key of measures) {
      if (key === "Área (m²)" && (r[key] == null || v[key] === null))
        v[key] = null;
      else if (r[key] != null) v[key] = Number(v[key] ?? 0) + Number(r[key]);
    }
    map.set(k, v);
  }
  const grouped = Array.from(map.values());
  const quantities = summarizeMeasurements(filtered);
  return (
    <section className="panel">
      <div className="section-title">
        <Ruler />
        <h2>Mediciones consolidadas</h2>
      </div>
      <div className="tabs">
        {(["Resumen", "Detalle", "Incidencias"] as const).map((k) => (
          <button key={k} aria-pressed={k === tab} onClick={() => setTab(k)}>
            {k}
            {k === "Incidencias" ? " · " + exceptions.length : ""}
          </button>
        ))}
      </div>
      {tab === "Incidencias" ? (
        <Grid rows={exceptions} />
      ) : !all.length ? (
        <Empty
          title={
            exceptions.length
              ? "No hay filas cuantificadas"
              : "Aún no hay mediciones guardadas"
          }
        >
          {exceptions.length ? (
            <button onClick={() => setTab("Incidencias")}>
              Ver incidencias ({exceptions.length})
            </button>
          ) : (
            "En Tablas de origen, configura las mediciones y pulsa Calcular y guardar."
          )}
        </Empty>
      ) : (
        <>
          <div className="form-grid">
            {[
              "Categoría",
              "Nivel",
              "Familia",
              "Tipo",
              "Material",
              "Resistencia",
            ].map((k) => (
              <label key={k}>
                {k}
                <select
                  value={filters[k] ?? ""}
                  onChange={(e) =>
                    setFilters({ ...filters, [k]: e.target.value })
                  }
                >
                  <option value="">Todos</option>
                  {[
                    ...new Set(
                      all.map((r) => String(r[k] ?? "")).filter(Boolean),
                    ),
                  ]
                    .sort()
                    .map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          {quantities.length > 0 && (
            <dl
              className="measure-totals"
              aria-label="Cantidades de la selección"
            >
              {quantities.map((m) => (
                <div key={m.key}>
                  <dt>{measurementName(m)}</dt>
                  <dd>{totalLabel(m)}</dd>
                  {m.measuredRows < m.sourceRows && (
                    <small>
                      {m.measuredRows} de {m.sourceRows} filas medidas
                    </small>
                  )}
                </div>
              ))}
            </dl>
          )}
          {tab === "Resumen" && (
            <label>
              Agrupar mediciones por
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                {[
                  "Nivel",
                  "Categoría",
                  "Familia",
                  "Tipo",
                  "Material",
                  "Resistencia",
                ].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
          )}
          <Grid
            key={tab + group + !!filtered.length}
            rows={tab === "Detalle" ? filtered : grouped}
          />
        </>
      )}
    </section>
  );
}
