import { reviewRow } from "./review";
import { useEffect, useState } from "react";
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
  cleanError,
  dateLabel,
  details,
  elementFromName,
  fmt,
  issues,
  levelsAsCategories,
  type Mutation,
  type Page,
  type QuantityTab,
  type Row,
  type Source,
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
function LevelCategoryFix({
  source,
  levels,
  mutate,
}: {
  source: Source;
  levels: string[];
  mutate: Mutation;
}) {
  const [category, setCategory] = useState(
      elementFromName(source.name, source.sheet),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mapping = source.mapping!;
  // A separate column may legitimately match the level (e.g. «Cimentación»).
  const separateColumn =
    !!mapping.category_field && mapping.category_field !== mapping.fields.level;
  async function save(update: Partial<typeof mapping>) {
    setBusy(true);
    setError("");
    try {
      await mutate(
        "/tables/" + source.id + "/mapping",
        { ...mapping, ...update },
        "PUT",
      );
    } catch (e) {
      setError(cleanError(e));
      setBusy(false);
    }
  }
  return (
    <div className="notice level-fix" role="status">
      <p>
        La tabla <strong>«{source.name}»</strong> parece usar los niveles
        {levels.length ? ` (${levels.slice(0, 3).join(", ")}${levels.length > 3 ? "…" : ""})` : ""}{" "}
        como si fueran categorías. Indica qué elemento contiene la tabla:
      </p>
      <div className="tools">
        <input
          aria-label={"Categoría de " + source.name}
          placeholder="Ej. Columnas"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <button
          className="primary"
          disabled={busy || !category.trim()}
          onClick={() =>
            save({
              category: category.trim(),
              category_field: "",
              category_confirmed: false,
            })
          }
        >
          Clasificar toda la tabla como {category.trim() || "…"}
        </button>
        {separateColumn && (
          <button
            disabled={busy}
            title={`La columna «${mapping.category_field}» sí indica el tipo de elemento`}
            onClick={() => save({ category_confirmed: true })}
          >
            Es correcto, mantener
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
const SERIES = 6;
const pct = (n: number) =>
  n.toLocaleString("es-CO", { maximumFractionDigits: 1 }) + " %";

/** One whole split into parts: a tall segmented bar plus a legend list.
 * Colors follow each name (natural order), never its rank. */
function Shares({
  parts,
  unit,
  names,
}: {
  parts: { name: string; value: number | null; label: string }[];
  unit: string;
  names: string[];
}) {
  const [active, setActive] = useState<string | null>(null),
    [grown, setGrown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const measured = parts.filter((p) => p.value !== null && p.value > 0);
  const total = measured.reduce((n, p) => n + (p.value ?? 0), 0);
  if (!total)
    return (
      <div className="chart-empty">
        <b>Sin cantidades para repartir</b>
      </div>
    );
  const order = [...names].sort((a, b) =>
    a.localeCompare(b, "es", { numeric: true }),
  );
  // More than six parts: the five largest keep a color, the rest fold into «Otros».
  const shown = measured.length > SERIES ? measured.slice(0, SERIES - 1) : measured;
  const rest = measured.slice(shown.length);
  const colored = order.filter((n) => shown.some((p) => p.name === n));
  const color = (name: string) =>
    shown.some((p) => p.name === name)
      ? `var(--series-${colored.indexOf(name) + 1})`
      : "var(--series-other)";
  const restValue = rest.reduce((n, p) => n + (p.value ?? 0), 0);
  const blocks = [
    ...shown.map((p) => ({ key: p.name, name: p.name, value: p.value ?? 0 })),
    ...(rest.length
      ? [{ key: "Otros", name: `Otros (${rest.length})`, value: restValue }]
      : []),
  ];
  const focus = blocks.find((b) => b.key === active);
  const summary = blocks
    .map((b) => `${b.name}: ${pct((b.value / total) * 100)}`)
    .join(", ");
  return (
    <div className="shares" onMouseLeave={() => setActive(null)}>
      <div className="shares-head">
        <span>Total</span>
        <strong>
          {fmt(total)} {unit}
        </strong>
        <small aria-live="polite">
          {focus
            ? `${focus.name} · ${fmt(focus.value)} ${unit} · ${pct(
                (focus.value / total) * 100,
              )}`
            : "Pasa el cursor por el gráfico o la lista"}
        </small>
      </div>
      <div className="shares-bar" role="img" aria-label={"Reparto: " + summary}>
        {blocks.map((b) => {
          const share = (b.value / total) * 100;
          return (
            <span
              key={b.key}
              tabIndex={0}
              className={active ? (active === b.key ? "on" : "off") : ""}
              style={{
                flexGrow: grown ? b.value : 0,
                background:
                  b.key === "Otros" ? "var(--series-other)" : color(b.key),
              }}
              title={`${b.name} · ${fmt(b.value)} ${unit} · ${pct(share)}`}
              onMouseEnter={() => setActive(b.key)}
              onFocus={() => setActive(b.key)}
              onBlur={() => setActive(null)}
            >
              {share >= 9 && (
                <b
                  style={
                    colored.indexOf(b.key) === 3 ? { color: "#0b0b0b" } : undefined
                  }
                >
                  {pct(Math.round(share))}
                </b>
              )}
            </span>
          );
        })}
      </div>
      <ul className="shares-list">
        {parts.map((p) => {
          const key = shown.some((s) => s.name === p.name)
            ? p.name
            : p.value
              ? "Otros"
              : null;
          const share = p.value && total ? (p.value / total) * 100 : null;
          return (
            <li
              key={p.name}
              className={
                active && key ? (active === key ? "on" : "off") : ""
              }
              onMouseEnter={() => key && setActive(key)}
            >
              <i
                style={{
                  background: key
                    ? key === "Otros"
                      ? "var(--series-other)"
                      : color(p.name)
                    : "transparent",
                }}
              />
              <span>{p.name}</span>
              <b>{p.label}</b>
              <small>{share === null ? "—" : pct(share)}</small>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
export function Overview({
  state,
  projects,
  go,
  create,
  mutate,
}: {
  state: State | null;
  projects: number;
  go: (p: Page) => void;
  create: () => void;
  mutate: Mutation;
}) {
  const data = details(state),
    tables = state?.tables ?? [],
    tasks = state?.schedule ?? [],
    [groupBy, setGroupBy] = useState("Nivel"),
    [selectedKey, setSelectedKey] = useState(""),
    [chartView, setChartView] = useState("Barras"),
    [categoryFilter, setCategoryFilter] = useState("");
  const categories = Array.from(
    new Set(data.map((r) => String(r.Categoría))),
  ).sort((a, b) => a.localeCompare(b, "es"));
  const category = categories.includes(categoryFilter) ? categoryFilter : "";
  // Quantities of different categories are only mixed when "Todas" is chosen.
  const shown = category
    ? data.filter((r) => String(r.Categoría) === category)
    : data;
  const quantities = summarizeMeasurements(shown);
  // With one category chosen, grouping by category would show a single bar.
  const grouping = category && groupBy === "Categoría" ? "Nivel" : groupBy;
  const selected =
    quantities.find((m) => m.key === selectedKey) ?? quantities[0];
  const groups = new Map<string, Row[]>();
  for (const row of shown) {
    if (
      !selected ||
      (selected.category !== undefined && row.Categoría !== selected.category)
    )
      continue;
    const group = String(row[grouping]);
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
  const errors = issues(state).filter(
      (r) => reviewRow(r).Estado === "Por corregir",
    ).length,
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
      name: category ? "Cantidades de obra · " + category : "Cantidades de obra",
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
      {levelsAsCategories(state).map((source) => (
        <LevelCategoryFix
          key={source.id}
          source={source}
          levels={[
            ...new Set(
              (state?.results[source.id]?.detail ?? []).map((r) =>
                String(r.Nivel),
              ),
            ),
          ]}
          mutate={mutate}
        />
      ))}
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
                ? "Distribución · " +
                  measurementName(selected) +
                  (category && !selected.category ? " · " + category : "")
                : "Distribución de cantidades"}
            </h2>
          </div>
          {categories.length > 1 && (
            <label className="category-filter">
              Categoría
              <select
                value={category}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option value="">Todas las categorías (suma)</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="tabs">
            {["Nivel", "Categoría"].map((k) => (
              <button
                key={k}
                aria-pressed={k === grouping}
                disabled={!!category && k === "Categoría"}
                title={
                  category && k === "Categoría"
                    ? "Elige «Todas las categorías» para compararlas"
                    : undefined
                }
                onClick={() => setGroupBy(k)}
              >
                Por {k.toLowerCase()}
              </button>
            ))}
          </div>
          <div className="tabs" aria-label="Vista de cantidades">
            {["Barras", "Tabla", "Proporciones"].map((v) => (
              <button
                key={v}
                aria-pressed={chartView === v}
                onClick={() => setChartView(v)}
              >
                {v}
              </button>
            ))}
          </div>
          {sums.length && chartView === "Tabla" ? (
            <Grid
              rows={sums.map(({ name, measure }) => ({
                [grouping]: name,
                Cantidad: measurementTotal(measure),
                Unidad: unitLabel(measure.unit),
              }))}
            />
          ) : sums.length && chartView === "Proporciones" ? (
            <Shares
              parts={sums.map(({ name, measure }) => ({
                name,
                value: measurementTotal(measure),
                label: totalLabel(measure),
              }))}
              unit={unitLabel(selected.unit)}
              names={Array.from(groups.keys())}
            />
          ) : sums.length ? (
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
      {!!tasks.length && (
        <section className="panel">
          <div className="section-title">
            <CalendarDays />
            <h2>Seguimiento de actividades</h2>
          </div>
          <div className="measure-totals">
            <div>
              <small>Terminadas</small>
              <strong>{tasks.filter((t) => t.progress === 100).length}</strong>
            </div>
            <div>
              <small>En ejecución</small>
              <strong>
                {tasks.filter((t) => t.progress > 0 && t.progress < 100).length}
              </strong>
            </div>
            <div>
              <small>Por iniciar</small>
              <strong>{tasks.filter((t) => t.progress === 0).length}</strong>
            </div>
            <div>
              <small>En ruta crítica</small>
              <strong>{tasks.filter((t) => t.critical).length}</strong>
            </div>
          </div>
          <button onClick={() => go("Programación")}>
            Ver cronograma <ArrowRight size={14} />
          </button>
        </section>
      )}
      {(pending > 0 || errors > 0) && (
        <div className="notice">
          <b>Revisión pendiente</b> · {pending} tablas por configurar · {errors}{" "}
          filas por corregir{" "}
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
  initialTableId,
  mutate,
}: {
  state: State;
  initialTab?: QuantityTab;
  initialTableId: number;
  mutate: Mutation;
}) {
  const [selectedTableId, setTableId] = useState(initialTableId);
  const tableId = state.tables.some(({ id }) => id === selectedTableId) ? selectedTableId : 0;
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tables = state.tables.filter((table) => !tableId || table.id === tableId);
  const all = tables.flatMap(({ id }) => state.results[id]?.detail ?? []);
  const pending = new Map<Row, { id: number; index: number }>();
  const history = new Map<Row, { id: number; digest: string; current: boolean }>();
  for (const table of tables) {
    const { id, name, sheet } = table;
    const label = sheet ? name + " · " + sheet : name;
    const rows = state.results[id]?.issues ?? [];
    const review = state.issue_review?.[id];
    for (const index of review?.pending ?? rows.map((_, index) => index)) {
      pending.set(reviewRow({ ...rows[index], Archivo: label }), { id, index });
    }
    for (const entry of review?.history ?? []) {
      const { Categoría, Estado, Motivo } = entry.row;
      const row = reviewRow({
        Categoría,
        Archivo: label,
        "Fila origen": entry.row["Fila origen"],
        Estado,
        Motivo,
      });
      history.set({
        ...row,
        "Archivada el": dateLabel(entry.archived_at),
      }, { id, digest: entry.id, current: entry.current });
    }
  }
  const exceptions = Array.from(pending.keys());
  const hasArchivedCurrent = Array.from(history.values()).some((entry) => entry.current);
  async function updateIssue(path: string, body: object) {
    setBusy(true);
    setError("");
    try {
      await mutate(path, body);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }
  const [filters, setFilters] = useState<Record<string, string>>({}),
    [tab, setTab] = useState<QuantityTab>(
      initialTab ??
        (!all.length && exceptions.length ? "Incidencias" : "Resumen"),
    ),
    [group, setGroup] = useState("Nivel");
  const filtered = all.filter((r) =>
    Object.entries(filters).every(([k, v]) => !v || r[k] === v),
  );
  const available = [
    "Categoría",
    "Nivel",
    "Familia",
    "Tipo",
    "Material",
    "Resistencia",
  ].filter((key) => all.some((row) => String(row[key] ?? "").trim()));
  const groupKey = available.includes(group)
    ? group
    : (available[0] ?? "Nivel");
  const measures = ["Volumen (m³)", "Longitud (m)", "Masa (kg)"];
  if (groupKey === "Categoría" || filters["Categoría"])
    measures.push("Área (m²)");
  const map = new Map<string, Row>();
  for (const r of filtered) {
    const k = String(r[groupKey] || "Sin asignar"),
      v = map.get(k) ?? { [groupKey]: k, Elementos: 0 };
    v.Elementos = Number(v.Elementos) + Number(r.Elementos);
    for (const key of measures) {
      if (key === "Área (m²)" && (r[key] == null || v[key] === null))
        v[key] = null;
      else if (r[key] != null) v[key] = Number(v[key] ?? 0) + Number(r[key]);
    }
    map.set(k, v);
  }
  const grouped = Array.from(map.values());
  const displayedRows = tab === "Detalle" ? filtered : grouped;
  const populatedColumns = Array.from(
    new Set(displayedRows.flatMap((row) => Object.keys(row))),
  ).filter((key) =>
    displayedRows.some((row) => String(row[key] ?? "").trim() !== ""),
  );
  const quantities = summarizeMeasurements(filtered);
  return (
    <section className="panel">
      <div className="section-title">
        <Ruler />
        <h2>Mediciones consolidadas</h2>
      </div>
      <label className="quantity-group">
        Tabla para analizar
        <select
          value={tableId}
          onChange={(e) => {
            setTableId(Number(e.target.value));
            setFilters({});
            setGroup("Nivel");
            setError("");
          }}
        >
          <option value={0}>Todas las tablas</option>
          {state.tables.map(({ id, name, sheet }) => (
            <option key={id} value={id}>{name}{sheet && " · " + sheet}</option>
          ))}
        </select>
      </label>
      <div className="tabs">
        {(["Resumen", "Detalle", "Incidencias"] as const).map((k) => (
          <button key={k} aria-pressed={k === tab} onClick={() => setTab(k)}>
            {k === "Incidencias" ? "Filas por revisar" : k}
            {k === "Incidencias" ? " · " + exceptions.length : ""}
          </button>
        ))}
      </div>
      {tab === "Incidencias" ? (
        <div>
          <p className="field-help">
            Estas filas quedaron fuera de las cantidades. Los totales se omiten
            porque sus elementos ya están contados. Las filas “Por corregir”
            necesitan revisar sus datos o configuración. Archivar una fila la
            mueve al historial y conserva el resultado del cálculo.
          </p>
          <div className="tabs">
            <button aria-pressed={!showHistory} onClick={() => setShowHistory(false)}>
              Pendientes · {exceptions.length}
            </button>
            <button aria-pressed={showHistory} onClick={() => setShowHistory(true)}>
              Historial · {history.size}
            </button>
          </div>
          {error && <p role="alert" className="error">{error}</p>}
          {showHistory ? (
            <Grid key={tableId + ":historial"} rows={Array.from(history.keys())}
              rowAction={(row) => {
                const entry = history.get(row)!;
                return entry.current ? (
                  <button disabled={busy} onClick={() => updateIssue(
                    "/tables/" + entry.id + "/issue-archive/" + entry.digest + "/restore", {},
                  )}>Volver a pendientes</button>
                ) : <span>Ya no aparece en el cálculo actual</span>;
              }}
            />
          ) : (
            <Grid key={tableId + ":pendientes"} rows={exceptions}
              rowAction={(row) => {
                const entry = pending.get(row)!;
                return <button disabled={busy} onClick={() => updateIssue(
                  "/tables/" + entry.id + "/issue-archive", { index: entry.index },
                )}>Archivar</button>;
              }}
            />
          )}
        </div>
      ) : !all.length ? (
        <Empty
          title={
            exceptions.length || hasArchivedCurrent
              ? "No hay filas cuantificadas en la selección"
              : "Aún no hay mediciones guardadas"
          }
        >
          {exceptions.length ? (
            <button onClick={() => setTab("Incidencias")}>
              Ver incidencias ({exceptions.length})
            </button>
          ) : hasArchivedCurrent ? (
            <button onClick={() => {
              setShowHistory(true);
              setTab("Incidencias");
            }}>
              Ver historial
            </button>
          ) : (
            "En Tablas de origen, configura las mediciones y pulsa Calcular y guardar."
          )}
        </Empty>
      ) : (
        <>
          <div className="form-grid quantity-filters">
            {available.map((k) => (
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
            <label className="quantity-group">
              Agrupar mediciones por
              <select
                value={groupKey}
                onChange={(e) => setGroup(e.target.value)}
              >
                {available.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
          )}
          <Grid
            key={tableId + tab + group + JSON.stringify(populatedColumns)}
            rows={displayedRows}
            columns={populatedColumns}
          />
        </>
      )}
    </section>
  );
}
