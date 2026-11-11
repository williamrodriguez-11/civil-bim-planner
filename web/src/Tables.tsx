import { useEffect, useState } from "react";
import {
  FileSpreadsheet,
  Upload,
  ArrowRight,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  api,
  cleanError,
  type Mapping,
  type Mutation,
  type Options,
  type QuantityTab,
  type Source,
  type State,
  type Table,
} from "./model";
import { Empty, Grid, Modal } from "./shared";

const defaults: Options = {
  header_row: 1,
  sheet: 0,
  encoding: "auto",
  delimiter: "auto",
  trim: false,
};
type Preview = {
  options: Options;
  table: Table | null;
  error: string | null;
  sheets: string[];
};
const fieldNames: Record<string, string> = {
  mass: "Masa",
  level: "Nivel",
  type: "Tipo",
  id: "ID",
  count: "Cantidad",
  volume: "Volumen",
  area: "Área",
  width: "Ancho",
  height: "Altura",
  depth: "Profundidad",
  thickness: "Espesor",
  length: "Longitud",
};
const dimensions: Record<string, string[]> = {
  Columnas: ["width", "depth", "height"],
  Vigas: ["width", "height", "length"],
  Losas: ["area", "thickness"],
  Muros: ["length", "height", "thickness"],
};
const aliases: Record<string, string[]> = {
  level: ["nivel", "level", "nivel base", "base level"],
  volume: ["volumen", "volume"],
  type: ["tipo", "familia y tipo", "type"],
  count: ["cantidad", "recuento", "count"],
  id: ["id", "id de elemento"],
};
const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

function Importer({
  mutate,
  selected,
  revising,
}: {
  mutate: Mutation;
  selected: (id: number) => void;
  revising?: { file: File; source: Source };
}) {
  const [queue, setQueue] = useState<File[]>(revising ? [revising.file] : []),
    [options, setOptions] = useState<Options>(
      revising?.source.options ?? defaults,
    ),
    [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [detect, setDetect] = useState(!revising);
  const [readAttempt, setReadAttempt] = useState(0);
  const file = queue[0];
  const importError = (error: unknown) =>
    error instanceof TypeError
      ? "No se pudo conectar con CIVIL BIM Planner. Abre «Iniciar CIVIL BIM Planner.cmd» y vuelve a intentarlo."
      : cleanError(error);
  function enqueue(files: FileList | null) {
    const selectedFiles = Array.from(files ?? []);
    if (selectedFiles.length)
      setQueue((current) => [...current, ...selectedFiles]);
  }
  useEffect(() => {
    setPreview(null);
    setError("");
    if (!file) return;
    const controller = new AbortController();
    const body = new FormData();
    body.append("file", file);
    body.append("options", JSON.stringify(options));
    body.append("detect", String(detect));
    api<Preview>("/preview", {
      method: "POST",
      body,
      signal: controller.signal,
    })
      .then((p) => {
        if (!controller.signal.aborted) setPreview(p);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(importError(e));
      });
    return () => controller.abort();
  }, [file, options, detect, readAttempt]);
  const applied = preview?.options ?? options;
  function change(v: Partial<Options>) {
    setPreview(null);
    const changingSheet = v.sheet !== undefined;
    setDetect(changingSheet);
    setOptions({
      ...applied,
      ...(changingSheet ? { header_row: 1 } : {}),
      ...v,
    });
  }
  function next() {
    setPreview(null);
    setQueue((q) => q.slice(1));
    setOptions(defaults);
    setDetect(true);
  }
  async function save() {
    if (!preview?.table || !file) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("options", JSON.stringify(preview.options));
      const { id } = revising
        ? await mutate(
            "/tables/" + revising.source.id + "/options",
            preview.options,
            "PUT",
          )
        : await mutate("/tables", body);
      next();
      selected(id);
    } catch (e) {
      setError(importError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="section-title">
        <Upload />
        <h2>{revising ? "Lectura del archivo original" : "Importar tablas"}</h2>
      </div>
      {!revising && (
        <label
          className="upload"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            enqueue(e.dataTransfer.files);
          }}
        >
          <Upload size={23} />
          <span>
            <strong>Seleccionar archivos</strong>
            <small>
              También puedes arrastrar aquí tu XLSX, XLS, CSV o texto tabulado ·
              Hasta 16 MiB por archivo
            </small>
          </span>
          <input
            aria-label="Seleccionar archivos"
            type="file"
            multiple
            accept=".xlsx,.xls,.csv,.txt,.tsv"
            onChange={(e) => {
              enqueue(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
          />
        </label>
      )}
      {file && (
        <div className="subsection">
          <strong>{file.name}</strong>
          <small> · {queue.length} en cola</small>
          <div className="form-grid">
            {!!preview?.sheets.length && (
              <label>
                Hoja
                <select
                  value={
                    typeof applied.sheet === "number"
                      ? preview.sheets[applied.sheet]
                      : applied.sheet
                  }
                  onChange={(e) => change({ sheet: e.target.value })}
                >
                  {preview.sheets.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Fila de encabezados
              <input
                type="number"
                min="1"
                value={applied.header_row}
                onChange={(e) =>
                  change({ header_row: Math.max(1, Number(e.target.value)) })
                }
              />
            </label>
            {!/\.xlsx?$/i.test(file.name) && (
              <>
                <label>
                  Delimitador
                  <select
                    value={applied.delimiter}
                    onChange={(e) => change({ delimiter: e.target.value })}
                  >
                    {[
                      ["auto", "Automático"],
                      [";", "Punto y coma"],
                      [",", "Coma"],
                      ["\t", "Tabulación"],
                    ].map(([v, n]) => (
                      <option key={v} value={v}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Codificación
                  <select
                    value={applied.encoding}
                    onChange={(e) => change({ encoding: e.target.value })}
                  >
                    {[
                      "auto",
                      "utf-8-sig",
                      "utf-16",
                      "utf-16-le",
                      "utf-16-be",
                      "cp1252",
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={applied.trim}
                onChange={(e) => change({ trim: e.target.checked })}
              />
              Quitar espacios externos
            </label>
          </div>
          {preview?.table && (
            <>
              <p>
                {preview.table.count} filas · {preview.table.columns.length}{" "}
                campos · {preview.table.duplicates} filas coincidentes
              </p>
              <Grid
                key={JSON.stringify(preview.options)}
                rows={preview.table.rows}
                columns={preview.table.columns}
              />
            </>
          )}
          {!preview && !error && <p role="status">Leyendo el archivo…</p>}
          <div className="actions">
            {error && !preview && (
              <button onClick={() => setReadAttempt((attempt) => attempt + 1)}>
                Reintentar lectura
              </button>
            )}
            {!revising && (
              <button disabled={busy} onClick={next}>
                Omitir archivo
              </button>
            )}
            <button
              className="primary"
              disabled={!preview?.table || busy}
              onClick={save}
            >
              {revising ? "Aplicar y recalcular" : "Guardar tabla"}{" "}
              <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}
      {(error || preview?.error) && (
        <p className="error" role="alert">
          {error || preview?.error}
        </p>
      )}
    </section>
  );
}

function Configure({
  table,
  source,
  state,
  mutate,
  viewQuantities,
}: {
  table: Table;
  source: Source;
  state: State;
  mutate: Mutation;
  viewQuantities: (tab: QuantityTab) => void;
}) {
  const saved = state.results[source.id];
  function suggested(): Mapping {
    const fields: Record<string, string> = {};
    for (const [k, label] of Object.entries(fieldNames)) {
      fields[k] =
        table.columns.find((c) =>
          (aliases[k] ?? [normalize(label)]).includes(normalize(c)),
        ) ?? "";
    }
    return {
      category: "",
      mode:
        !fields.volume &&
        [fields.area, fields.length, fields.mass, fields.count].some(Boolean)
          ? "inventory"
          : "direct",
      fields,
      units: {},
      decimal: ",",
      direct_basis: "row_total",
      excluded_rows: [],
      filter_column: null,
      filter_values: [],
      family: "",
      material: "",
      strength: "",
    };
  }
  const [mapping, setMapping] = useState<Mapping>(
      () => source.mapping ?? suggested(),
    ),
    [template, setTemplate] = useState(""),
    [excluded, setExcluded] = useState(
      (source.mapping?.excluded_rows ?? []).join(", "),
    ),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const change = (v: Partial<Mapping>) => {
    setMapping({ ...mapping, ...v });
    setMessage("");
  };
  const active = [
    "level",
    "type",
    "id",
    "count",
    ...(mapping.mode === "direct"
      ? ["volume", "area"]
      : mapping.mode === "inventory"
        ? ["volume", "area", "length", "mass"]
        : (dimensions[mapping.category] ?? [])),
  ];
  const select = (
    value: string,
    onChange: (val: string) => void,
    label?: string,
  ) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Sin asignar</option>
      {table.columns.map((k) => (
        <option key={k}>{k}</option>
      ))}
    </select>
  );
  async function save() {
    setMessage("");
    setBusy(true);
    try {
      const ids = excluded.trim()
        ? excluded.split(",").map((v) => Number(v.trim()))
        : [];
      if (ids.some((n) => !table.indexes.includes(n)))
        throw Error("Las filas excluidas deben existir en la tabla.");
      const fields = Object.fromEntries(
        active
          .filter((k) => mapping.fields[k])
          .map((k) => [k, mapping.fields[k]]),
      );
      await mutate(
        "/tables/" +
          source.id +
          "/mapping?template=" +
          encodeURIComponent(template),
        {
          ...mapping,
          category:
            mapping.category.trim() ||
            (mapping.category_field ? source.name : ""),
          excluded_rows: ids,
          fields,
        },
        "PUT",
      );
    } catch (e) {
      setMessage(cleanError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="subsection">
      <div className="section-title">
        <SlidersHorizontal />
        <h3>Clasificación y mediciones</h3>
      </div>
      {!!Object.keys(state.templates).length && (
        <label>
          Aplicar plantilla
          <select
            defaultValue=""
            onChange={(e) => {
              const t = state.templates[e.target.value];
              if (t) {
                setMapping({ ...suggested(), ...t });
                setExcluded("");
                setMessage(
                  "Verifica las asignaciones y unidades antes de guardar.",
                );
              }
            }}
          >
            <option value="">Seleccionar plantilla</option>
            {Object.keys(state.templates).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      )}
      <div className="form-grid">
        <label>
          Categoría
          <input
            list="categories"
            placeholder="Ej. Zapatas"
            value={mapping.category}
            onChange={(e) =>
              change({
                category: e.target.value,
                mode:
                  mapping.mode === "dimensions" && !dimensions[e.target.value]
                    ? "direct"
                    : mapping.mode,
              })
            }
          />
          <datalist id="categories">
            {[
              ...new Set([
                ...Object.keys(dimensions),
                ...state.tables
                  .map((s) => s.mapping?.category ?? "")
                  .filter(Boolean),
              ]),
            ].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </datalist>
        </label>
        <label>
          Método
          <select
            value={mapping.mode}
            onChange={(e) => change({ mode: e.target.value })}
          >
            <option value="direct">Volumen de origen</option>
            <option value="inventory">
              Inventario · unidades, m lineales, m², m³ y kg
            </option>
            <option
              value="dimensions"
              disabled={
                !Object.hasOwn(dimensions, mapping.category) ||
                !!mapping.category_field
              }
            >
              Calcular por dimensiones
            </option>
          </select>
        </label>
        <label>
          Decimal en texto
          <select
            value={mapping.decimal}
            onChange={(e) => change({ decimal: e.target.value })}
          >
            <option value=",">Coma decimal</option>
            <option value=".">Punto decimal</option>
          </select>
        </label>
        {mapping.mode !== "dimensions" && (
          <label>
            Categoría desde una columna (opcional)
            {select(mapping.category_field ?? "", (value) =>
              change({ category_field: value }),
            )}
          </label>
        )}
        {mapping.mode !== "dimensions" && (
          <label>
            Base de medición
            <select
              value={mapping.direct_basis}
              onChange={(e) => change({ direct_basis: e.target.value })}
            >
              <option value="row_total">Total de cada fila</option>
              <option value="per_element">Medición por elemento</option>
            </select>
          </label>
        )}
      </div>
      <p>
        {mapping.mode === "direct"
          ? "Asigna nivel y volumen. Sin campo de cantidad, una fila válida representa un elemento."
          : mapping.mode === "inventory"
            ? "Asigna nivel y las mediciones disponibles. Sin campo de cantidad, una fila válida representa un elemento."
            : "Las dimensiones son por elemento. La geometría rectangular se multiplica por la cantidad, sin descontar huecos."}{" "}
        Confirma cada unidad de origen.
      </p>
      <div className="form-grid">
        {active.map((k) => (
          <label key={k}>
            {fieldNames[k]}
            {select(
              mapping.fields[k] ?? "",
              (val) => change({ fields: { ...mapping.fields, [k]: val } }),
              fieldNames[k],
            )}
            {mapping.fields[k] &&
              !["level", "type", "id", "count"].includes(k) && (
                <select
                  aria-label={"Unidad de " + fieldNames[k]}
                  value={mapping.units[k] ?? ""}
                  onChange={(e) =>
                    change({ units: { ...mapping.units, [k]: e.target.value } })
                  }
                >
                  <option value="">Confirmar unidad…</option>
                  {(k === "mass"
                    ? ["kg", "g", "t", "lb"]
                    : ["m", "cm", "mm", "ft"]
                  )
                    .map(
                      (u) =>
                        u + (k === "area" ? "²" : k === "volume" ? "³" : ""),
                    )
                    .map((u) => (
                      <option key={u} value={u}>
                        {k === "length" && u === "m" ? "m (metro lineal)" : u}
                      </option>
                    ))}
                </select>
              )}
          </label>
        ))}
        {(["family", "material", "strength"] as const).map((k, i) => (
          <label key={k}>
            {["Familia", "Material", "Resistencia"][i]}
            {select(mapping[k], (val) => change({ [k]: val }))}
          </label>
        ))}
      </div>
      <details>
        <summary>Filtros, exclusiones y plantilla</summary>
        <div className="form-grid">
          <label>
            Excluir filas de origen
            <input
              value={excluded}
              onChange={(e) => setExcluded(e.target.value)}
              placeholder="Ej. 3, 7"
            />
          </label>
          <label>
            Filtrar por campo
            {select(mapping.filter_column ?? "", (val) =>
              change({ filter_column: val || null, filter_values: [] }),
            )}
          </label>
          {mapping.filter_column && (
            <label>
              Valores incluidos
              <select
                multiple
                value={mapping.filter_values}
                onChange={(e) =>
                  change({
                    filter_values: Array.from(
                      e.target.selectedOptions,
                      (o) => o.value,
                    ),
                  })
                }
              >
                {Array.from(
                  new Set(
                    table.rows.map((r) =>
                      String(r[mapping.filter_column!] ?? ""),
                    ),
                  ),
                ).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Atributos adicionales
            <select
              multiple
              value={mapping.attributes ?? []}
              onChange={(e) =>
                change({
                  attributes: Array.from(
                    e.target.selectedOptions,
                    (o) => o.value,
                  ),
                })
              }
            >
              {table.columns.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Guardar plantilla con nombre
            <input
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="Opcional"
            />
          </label>
        </div>
      </details>
      <button className="primary" disabled={busy} onClick={save}>
        Calcular y guardar
      </button>
      {message && (
        <p role="status" className="error">
          {message}
        </p>
      )}
      {saved && (
        <div className={saved.detail.length ? "notice" : "error"}>
          <p role="status">
            {saved.detail.length
              ? `Cuantificación guardada. Filas cuantificadas: ${saved.detail.length}. Incidencias: ${saved.issues.length}.`
              : `Último cálculo guardado sin filas cuantificadas. Incidencias: ${saved.issues.length}. ${saved.issues[0]?.Motivo ?? ""}`}
          </p>
          <div className="tools">
            {!!saved.detail.length && (
              <button onClick={() => viewQuantities("Detalle")}>
                Ver detalle del proyecto
              </button>
            )}
            {!!saved.issues.length && (
              <button onClick={() => viewQuantities("Incidencias")}>
                Ver incidencias del proyecto
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function Tables({
  state,
  mutate,
  viewQuantities,
}: {
  state: State;
  mutate: Mutation;
  viewQuantities: (tab: QuantityTab) => void;
}) {
  const [selectedId, setId] = useState<number>(state.tables[0]?.id ?? 0),
    [loaded, setLoaded] = useState<{ id: number; table: Table } | null>(null),
    [error, setError] = useState("");
  type TableRef = Pick<Source, "id" | "name" | "sheet">;
  const [dialog, setDialog] = useState<
      { kind: "delete"; target: TableRef } | { kind: "trash" } | null
    >(null),
    [pending, setPending] = useState(false),
    [actionError, setActionError] = useState(""),
    [notice, setNotice] = useState("");
  const [revising, setRevising] = useState<{
      file: File;
      source: Source;
    } | null>(null),
    [version, setVersion] = useState(0);
  const source =
    state.tables.find((s) => s.id === selectedId) ?? state.tables[0];
  const id = source?.id ?? 0;
  const table = loaded?.id === id ? loaded.table : null;
  const label = (s: TableRef) => (s.sheet ? s.name + " · " + s.sheet : s.name);
  function closeDialog() {
    if (!pending) {
      setDialog(null);
      setActionError("");
    }
  }
  async function changeTrash(target: TableRef, restore: boolean) {
    setPending(true);
    setActionError("");
    setNotice("");
    try {
      await mutate(
        "/tables/" + target.id + (restore ? "/restore" : ""),
        {},
        restore ? "POST" : "DELETE",
      );
      if (restore) setId(target.id);
      setDialog(null);
      setNotice(
        restore
          ? `Se restauró «${label(target)}».`
          : `Se movió «${label(target)}» a la papelera.`,
      );
    } catch (e) {
      setActionError(cleanError(e));
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    setLoaded(null);
    setError("");
    if (!id) return;
    let live = true;
    api<Table>("/projects/" + state.project.id + "/tables/" + id)
      .then((t) => {
        if (live) setLoaded({ id, table: t });
      })
      .catch((e) => {
        if (live) setError(cleanError(e));
      });
    return () => {
      live = false;
    };
  }, [id, state.project.id, version]);
  return (
    <>
      <Importer mutate={mutate} selected={setId} />
      <section className="panel">
        <div className="section-title">
          <FileSpreadsheet />
          <h2>Biblioteca de tablas</h2>
        </div>
        {!!state.trashed_tables.length && (
          <button onClick={() => setDialog({ kind: "trash" })}>
            <Trash2 size={15} /> Papelera de tablas (
            {state.trashed_tables.length})
          </button>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {!source ? (
          <Empty title="La biblioteca está vacía">
            Selecciona un archivo y revisa sus encabezados para incorporarlo al
            proyecto.
          </Empty>
        ) : (
          <>
            {revising && (
              <Modal
                title="Revisar importación"
                close={() => setRevising(null)}
              >
                <Importer
                  revising={revising}
                  mutate={mutate}
                  selected={() => {
                    setRevising(null);
                    setVersion(version + 1);
                  }}
                />
              </Modal>
            )}
            <label>
              Tabla activa
              <select value={id} onChange={(e) => setId(+e.target.value)}>
                {state.tables.map((s) => (
                  <option key={s.id} value={s.id}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </label>
            <div className="tools">
              <a
                className="btn"
                download
                href={
                  "/api/projects/" +
                  state.project.id +
                  "/tables/" +
                  id +
                  "/original"
                }
              >
                Descargar original
              </a>
              <button
                onClick={async () => {
                  try {
                    const res = await fetch(
                      "/api/projects/" +
                        state.project.id +
                        "/tables/" +
                        id +
                        "/original",
                    );
                    if (!res.ok) throw Error("No se pudo abrir el original.");
                    setRevising({
                      file: new File([await res.blob()], source.name),
                      source,
                    });
                  } catch (e) {
                    setError(cleanError(e));
                  }
                }}
              >
                Revisar importación
              </button>
              <button
                onClick={() => setDialog({ kind: "delete", target: source })}
              >
                <Trash2 size={15} /> Borrar tabla
              </button>
            </div>
            {error && <p className="error">{error}</p>}
            {table ? (
              <>
                <div className="chips">
                  {table.fields.map((f) => (
                    <span key={f.name}>
                      {f.name} · {f.kind}
                      {f.unit ? " · " + f.unit : ""}
                      {f.empty ? " · " + f.empty + " vacíos" : ""}
                    </span>
                  ))}
                </div>
                <details>
                  <summary>Revisar filas de origen</summary>
                  <Grid
                    key={id}
                    rows={table.rows.map((r, i) =>
                      Object.fromEntries([
                        ["#", table.indexes[i]],
                        ...Object.entries(r),
                      ]),
                    )}
                  />
                </details>
                <Configure
                  key={id}
                  table={table}
                  source={source}
                  state={state}
                  mutate={mutate}
                  viewQuantities={viewQuantities}
                />
              </>
            ) : (
              <p>Cargando tabla…</p>
            )}
          </>
        )}
      </section>
      {dialog && (
        <Modal
          title={
            dialog.kind === "trash" ? "Papelera de tablas" : "Borrar tabla"
          }
          close={closeDialog}
        >
          {dialog.kind === "delete" ? (
            <>
              <p>
                ¿Mover <strong>«{label(dialog.target)}»</strong> a la papelera?
                Sus cantidades dejarán de aparecer en los totales y en los
                nuevos reportes. Podrás restaurarla con su configuración.
              </p>
              <div className="actions">
                <button autoFocus disabled={pending} onClick={closeDialog}>
                  Cancelar
                </button>
                <button
                  className="primary"
                  disabled={pending}
                  onClick={() => changeTrash(dialog.target, false)}
                >
                  Mover a la papelera
                </button>
              </div>
            </>
          ) : (
            state.trashed_tables.map((s) => (
              <div key={s.id} className="report">
                <span>{label(s)}</span>
                <button disabled={pending} onClick={() => changeTrash(s, true)}>
                  <Undo2 size={15} /> Restaurar
                </button>
              </div>
            ))
          )}
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
