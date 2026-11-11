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
import { availableMeasures, unitLabel } from "./measurements";

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
    <Modal title="Calendario laboral" close={close}>
      <form
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
        <h3>Días de trabajo</h3>
        <div className="chips">
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
        <div className="chips">
          {draftPlan.holidays.map((d) => (
            <button
              type="button"
              key={d}
              onClick={() =>
                setDraftPlan({
                  ...draftPlan,
                  holidays: draftPlan.holidays.filter((h) => h !== d),
                })
              }
            >
              {d}
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
  return (
    <Modal
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
              onChange={(e) => patch({ wbs: e.target.value })}
            />
          </label>
          <label>
            Inicio mínimo
            <input
              type="date"
              value={task.earliest ?? ""}
              onChange={(e) => patch({ earliest: e.target.value || null })}
            />
          </label>
          <label>
            Finalización fijada (opcional)
            <input
              type="date"
              value={task.fixed_finish ?? ""}
              onChange={(e) => patch({ fixed_finish: e.target.value || null })}
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
              value={task.duration}
              onChange={(e) => patch({ duration: Number(e.target.value) })}
            />
          </label>
          <label>
            Avance real (%)
            <input
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
        <h3>Medición vinculada</h3>
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
        <h3>Predecesoras</h3>
        {task.links.map((l, i) => (
          <div className="tools" key={i}>
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
                .filter((a) => a.id !== task.id)
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
              {["FS", "SS", "FF", "SF"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <label>
              Desfase (d)
              <input
                type="number"
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
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button className="primary" disabled={busy}>
            Guardar actividad
          </button>
        </div>
      </form>
    </Modal>
  );
}
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
    [critical, setCritical] = useState(false);
  const rows = state.schedule.filter((a) => !critical || a.critical);
  const start = Math.min(...rows.map((r) => day(r.start))),
    end = Math.max(...rows.map((r) => day(r.finish))),
    span = end - start + 1;
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
          Calendario
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
      {!state.schedule.length ? (
        <Empty title="Programa la primera actividad">
          Define su duración o vincúlala a una cantidad de obra y a un
          rendimiento diario.
        </Empty>
      ) : (
        <>
          <div className="tools subsection">
            <label className="check">
              <input
                type="checkbox"
                checked={critical}
                onChange={(e) => setCritical(e.target.checked)}
              />
              Solo ruta crítica
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
          <div className="scroll">
            <div className="gantt" style={{ width: zoom + "%" }}>
              <div className="gantt-line head">
                <b>EDT / Actividad</b>
                <div className="axis">
                  {Number.isFinite(span) &&
                    Array.from({ length: Math.min(5, span) }, (_, i) => (
                      <span key={i}>
                        {dateLabel(
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
              </div>
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
                          <div className="group-row" key={code}>
                            {code} ·{" "}
                            {state.plan.groups[code] ?? "Grupo " + code}
                          </div>
                        )
                      );
                    })}
                  <div className="gantt-line">
                    <button
                      onClick={() =>
                        setEdit(state.plan.tasks.find((a) => a.id === t.id)!)
                      }
                    >
                      <small>{t.wbs}</small> {t.name}
                    </button>
                    <div className="track">
                      <button
                        className={"bar " + (t.critical ? "critical" : "")}
                        style={{
                          left: ((day(t.start) - start) / span) * 100 + "%",
                          width:
                            ((day(t.finish) - day(t.start) + 1) / span) * 100 +
                            "%",
                        }}
                        onClick={() =>
                          setEdit(state.plan.tasks.find((a) => a.id === t.id)!)
                        }
                        title={
                          t.name +
                          " · " +
                          t.start +
                          " → " +
                          t.finish +
                          " · Holgura " +
                          t.slack +
                          " d"
                        }
                        aria-label={"Editar " + t.name}
                      >
                        <i style={{ width: t.progress + "%" }} />
                        {t.duration} d
                      </button>
                    </div>
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
          <p className="legend">
            <i /> Ruta crítica · Selecciona una actividad para editarla
          </p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "Actividad",
                    "Inicio",
                    "Fin",
                    "Holgura",
                    "Vínculo BIM",
                    "Planificado¹",
                    "Real",
                  ].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.start}</td>
                    <td>{t.finish}</td>
                    <td>{t.slack} d</td>
                    <td>
                      {t.quantity
                        ? fmt(t.amount ?? 0) + " " + unitLabel(t.quantity.unit)
                        : "—"}
                    </td>
                    <td>{fmt(t.planned)} %</td>
                    <td>{fmt(t.progress)} %</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small>
            ¹ Avance lineal al cierre del día de hoy según el calendario
            laboral.
          </small>
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
