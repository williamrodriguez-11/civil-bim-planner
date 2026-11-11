import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  Building2,
  CalendarRange,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  FileBarChart,
  Files,
  FolderOpen,
  Layers3,
  LayoutDashboard,
  Menu,
  Moon,
  Plus,
  Ruler,
  Sun,
  Trash2,
  Undo2,
} from "lucide-react";
import "@fontsource-variable/inter";
import "./style.css";
import {
  api,
  cleanError,
  dateLabel,
  type Mutation,
  type Page,
  type QuantityTab,
  type Project,
  type State,
} from "./model";
import { Empty, Modal } from "./shared";
import { Overview, Quantities } from "./Overview";
import { Schedule } from "./Schedule";
import { Tables } from "./Tables";
import { Account } from "./Account";

const modules = [
  { name: "Resumen", I: LayoutDashboard },
  { name: "Proyectos", I: FolderOpen },
  { name: "Tablas de origen", I: Files },
  { name: "Cuantificación", I: Ruler },
  { name: "Programación", I: CalendarRange },
  { name: "Reportes", I: FileBarChart },
] as const;
const description: Record<Page, string> = {
  Resumen: "Una vista integrada de las cantidades y el avance de obra.",
  Proyectos: "Administra las fichas y los espacios de trabajo de tus obras.",
  "Tablas de origen": "Importa, revisa y clasifica los datos de tus modelos.",
  Cuantificación: "Consulta las cantidades por nivel, categoría y material.",
  Programación:
    "Vincula mediciones, rendimientos y dependencias al calendario de obra.",
  Reportes: "Genera y consulta entregables técnicos del proyecto.",
};
type Fields = Pick<
  Project,
  "name" | "description" | "location" | "kind" | "status"
>;
function ProjectForm({
  initial,
  close,
  save,
}: {
  initial: Project | null;
  close: () => void;
  save: (f: Fields) => Promise<void>;
}) {
  const [fields, setFields] = useState<Fields>(
      initial ?? {
        name: "",
        description: "",
        location: "",
        kind: "Edificación",
        status: "En estudio",
      },
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={initial ? "Editar ficha del proyecto" : "Crear proyecto"}
      close={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await save({
              name: fields.name,
              description: fields.description,
              location: fields.location,
              kind: fields.kind,
              status: fields.status,
            });
            close();
          } catch (e) {
            setError(cleanError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Nombre del proyecto
          <input
            autoFocus
            required
            maxLength={160}
            placeholder="Ej. Ampliación del bloque norte"
            value={fields.name}
            onChange={(e) => setFields({ ...fields, name: e.target.value })}
          />
        </label>
        <label>
          Descripción
          <textarea
            rows={3}
            maxLength={4000}
            value={fields.description}
            onChange={(e) =>
              setFields({ ...fields, description: e.target.value })
            }
          />
        </label>
        <div className="form-grid">
          <label>
            Tipo de proyecto
            <input
              required
              list="kinds"
              value={fields.kind}
              onChange={(e) => setFields({ ...fields, kind: e.target.value })}
            />
            <datalist id="kinds">
              {[
                "Edificación",
                "Infraestructura vial",
                "Obra hidráulica",
                "Puente",
                "Industrial",
              ].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </datalist>
          </label>
          <label>
            Estado
            <select
              value={fields.status}
              onChange={(e) => setFields({ ...fields, status: e.target.value })}
            >
              {["En estudio", "En ejecución", "Finalizado"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Ubicación (opcional)
          <input
            value={fields.location}
            onChange={(e) => setFields({ ...fields, location: e.target.value })}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {initial ? "Guardar cambios" : "Crear proyecto"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Reports({ state, mutate }: { state: State; mutate: Mutation }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const url = "/api/projects/" + state.project.id + "/reports/";
  return (
    <section className="panel">
      <div className="section-title">
        <FileBarChart />
        <h2>Reportes de cuantificación</h2>
      </div>
      <p>
        El libro Excel conserva el resumen por nivel, detalle, incidencias,
        configuración y fuentes de la revisión generada.
      </p>
      <button
        className="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const { id } = await mutate("/reports", {});
            const a = document.createElement("a");
            a.href = url + id;
            a.download = "";
            a.click();
          } catch (e) {
            setError(cleanError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download size={16} />
        Generar Excel
      </button>
      {error && <p className="error">{error}</p>}
      <div className="subsection">
        <h3>Historial de reportes</h3>
        {state.reports.length ? (
          state.reports.map((r) => (
            <a className="report" key={r.id} download href={url + r.id}>
              <FileBarChart />
              {r.name}
              <small>
                #{r.id} · {dateLabel(r.created)}
              </small>
              <Download size={15} />
            </a>
          ))
        ) : (
          <Empty title="Todavía no hay reportes" />
        )}
      </div>
    </section>
  );
}
function App({ username, logout }: { username: string; logout: () => Promise<void> }) {
  const selectionKey = "civil-project:" + username;
  const [catalog, setCatalog] = useState<Project[]>([]),
    [state, setState] = useState<State | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [page, setPage] = useState<Page>("Resumen"),
    [quantityTab, setQuantityTab] = useState<QuantityTab>(),
    [form, setForm] = useState<"new" | "edit" | null>(null);
  const [showTrash, setShowTrash] = useState(false),
    [toDelete, setToDelete] = useState<Project | null>(null),
    [pending, setPending] = useState(false),
    [actionError, setActionError] = useState(""),
    [notice, setNotice] = useState("");
  const projects = catalog.filter((p) => !p.deleted_at);
  const visibleProjects = showTrash
    ? catalog.filter((p) => p.deleted_at)
    : projects;
  const [compact, setCompact] = useState(false),
    [mobile, setMobile] = useState(false),
    [dark, setDark] = useState(localStorage.getItem("civil-theme") === "dark");
  const current = useRef(0),
    epoch = useRef(0);
  async function load(id: number) {
    const run = ++epoch.current;
    current.current = id;
    setLoading(true);
    setError("");
    setState(null);
    try {
      if (id) {
        const s = await api<State>("/projects/" + id);
        if (run === epoch.current) {
          setState(s);
          setCatalog((list) => list.map((p) => (p.id === id ? s.project : p)));
          localStorage.setItem(selectionKey, String(id));
        }
      } else localStorage.removeItem(selectionKey);
    } catch (e) {
      if (run === epoch.current) setError(cleanError(e));
    } finally {
      if (run === epoch.current) setLoading(false);
    }
  }
  async function init() {
    setLoading(true);
    setError("");
    try {
      const list = await api<Project[]>("/projects?include_deleted=true");
      setCatalog(list);
      const active = list.filter((p) => !p.deleted_at);
      const id =
        current.current || Number(localStorage.getItem(selectionKey));
      await load(active.some((p) => p.id === id) ? id : (active[0]?.id ?? 0));
    } catch (e) {
      setError(cleanError(e));
      setLoading(false);
    }
  }
  useEffect(() => {
    void init();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("civil-theme", dark ? "dark" : "light");
  }, [dark]);
  const mutate: Mutation = async (path, body, method = "POST") => {
    if (!state) throw Error("Selecciona un proyecto.");
    const p = state.project,
      isForm = body instanceof FormData;
    const result = await api<{ id: number }>("/projects/" + p.id + path, {
      method,
      headers: {
        "If-Match": String(p.revision),
        ...(isForm ? {} : { "Content-Type": "application/json" }),
      },
      body: isForm ? body : JSON.stringify(body),
    });
    const updated = await api<State>("/projects/" + p.id);
    if (current.current === p.id) {
      setState(updated);
      setCatalog((list) =>
        list.map((x) => (x.id === p.id ? updated.project : x)),
      );
    }
    return result;
  };
  function closeDeleteDialog() {
    if (!pending) {
      setToDelete(null);
      setActionError("");
    }
  }
  async function changeProjectVisibility(p: Project) {
    setPending(true);
    setActionError("");
    setNotice("");
    try {
      await api("/projects/" + p.id + (p.deleted_at ? "/restore" : ""), {
        method: p.deleted_at ? "POST" : "DELETE",
        headers: { "If-Match": String(p.revision) },
      });
      setToDelete(null);
      setNotice(
        p.deleted_at
          ? `Se restauró «${p.name}».`
          : `Se movió «${p.name}» a la papelera.`,
      );
      await init();
    } catch (e) {
      setActionError(cleanError(e));
    } finally {
      setPending(false);
    }
  }
  const go = (p: Page, tab?: QuantityTab) => {
    setQuantityTab(tab);
    setPage(p);
    setShowTrash(false);
    setNotice("");
    setActionError("");
    setMobile(false);
    window.scrollTo(0, 0);
  };
  const newProjectButton = (
    <button onClick={() => setForm("new")}>
      <Plus size={15} /> Nuevo proyecto
    </button>
  );
  const nav = (subset: (typeof modules)[number][]) =>
    subset.map(({ name, I }) => (
      <button
        key={name}
        className={"nav " + (page === name ? "selected" : "")}
        title={name}
        aria-current={page === name ? "page" : undefined}
        onClick={() => go(name)}
      >
        <I size={18} />
        <span>{name}</span>
      </button>
    ));
  return (
    <div
      className={
        "shell " + (compact ? "compact " : "") + (mobile ? "mobile-open" : "")
      }
    >
      {mobile && (
        <button
          aria-label="Cerrar navegación"
          className="scrim"
          onClick={() => setMobile(false)}
        />
      )}
      <aside>
        <div className="brand">
          <div className="brandmark">
            <Layers3 />
          </div>
          <div>
            <b>CIVIL BIM</b>
            <span>PLANNER</span>
          </div>
        </div>
        <div className="nav-group">
          <div className="nav-title">ESPACIO DE TRABAJO</div>
          {nav(modules.slice(0, 2))}
        </div>
        <div className="nav-group">
          <div className="nav-title">MÓDULOS</div>
          {nav(modules.slice(2))}
        </div>
        <div className="side-bottom">
          <div className="local">
            <i /> {username}
          </div>
          <button onClick={() => logout().catch((e) => setError(cleanError(e)))}>Cerrar sesión</button>
          <button
            className="collapse"
            title="Plegar navegación"
            onClick={() => {
              setCompact(!compact);
              setMobile(false);
            }}
          >
            {compact ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            <span>Contraer panel</span>
          </button>
        </div>
      </aside>
      <main>
        <header>
          <button className="hamb" title="Menú" onClick={() => setMobile(true)}>
            <Menu size={18} />
          </button>
          <span className="breadcrumb">
            <Building2 size={15} /> Espacio de trabajo{" "}
            <ChevronRight size={13} /> <b>{page}</b>
          </span>
          <div className="top-tools">
            {!!projects.length && (
              <select
                aria-label="Proyecto activo"
                value={current.current || ""}
                onChange={(e) => load(+e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button title="Actualizar proyecto" onClick={init}>
              <Activity size={16} />
            </button>
            <button
              title={dark ? "Modo claro" : "Modo oscuro"}
              aria-label={dark ? "Modo claro" : "Modo oscuro"}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>
        <div className="content">
          <div className="page-head">
            <div>
              <div className="eyebrow">
                <i />
                {page === "Resumen"
                  ? "CENTRO DE CONTROL"
                  : page === "Proyectos"
                    ? "ESPACIO DE TRABAJO"
                    : "MÓDULO DE PROYECTO"}
              </div>
              <h1>
                {page === "Resumen"
                  ? "Resumen general"
                  : page === "Proyectos" && showTrash
                    ? "Papelera"
                    : page}
              </h1>
              <p>
                {page === "Proyectos" && showTrash
                  ? "Restaura un proyecto para volver a trabajar con sus datos."
                  : description[page]}
              </p>
            </div>
            {page === "Resumen" && newProjectButton}
            {page === "Proyectos" && (
              <div className="tools project-tools">
                <button
                  onClick={() => {
                    setShowTrash(!showTrash);
                    setNotice("");
                    setActionError("");
                  }}
                >
                  {showTrash ? <FolderOpen size={15} /> : <Trash2 size={15} />}
                  {showTrash ? "Volver a proyectos" : "Papelera"}
                </button>
                {!showTrash && newProjectButton}
              </div>
            )}
          </div>
          {error && (
            <div className="error" role="alert">
              {error} <button onClick={init}>Reintentar</button>
            </div>
          )}
          {loading ? (
            <section className="panel" role="status">
              Cargando espacio de trabajo…
            </section>
          ) : page === "Resumen" ? (
            <Overview
              state={state}
              projects={projects.length}
              go={go}
              create={() => setForm("new")}
            />
          ) : page === "Proyectos" ? (
            <>
              {notice && (
                <p className="notice" role="status">
                  {notice}
                </p>
              )}
              {actionError && !toDelete && (
                <p className="error" role="alert">
                  {actionError}
                </p>
              )}
              <div className="project-list">
                {visibleProjects.map((p) => (
                  <section className="panel" key={p.id}>
                    <div className="section-title">
                      <Building2 />
                      <small>{p.status}</small>
                    </div>
                    <h2>{p.name}</h2>
                    <p>{p.description || p.kind}</p>
                    <small>
                      {p.location || p.kind} · {dateLabel(p.created)}
                    </small>
                    <div className="actions">
                      {showTrash ? (
                        <button
                          disabled={pending}
                          onClick={() => changeProjectVisibility(p)}
                        >
                          <Undo2 size={15} /> Restaurar
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={async () => {
                              await load(p.id);
                              go("Resumen");
                            }}
                          >
                            Abrir <ArrowRight size={15} />
                          </button>
                          {state?.project.id === p.id && (
                            <button onClick={() => setForm("edit")}>
                              Editar ficha
                            </button>
                          )}
                          <button
                            disabled={pending}
                            onClick={() => {
                              setActionError("");
                              setToDelete(p);
                            }}
                          >
                            <Trash2 size={15} /> Borrar proyecto
                          </button>
                        </>
                      )}
                    </div>
                  </section>
                ))}
                {!visibleProjects.length &&
                  (showTrash ? (
                    <Empty title="La papelera está vacía" />
                  ) : (
                    <Empty title="Crea tu primer proyecto">
                      Usa Nuevo proyecto para guardar su ficha y comenzar la
                      importación.
                    </Empty>
                  ))}
              </div>
            </>
          ) : !state ? (
            <section className="panel">
              <Empty title="Selecciona o crea un proyecto">
                Cada módulo utiliza los datos del proyecto activo.
              </Empty>
              <button className="primary" onClick={() => setForm("new")}>
                Crear proyecto
              </button>
            </section>
          ) : (
            <div key={state.project.id}>
              {page === "Tablas de origen" ? (
                <Tables
                  state={state}
                  mutate={mutate}
                  viewQuantities={(tab) => go("Cuantificación", tab)}
                />
              ) : page === "Cuantificación" ? (
                <Quantities state={state} initialTab={quantityTab} />
              ) : page === "Programación" ? (
                <Schedule state={state} mutate={mutate} />
              ) : (
                <Reports state={state} mutate={mutate} />
              )}
            </div>
          )}
        </div>
      </main>
      {form && (
        <ProjectForm
          initial={form === "edit" ? (state?.project ?? null) : null}
          close={() => setForm(null)}
          save={async (f) => {
            if (form === "edit") {
              await mutate("", f, "PUT");
            } else {
              const p = await api<{ id: number }>("/projects", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(f),
              });
              setCatalog(
                await api<Project[]>("/projects?include_deleted=true"),
              );
              await load(p.id);
              go("Resumen");
            }
          }}
        />
      )}
      {toDelete && (
        <Modal title="Borrar proyecto" close={closeDeleteDialog}>
          <p>
            ¿Mover <strong>«{toDelete.name}»</strong> a la papelera? Podrás
            restaurarlo con sus tablas, cronograma y reportes.
          </p>
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
          <div className="actions">
            <button autoFocus disabled={pending} onClick={closeDeleteDialog}>
              Cancelar
            </button>
            <button
              className="primary"
              disabled={pending}
              onClick={() => changeProjectVisibility(toDelete)}
            >
              Mover a la papelera
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <Account>{(username, logout) => <App key={username} username={username} logout={logout} />}</Account>
);
