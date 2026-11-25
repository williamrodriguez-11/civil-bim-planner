import { Fragment, useState } from "react";
import {
  CalendarDays,
  Download,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  cleanError,
  dateLabel,
  fmt,
  type Task,
  type Plan,
  type State,
  type Mutation,
} from "./model";
import { Modal, Empty } from "./shared";
import {
  availableMeasures,
  unitLabel,
  summarizeMeasurements,
  measurementTotal,
} from "./measurements";

const relations: Record<
  string,
  { label: string; help: string; short: string }
> = {
  FS: {
    label: "Fin a comienzo (FC)",
    short: "FC",
    help: "Esta actividad comienza después de que termina la predecesora.",
  },
  SS: {
    label: "Comienzo a comienzo (CC)",
    short: "CC",
    help: "Esta actividad puede comenzar cuando comienza la predecesora.",
  },
  FF: {
    label: "Fin a fin (FF)",
    short: "FF",
    help: "Esta actividad no puede terminar antes de que termine la predecesora.",
  },
  SF: {
    label: "Comienzo a fin (CF)",
    short: "CF",
    help: "Esta actividad no puede terminar antes de que comience la predecesora.",
  },
};

function Calendar({
  plan,
  save,
  close,
}: {
  plan: Plan;
  save: (p: Plan) => Promise<void>;
  close: () => void;
}) {
  const [draftPlan, setDraftPlan] = useState(plan),
    [holiday, setHoliday] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Calendario y seguimiento" close={close}>
      <form
        className="calendar-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await save(draftPlan);
            close();
          } catch (e) {
            setError(cleanError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="calendar-dates">
          <label>
            Inicio del proyecto
            <input
              type="date"
              required
              value={draftPlan.start}
              onChange={(e) =>
                setDraftPlan({ ...draftPlan, start: e.target.value })
              }
            />
          </label>
          <label>
            Fecha de seguimiento (opcional)
            <input
              type="date"
              value={draftPlan.status_date ?? ""}
              onChange={(e) =>
                setDraftPlan({
                  ...draftPlan,
                  status_date: e.target.value || null,
                })
              }
              aria-describedby="status-date-help"
            />
          </label>
        </div>
        <p id="status-date-help" className="field-help">
          Elige hasta qué día quieres evaluar el avance previsto. Puedes dejar
          la fecha de seguimiento vacía para consultar el avance a hoy.
        </p>
        <h3>Días de trabajo</h3>
        <div className="weekdays">
          {["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"].map((d, i) => (
            <button
              type="button"
              key={d}
              aria-pressed={draftPlan.weekdays.includes(i)}
              onClick={() =>
                setDraftPlan({
                  ...draftPlan,
                  weekdays: draftPlan.weekdays.includes(i)
                    ? draftPlan.weekdays.filter((j) => j !== i)
                    : [...draftPlan.weekdays, i],
                })
              }
            >
              {d}
            </button>
          ))}
        </div>
        <div className="holiday-entry">
          <label>
            Fecha no laborable
            <input
              type="date"
              value={holiday}
              onChange={(e) => setHoliday(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!holiday}
            onClick={() => {
              setDraftPlan({
                ...draftPlan,
                holidays: [...new Set([...draftPlan.holidays, holiday])].sort(),
              });
              setHoliday("");
            }}
          >
            Añadir fecha
          </button>
        </div>
        <div className="chips">
          {draftPlan.holidays.map((d) => (
            <button
              type="button"
              key={d}
              aria-label={"Quitar fecha " + d}
              onClick={() =>
                setDraftPlan({
                  ...draftPlan,
                  holidays: draftPlan.holidays.filter((h) => h !== d),
                })
              }
            >
              {dateLabel(d)}
              <X size={12} />
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <button
          className="primary"
          disabled={busy || !draftPlan.weekdays.length}
        >
          Guardar calendario
        </button>
      </form>
    </Modal>
  );
}
function Editor({
  initial,
  state,
  close,
  save,
}: {
  initial: Task;
  state: State;
  close: () => void;
  save: (t: Task, groups: Record<string, string>) => Promise<void>;
}) {
  const [groups, setGroups] = useState(state.plan.groups);
  const [task, setTask] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const patch = (p: Partial<Task>) => setTask({ ...task, ...p });
  const scheduled = state.schedule.find((t) => t.id === task.id);
  const linkedRows = task.quantity
    ? (state.results[task.quantity.table]?.detail ?? []).filter(
        (r) =>
          (!task.quantity!.level || r.Nivel === task.quantity!.level) &&
          (!task.quantity!.category || r.Categoría === task.quantity!.category),
      )
    : [];
  const linkedMeasures = summarizeMeasurements(linkedRows).filter(
    (m) => m.unit === task.quantity?.unit,
  );
  const linkedTotal =
    linkedMeasures.length === 1 ? measurementTotal(linkedMeasures[0]) : null;

  return (
    <Modal
      className="task-editor"
      title={
        state.plan.tasks.some((a) => a.id === task.id)
          ? "Editar actividad"
          : "Nueva actividad"
      }
      close={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await save(task, groups);
            close();
          } catch (e) {
            setError(cleanError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="field-help">
          Programa la actividad con su duración, calendario y predecesoras. El
          cronograma calcula las fechas de comienzo y fin.
        </p>
        {scheduled && (
          <div className="schedule-preview">
            <span>
              Comienzo calculado <strong>{dateLabel(scheduled.start)}</strong>
            </span>
            <span>
              Fin calculado <strong>{dateLabel(scheduled.finish)}</strong>
            </span>
            <small>Fechas del último guardado; se recalculan al guardar.</small>
          </div>
        )}
        <fieldset className="task-section">
          <legend>1. Datos de la actividad</legend>
          <label>
            Nombre de la actividad
            <input
              required
              maxLength={160}
              autoFocus
              placeholder="Ej. Fundida de zapatas"
              value={task.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <div className="form-grid">
            <label>
              Código EDT
              <input
                required
                pattern="[1-9][0-9]*(\.[1-9][0-9]*)*"
                placeholder="1.2.1"
                value={task.wbs}
                aria-describedby="wbs-help"
                onChange={(e) => patch({ wbs: e.target.value })}
              />
            </label>
            <label>
              Duración (días laborables)
              <input
                type="number"
                min="1"
                max="3650"
                required
                disabled={!!task.quantity}
                value={
                  task.quantity
                    ? (scheduled?.duration ?? task.duration)
                    : task.duration
                }
                onChange={(e) => patch({ duration: Number(e.target.value) })}
              />
            </label>
          </div>
          <p id="wbs-help" className="field-help">
            EDT organiza las fases y actividades: 1.1 y 1.2 pertenecen a la fase
            1. La duración cuenta solo los días laborables del calendario.
          </p>
          {task.quantity && (
            <p className="field-help">
              La duración se calcula con la cantidad de obra y el rendimiento al
              guardar.
            </p>
          )}
        </fieldset>
        <fieldset className="task-section">
          <legend>2. Seguimiento de la ejecución</legend>
          <div className="progress-editor">
            <input
              type="range"
              aria-label="Avance realizado"
              min="0"
              max="100"
              step="1"
              value={task.progress}
              onChange={(e) => patch({ progress: Number(e.target.value) })}
            />
            <label>
              % completado
              <input
                aria-describedby="progress-help"
                type="number"
                min="0"
                max="100"
                step="any"
                required
                value={task.progress}
                onChange={(e) => patch({ progress: +e.target.value })}
              />
            </label>
          </div>
          <p id="progress-help" className="field-help">
            Registra el avance observado en obra. 0% significa sin iniciar y
            100% significa terminada.
          </p>
          <div className="chips" aria-label="Registrar porcentaje completado">
            {[0, 25, 50, 75, 100].map((n) => (
              <button
                type="button"
                key={n}
                aria-pressed={task.progress === n}
                onClick={() => patch({ progress: n })}
              >
                {n}%
              </button>
            ))}
          </div>
          <p className="field-help">
            El % previsto se calcula según las fechas y el calendario. La
            cantidad BIM se usa para estimar duración; no mide automáticamente
            la obra ejecutada.
          </p>
        </fieldset>
        <details className="task-section" open={task.wbs.includes(".")}>
          <summary>Organización por fases y capítulos</summary>
          {task.wbs
            .split(".")
            .slice(0, -1)
            .map((_, i) => {
              const code = task.wbs
                .split(".")
                .slice(0, i + 1)
                .join(".");
              return (
                <label key={code}>
                  {i === 0 ? "Fase" : "Capítulo"} {code}
                  <input
                    value={groups[code] ?? ""}
                    placeholder={"Grupo " + code}
                    onChange={(e) =>
                      setGroups({ ...groups, [code]: e.target.value })
                    }
                  />
                </label>
              );
            })}
          {!task.wbs.includes(".") && (
            <p className="field-help">
              Usa un código como 1.1 para asignar esta actividad a una fase.
            </p>
          )}
        </details>
        <details
          className="task-section"
          open={!!initial.earliest || !!initial.fixed_finish}
        >
          <summary>Restricciones de fechas (opcional)</summary>
          <p className="field-help">
            Déjalas vacías para programar lo antes posible. Las predecesoras y
            el calendario siempre se respetan.
          </p>
          <div className="form-grid">
            <label>
              No comenzar antes del
              <input
                type="date"
                value={task.earliest ?? ""}
                onChange={(e) => patch({ earliest: e.target.value || null })}
              />
            </label>
            <label>
              Debe finalizar el
              <input
                type="date"
                value={task.fixed_finish ?? ""}
                onChange={(e) =>
                  patch({ fixed_finish: e.target.value || null })
                }
              />
            </label>
          </div>
          <p className="field-help">
            “No comenzar antes del” permite comenzar más tarde. “Debe finalizar
            el” obliga a terminar exactamente ese día laborable; si las
            dependencias lo impiden, se avisará al guardar.
          </p>
        </details>
        <details className="task-section" open={!!initial.quantity}>
          <summary>Calcular días con las cantidades de la tabla</summary>
          <p className="field-help">
            Selecciona una tabla y cuánta obra realiza la cuadrilla cada día.
            Por ejemplo, 30 m³ a 5 m³ por día requieren 6 días laborables.
          </p>
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
                        rate: 0,
                        level: "",
                      }
                    : null,
                })
              }
            >
              <option value="">Duración manual</option>
              {state.tables
                .filter((s) => state.results[s.id]?.detail.length)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.mapping?.category}
                  </option>
                ))}
            </select>
          </label>
          {task.quantity && linkedTotal !== null && task.quantity.rate > 0 && (
            <p className="notice">
              {fmt(linkedTotal)} {unitLabel(task.quantity.unit)} ÷{" "}
              {fmt(task.quantity.rate)} {unitLabel(task.quantity.unit)}/día ={" "}
              <strong>
                {Math.ceil(linkedTotal / task.quantity.rate)} días laborables
              </strong>
              .
            </p>
          )}
          {task.quantity && (
            <div className="form-grid">
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
                Categoría vinculada
                <select
                  value={task.quantity.category ?? ""}
                  onChange={(e) =>
                    patch({
                      quantity: { ...task.quantity!, category: e.target.value },
                    })
                  }
                >
                  <option value="">Todas las categorías</option>
                  {Array.from(
                    new Set(
                      state.results[task.quantity.table].detail.map((r) =>
                        String(r.Categoría),
                      ),
                    ),
                  ).map((k) => (
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
                  required
                  type="number"
                  min="0.000000001"
                  step="any"
                  value={task.quantity.rate || ""}
                  onChange={(e) =>
                    patch({
                      quantity: { ...task.quantity!, rate: +e.target.value },
                    })
                  }
                />
              </label>
              <p>
                Días = cantidad ÷ rendimiento, redondeados hacia arriba.
                {state.results[task.quantity.table].issues.some(
                  (r) => r.Estado === "Rechazada",
                ) &&
                  " La fuente contiene filas rechazadas. Se usa la cantidad parcial validada."}
              </p>
            </div>
          )}
        </details>
        <fieldset className="task-section">
          <legend>3. Predecesoras</legend>
          <p className="field-help">
            Actividades que condicionan a esta. Por ejemplo: terminar la
            excavación antes de comenzar la cimentación.
          </p>
          {task.links.map((l, i) => (
            <div className="dependency" key={i}>
              <div className="tools">
                <select
                  aria-label="Predecesora"
                  value={l.predecessor}
                  onChange={(e) =>
                    patch({
                      links: task.links.map((x, j) =>
                        i === j ? { ...x, predecessor: +e.target.value } : x,
                      ),
                    })
                  }
                >
                  {state.plan.tasks
                    .filter(
                      (a) =>
                        a.id !== task.id &&
                        (a.id === l.predecessor ||
                          !task.links.some(
                            (link) => link.predecessor === a.id,
                          )),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.wbs} · {a.name}
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Relación"
                  value={l.relation}
                  onChange={(e) =>
                    patch({
                      links: task.links.map((x, j) =>
                        i === j ? { ...x, relation: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {Object.entries(relations).map(([value, r]) => (
                    <option key={value} value={value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <label>
                  Desfase (días laborables)
                  <input
                    type="number"
                    required
                    min="-3650"
                    max="3650"
                    value={l.lag}
                    onChange={(e) =>
                      patch({
                        links: task.links.map((x, j) =>
                          i === j ? { ...x, lag: +e.target.value } : x,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  aria-label="Quitar vínculo"
                  onClick={() =>
                    patch({ links: task.links.filter((_, j) => i !== j) })
                  }
                >
                  <X size={14} />
                </button>
              </div>
              <p className="field-help">
                {relations[l.relation].help} Desfase: 0 sin espera; +2 espera
                dos días laborables; −2 adelanta dos días laborables.
              </p>
            </div>
          ))}
          <button
            type="button"
            disabled={
              !state.plan.tasks.some(
                (a) =>
                  a.id !== task.id &&
                  !task.links.some((l) => l.predecessor === a.id),
              )
            }
            onClick={() => {
              const a = state.plan.tasks.find(
                (a) =>
                  a.id !== task.id &&
                  !task.links.some((l) => l.predecessor === a.id),
              );
              if (a)
                patch({
                  links: [
                    ...task.links,
                    { predecessor: a.id, relation: "FS", lag: 0 },
                  ],
                });
            }}
          >
            Añadir predecesora
          </button>
          {!state.plan.tasks.some((a) => a.id !== task.id) && (
            <p className="field-help">
              Crea otra actividad para poder vincularla como predecesora.
            </p>
          )}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            Guardar actividad
          </button>
        </div>
      </form>
    </Modal>
  );
}
const compactDate = (s: string) =>
  s.slice(0, 10).split("-").reverse().join("/");
const axisDate = (s: string) =>
  new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(s));
const day = (s: string) => Date.parse(s + "T00:00:00Z") / 86400000;
export function Schedule({
  state,
  mutate,
}: {
  state: State;
  mutate: Mutation;
}) {
  const [edit, setEdit] = useState<Task | null>(null),
    [calendar, setCalendar] = useState(false),
    [zoom, setZoom] = useState(100),
    [critical, setCritical] = useState(false),
    [query, setQuery] = useState(""),
    [columns, setColumns] = useState(false);
  const rows = state.schedule.filter(
    (a) =>
      (!critical || a.critical) &&
      (a.name + " " + a.wbs)
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const now = new Date();
  const cutoff =
    state.plan.status_date ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const start = Math.min(...state.schedule.map((r) => day(r.start))),
    end = Math.max(...state.schedule.map((r) => day(r.finish))),
    span = end - start + 1;
  const cutoffPosition = ((day(cutoff) - start + 1) / span) * 100;
  const save = async (p: Plan) => {
    await mutate("/plan", p, "PUT");
  };
  function create() {
    const id = Math.max(0, ...state.plan.tasks.map((t) => t.id)) + 1;
    const wbs = String(
      Math.max(0, ...state.plan.tasks.map((t) => +t.wbs.split(".")[0])) + 1,
    );
    setEdit({
      id,
      wbs,
      name: "",
      duration: 1,
      earliest: null,
      progress: 0,
      links: [],
      quantity: null,
    });
  }
  return (
    <section className="panel">
      <div className="section-title">
        <CalendarDays />
        <h2>Cronograma de obra</h2>
        <button className="primary right" onClick={create}>
          <Plus size={16} />
          Actividad
        </button>
      </div>
      <div className="tools">
        <button onClick={() => setCalendar(true)}>
          <SlidersHorizontal size={16} />
          Calendario y seguimiento
        </button>
        {!!state.schedule.length && (
          <a
            className="btn"
            download
            href={"/api/projects/" + state.project.id + "/schedule.xml"}
          >
            <Download size={15} />
            Microsoft Project XML
          </a>
        )}
      </div>
      <p className="field-help">
        Programación automática · Duraciones en días laborables · Seguimiento al{" "}
        {dateLabel(cutoff)}
        {!state.plan.status_date && " (hoy)"}
      </p>
      {!state.schedule.length ? (
        <Empty title="Programa la primera actividad">
          Define su duración o vincúlala a una cantidad de obra y a un
          rendimiento diario.
        </Empty>
      ) : (
        <>
          <div className="tools subsection schedule-toolbar">
            <label>
              Buscar actividad
              <input
                type="search"
                placeholder="Nombre o código EDT"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={critical}
                onChange={(e) => setCritical(e.target.checked)}
              />
              Solo ruta crítica
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={columns}
                onChange={(e) => setColumns(e.target.checked)}
              />
              Más columnas
            </label>
            <label className="check">
              Escala
              <input
                type="range"
                min="100"
                max="350"
                value={zoom}
                onChange={(e) => setZoom(+e.target.value)}
              />
            </label>
          </div>
          <div
            className="schedule-scroll"
            role="region"
            aria-label="Tabla de actividades y diagrama de Gantt"
            tabIndex={0}
          >
            <table className="schedule-table">
              <thead>
                <tr>
                  <th>EDT</th>
                  <th>Nombre de la actividad</th>
                  <th>Duración</th>
                  <th>Comienzo</th>
                  <th>Fin</th>
                  <th>Predecesoras</th>
                  <th>% completado</th>
                  {columns && (
                    <>
                      <th>% previsto</th>
                      <th>Holgura</th>
                      <th>Vínculo BIM</th>
                    </>
                  )}
                  <th className="timeline-cell">
                    <div className="axis" style={{ width: (340 * zoom) / 100 }}>
                      {Number.isFinite(span) &&
                        Array.from({ length: Math.min(5, span) }, (_, i) => (
                          <span key={i}>
                            {axisDate(
                              new Date(
                                (start +
                                  Math.round(
                                    ((span - 1) * i) /
                                      Math.max(1, Math.min(5, span) - 1),
                                  )) *
                                  86400000,
                              ).toISOString(),
                            )}
                          </span>
                        ))}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t, index) => (
                  <Fragment key={t.id}>
                    {t.wbs
                      .split(".")
                      .slice(0, -1)
                      .map((_, i) => {
                        const code = t.wbs
                          .split(".")
                          .slice(0, i + 1)
                          .join(".");
                        const previous = rows[index - 1]?.wbs
                          .split(".")
                          .slice(0, i + 1)
                          .join(".");
                        return (
                          previous !== code && (
                            <tr className="schedule-group" key={code}>
                              <td>{code}</td>
                              <td colSpan={columns ? 10 : 7}>
                                {code} ·{" "}
                                {state.plan.groups[code] ?? "Grupo " + code}
                              </td>
                            </tr>
                          )
                        );
                      })}
                    <tr>
                      <td>{t.wbs}</td>
                      <td>
                        <button
                          className="task-name"
                          onClick={() =>
                            setEdit(
                              state.plan.tasks.find((a) => a.id === t.id)!,
                            )
                          }
                        >
                          {t.name}
                        </button>
                        <small
                          className={
                            t.progress < t.planned ? "schedule-behind" : ""
                          }
                        >
                          {t.progress === 100
                            ? "Completada"
                            : t.progress < t.planned
                              ? "Por debajo de lo previsto"
                              : t.progress === 0
                                ? "Sin iniciar"
                                : "En curso"}
                          {t.critical ? " · Crítica" : ""}
                        </small>
                      </td>
                      <td>{t.duration} d</td>
                      <td>{compactDate(t.start)}</td>
                      <td>{compactDate(t.finish)}</td>
                      <td
                        title={t.links
                          .map(
                            (l) =>
                              `${state.plan.tasks.find((a) => a.id === l.predecessor)?.name}: ${relations[l.relation].label}, desfase ${l.lag} d`,
                          )
                          .join("; ")}
                      >
                        {t.links
                          .map(
                            (l) =>
                              `${state.plan.tasks.find((a) => a.id === l.predecessor)?.wbs} ${relations[l.relation].short}${l.lag ? (l.lag > 0 ? "+" : "") + l.lag + "d" : ""}`,
                          )
                          .join("; ") || "—"}
                      </td>
                      <td>
                        <strong>{fmt(t.progress)} %</strong>
                        <progress
                          max={100}
                          value={t.progress}
                          aria-label={"Porcentaje completado de " + t.name}
                        />
                        {!columns && (
                          <small>Previsto: {fmt(t.planned)} %</small>
                        )}
                      </td>
                      {columns && (
                        <>
                          <td>{fmt(t.planned)} %</td>
                          <td>{t.slack} d</td>
                          <td>
                            {t.quantity
                              ? fmt(t.amount ?? 0) +
                                " " +
                                unitLabel(t.quantity.unit)
                              : "—"}
                          </td>
                        </>
                      )}
                      <td className="timeline-cell">
                        <div
                          className="track"
                          style={{ width: (340 * zoom) / 100 }}
                        >
                          {cutoffPosition >= 0 && cutoffPosition <= 100 && (
                            <span
                              className="status-line"
                              style={{ left: cutoffPosition + "%" }}
                              title={"Fecha de seguimiento: " + cutoff}
                            />
                          )}
                          <button
                            className={"bar " + (t.critical ? "critical" : "")}
                            style={{
                              left: ((day(t.start) - start) / span) * 100 + "%",
                              width:
                                ((day(t.finish) - day(t.start) + 1) / span) *
                                  100 +
                                "%",
                            }}
                            onClick={() =>
                              setEdit(
                                state.plan.tasks.find((a) => a.id === t.id)!,
                              )
                            }
                            title={`${t.name} · ${dateLabel(t.start)} → ${dateLabel(t.finish)} · ${t.duration} días laborables · ${t.progress}% completado · Holgura ${t.slack} d`}
                            aria-label={"Editar " + t.name}
                          >
                            <i style={{ width: t.progress + "%" }} />
                            <span>{fmt(t.progress)}%</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <p className="field-help">
              No hay actividades que coincidan con los filtros.
            </p>
          )}
          <div className="schedule-legend">
            <span>
              <i className="key-critical" /> Ruta crítica
            </span>
            <span>
              <i className="key-progress" /> Porción completada
            </span>
            <span>
              <i className="key-status" /> Fecha de seguimiento
            </span>
          </div>
          <p className="field-help">
            Selecciona el nombre o la barra para editar. La holgura indica
            cuántos días laborables puede desplazarse una actividad sin retrasar
            el fin del proyecto o una fecha obligatoria.
          </p>
          <details className="schedule-help">
            <summary>Cómo leer el seguimiento y las dependencias</summary>
            <p>
              <strong>% completado:</strong> progreso que registras según la
              ejecución. <strong>% previsto:</strong> progreso lineal esperado
              al cierre de la fecha de seguimiento, según el calendario vigente.
              Esta comparación no es una línea base guardada.
            </p>
            <p>
              <strong>FC:</strong> fin a comienzo. <strong>CC:</strong> comienzo
              a comienzo. <strong>FF:</strong> fin a fin. <strong>CF:</strong>{" "}
              comienzo a fin. Ejemplo: 1.1 FC+2d espera dos días laborables
              después de terminar la actividad 1.1.
            </p>
          </details>
        </>
      )}
      {calendar && (
        <Calendar
          plan={state.plan}
          save={save}
          close={() => setCalendar(false)}
        />
      )}
      {edit && (
        <Editor
          initial={edit}
          state={state}
          close={() => setEdit(null)}
          save={async (t, groups) => {
            const tasks = state.plan.tasks;
            await save({
              ...state.plan,
              groups: Object.fromEntries(
                Object.entries(groups).filter(([, name]) => name.trim()),
              ),
              tasks: tasks.some((a) => a.id === t.id)
                ? tasks.map((a) => (a.id === t.id ? t : a))
                : [...tasks, t],
            });
          }}
        />
      )}
    </section>
  );
}
