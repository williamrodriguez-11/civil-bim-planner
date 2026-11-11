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
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
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
export function Grid({ rows, columns }: { rows: Row[]; columns?: string[] }) {
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
  const view = rows.filter((r) =>
    (field ? [field] : keys).some((k) =>
      String(r[k] ?? "")
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    ),
  );
  if (sort)
    view.sort(
      (a, b) =>
        String(a[sort] ?? "").localeCompare(String(b[sort] ?? ""), "es", {
          numeric: true,
        }) * (asc ? 1 : -1),
    );
  const counts = new Map<string, number>();
  if (group)
    for (const r of view) {
      const key = String(r[group] ?? "");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const output: Row[] = group
    ? Array.from(counts, ([value, count]) => ({ Grupo: value, Filas: count }))
    : view;
  const cols = group
    ? ["Grupo", "Filas"]
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
          <label>
            Agrupar por
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">Sin agrupar</option>
              {keys.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <p>Selecciona campos en el orden en que deben aparecer.</p>
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
                  {group ? (
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
