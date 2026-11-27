import { useState } from "react";
import { Building2, FileSpreadsheet, Trash2, Undo2 } from "lucide-react";
import {
  cleanError,
  dateLabel,
  type Mutation,
  type Project,
  type State,
} from "./model";
import { Empty, Modal } from "./shared";

type TableRef = State["trashed_tables"][number];
const label = (s: TableRef) => (s.sheet ? s.name + " · " + s.sheet : s.name);

/** One place to recover or permanently delete projects and tables. */
export function Trash({
  projects,
  state,
  mutate,
  pending,
  restoreProject,
  purgeProjects,
}: {
  projects: Project[];
  state: State | null;
  mutate: Mutation;
  pending: boolean;
  restoreProject: (p: Project) => void;
  purgeProjects: (list: Project[]) => void;
}) {
  const tables = state?.trashed_tables ?? [],
    [busy, setBusy] = useState(false),
    [toPurge, setToPurge] = useState<TableRef[] | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function run(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(message);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }
  async function purgeTables(list: TableRef[]) {
    let done = 0;
    await run(
      async () => {
        try {
          for (const t of list) {
            await mutate("/tables/" + t.id + "/permanent", {}, "DELETE");
            done++;
          }
        } catch (e) {
          throw Error(
            (done ? `Se eliminaron ${done} de ${list.length}. ` : "") +
              cleanError(e),
          );
        } finally {
          setToPurge(null);
        }
      },
      list.length === 1
        ? `Se eliminó definitivamente «${label(list[0])}».`
        : `Se eliminaron definitivamente ${list.length} tablas.`,
    );
  }
  const locked = pending || busy;
  return (
    <>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="panel trash-section">
        <div className="section-title">
          <Building2 />
          <h2>Proyectos</h2>
          {!!projects.length && (
            <button
              className="right"
              disabled={locked}
              onClick={() => purgeProjects(projects)}
            >
              <Trash2 size={15} /> Vaciar proyectos
            </button>
          )}
        </div>
        {projects.length ? (
          projects.map((p) => (
            <div className="trash-row" key={p.id}>
              <div>
                <strong>{p.name}</strong>
                <small>
                  {p.location || p.kind}
                  {p.deleted_at && " · enviado el " + dateLabel(p.deleted_at)}
                </small>
              </div>
              <button disabled={locked} onClick={() => restoreProject(p)}>
                <Undo2 size={15} /> Restaurar
              </button>
              <button
                disabled={locked}
                aria-label={`Eliminar definitivamente ${p.name}`}
                onClick={() => purgeProjects([p])}
              >
                <Trash2 size={15} /> Eliminar
              </button>
            </div>
          ))
        ) : (
          <Empty title="No hay proyectos en la papelera" />
        )}
      </section>
      <section className="panel trash-section">
        <div className="section-title">
          <FileSpreadsheet />
          <h2>
            Tablas{state ? " · " + state.project.name : ""}
          </h2>
          {!!tables.length && (
            <button
              className="right"
              disabled={locked}
              onClick={() => setToPurge(tables)}
            >
              <Trash2 size={15} /> Vaciar tablas
            </button>
          )}
        </div>
        {!state ? (
          <Empty title="Abre un proyecto para ver sus tablas borradas" />
        ) : tables.length ? (
          tables.map((t) => (
            <div className="trash-row" key={t.id}>
              <div>
                <strong>{label(t)}</strong>
                <small>Tabla de origen</small>
              </div>
              <button
                disabled={locked}
                onClick={() =>
                  run(
                    () =>
                      mutate("/tables/" + t.id + "/restore", {}).then(() => {}),
                    `Se restauró «${label(t)}».`,
                  )
                }
              >
                <Undo2 size={15} /> Restaurar
              </button>
              <button
                disabled={locked}
                aria-label={`Eliminar definitivamente ${label(t)}`}
                onClick={() => setToPurge([t])}
              >
                <Trash2 size={15} /> Eliminar
              </button>
            </div>
          ))
        ) : (
          <Empty title="No hay tablas en la papelera de este proyecto" />
        )}
      </section>
      {toPurge && (
        <Modal
          title="Eliminar definitivamente"
          close={() => !busy && setToPurge(null)}
        >
          <p>
            {toPurge.length === 1 ? (
              <>
                ¿Eliminar <strong>«{label(toPurge[0])}»</strong> para siempre?
              </>
            ) : (
              <>¿Eliminar para siempre las {toPurge.length} tablas?</>
            )}{" "}
            Se borrarán el archivo original, su configuración y sus cantidades.
            Los reportes ya generados se conservan.{" "}
            <strong>No se puede deshacer.</strong>
          </p>
          <div className="actions">
            <button
              autoFocus
              disabled={busy}
              onClick={() => setToPurge(null)}
            >
              Cancelar
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => purgeTables(toPurge)}
            >
              Eliminar definitivamente
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
