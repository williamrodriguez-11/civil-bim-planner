import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Search,
  X,
} from "lucide-react";
import { fmt, type Row } from "./model";

export function Modal({
  title,
  children,
  close,
  className,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className={className}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button aria-label="Cerrar" onClick={close}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
export function Grid({
  rows,
  columns,
  rowAction,
}: {
  rows: Row[];
  columns?: string[];
  rowAction?: (row: Row) => React.ReactNode;
}) {
  const keys = useMemo(
    () => columns ?? Array.from(new Set(rows.flatMap((r) => Object.keys(r)))),
    [rows, columns],
  );
  const [selection, setVisible] = useState<string[] | null>(null),
    [field, setField] = useState(""),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState(""),
    [asc, setAsc] = useState(true),
    [page, setPage] = useState(0),
    [settings, setSettings] = useState(false),
    [group, setGroup] = useState("");
  const visible = selection ?? keys;
  // Numeric columns are summed inside groups; only text columns can group.
  const numeric = useMemo(
    () =>
      new Set(
        keys.filter((k) =>
          rows.some((r) => typeof r[k] === "number") &&
          rows.every((r) => r[k] === null || r[k] === undefined || typeof r[k] === "number"),
        ),
      ),
    [rows, keys],
  );
  const groupable = keys.filter((k) => !numeric.has(k));
  const view = rows.filter((r) =>
    (field ? [field] : keys).some((k) =>
      String(r[k] ?? "")
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    ),
  );
  if (sort) {
    // One comparison per column: numbers as numbers (empty last), else text.
    const byNumber = numeric.has(sort);
    view.sort((a, b) => {
      const x = a[sort],
        y = b[sort];
      if (byNumber) {
        if (typeof x !== "number" || typeof y !== "number")
          return typeof x === "number" ? -1 : typeof y === "number" ? 1 : 0;
        return (x - y) * (asc ? 1 : -1);
      }
      return (
        String(x ?? "").localeCompare(String(y ?? ""), "es", {
          numeric: true,
        }) * (asc ? 1 : -1)
      );
    });
  }
  const activeGroup = groupable.includes(group) ? group : "";
  // Row numbers and identifiers are not quantities: never summed.
  const sums = [...numeric].filter(
    (k) => visible.includes(k) && !["#", "Fila origen", "ID"].includes(k),
  );
  // The count must not collide with a column of the file called «Filas».
  const countKey = keys.includes("Filas") ? "N.º de filas" : "Filas";
  const groups = new Map<string, { row: Row; categories: Set<string> }>();
  if (activeGroup)
    for (const r of view) {
      const key = String(r[activeGroup] ?? "—");
      const entry = groups.get(key) ?? {
        row: {
          [activeGroup]: key,
          [countKey]: 0,
          ...Object.fromEntries(sums.map((k) => [k, 0])),
        } as Row,
        categories: new Set<string>(),
      };
      const total = entry.row;
      total[countKey] = (total[countKey] as number) + 1;
      if (r.Categoría !== undefined) entry.categories.add(String(r.Categoría));
      for (const k of sums) {
        // One row without the value makes the group total unknown.
        if (typeof r[k] !== "number" || total[k] === null) total[k] = null;
        else total[k] = (total[k] as number) + (r[k] as number);
      }
      groups.set(key, entry);
    }
  const output: Row[] = activeGroup
    ? Array.from(groups.values(), ({ row, categories }) => {
        // A wall face and a slab footprint are different areas: never summed.
        if (categories.size > 1)
          for (const k of sums) if (k.startsWith("Área")) row[k] = null;
        return row;
      })
    : view;
  const cols = activeGroup
    ? [activeGroup, countKey, ...sums]
    : visible.filter((k) => keys.includes(k));
  const pages = Math.max(1, Math.ceil(output.length / 25)),
    index = Math.min(page, pages - 1);
  function download() {
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      return (
        '"' +
        (/^[\s]*[=+@\-]/.test(s) && typeof v !== "number" ? "'" : "") +
        s.replaceAll('"', '""') +
        '"'
      );
    };
    const csv = [cols, ...output.map((r) => cols.map((k) => r[k]))]
      .map((row) => row.map(cell).join(";"))
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "Tabla procesada.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (!rows.length) return <Empty title="Sin registros para mostrar" />;
  return (
    <div className="gridview">
      <div className="tools">
        <label className="search">
          <Search size={15} />
          <input
            placeholder="Buscar en la tabla"
            aria-label="Buscar en la tabla"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <select
          aria-label="Buscar por campo"
          value={field}
          onChange={(e) => setField(e.target.value)}
        >
          <option value="">Todos los campos</option>
          {keys.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <button title="Configurar vista" onClick={() => setSettings(!settings)}>
          <Columns3 size={16} />
        </button>
        <button title="Exportar vista CSV" onClick={download}>
          <Download size={16} />
        </button>
      </div>
      {settings && (
        <div className="settings">
          {!!groupable.length && (
            <label>
              Agrupar por
              <select value={activeGroup} onChange={(e) => setGroup(e.target.value)}>
                <option value="">Sin agrupar · ver cada fila</option>
                {groupable.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <small>
                Junta las filas con el mismo valor, las cuenta y suma sus
                cantidades.
              </small>
            </label>
          )}
          <div className="settings-head">
            <strong>Columnas que se muestran</strong>
            {selection && (
              <button onClick={() => setVisible(null)}>Mostrar todas</button>
            )}
          </div>
          <small>
            Pulsa una columna para ocultarla o volver a mostrarla. El número es
            su posición en la tabla.
          </small>
          <div className="chips">
            {keys.map((k) => (
              <button
                key={k}
                aria-pressed={visible.includes(k)}
                onClick={() =>
                  setVisible(
                    visible.includes(k)
                      ? visible.filter((v) => v !== k)
                      : [...visible, k],
                  )
                }
              >
                {visible.includes(k) ? visible.indexOf(k) + 1 + ". " : ""}
                {k}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              {cols.map((k) => (
                <th key={k}>
                  {activeGroup ? (
                    k
                  ) : (
                    <button
                      onClick={() => {
                        setSort(k);
                        setAsc(k !== sort || !asc);
                      }}
                    >
                      {k}
                      <ArrowDownUp size={11} />
                    </button>
                  )}
                </th>
              ))}
              {!activeGroup && rowAction && <th scope="col">Acción</th>}
            </tr>
          </thead>
          <tbody>
            {output.slice(index * 25, index * 25 + 25).map((r, i) => (
              <tr key={i}>
                {cols.map((k) => (
                  <td key={k}>
                    {typeof r[k] === "number"
                      ? fmt(r[k] as number)
                      : (r[k] ?? "—")}
                  </td>
                ))}
                {!activeGroup && rowAction && <td>{rowAction(r)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <small>{fmt(output.length)} registros</small>
        <button
          disabled={!index}
          aria-label="Anterior"
          onClick={() => setPage(index - 1)}
        >
          <ChevronLeft size={14} />
        </button>
        <small>
          {index + 1} / {pages}
        </small>
        <button
          disabled={index + 1 >= pages}
          aria-label="Siguiente"
          onClick={() => setPage(index + 1)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
