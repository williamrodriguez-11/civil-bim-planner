import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, KeyRound, UserRound, X } from "lucide-react";
import { api, cleanError } from "./model";

type Me = { username: string; has_password: boolean; providers: string[] };

/** The same rules the server applies to a new password. */
export function passwordRules(password: string, username: string) {
  const name = username.split("@")[0].toLowerCase();
  return [
    { label: "Al menos 12 caracteres", ok: [...password].length >= 12 },
    { label: "Una letra mayúscula (A-Z)", ok: /[A-ZÁÉÍÓÚÑÜ]/.test(password) },
    { label: "Una letra minúscula (a-z)", ok: /[a-záéíóúñü]/.test(password) },
    { label: "Un número (0-9)", ok: /\p{Nd}/u.test(password) },
    {
      label: "Un símbolo, por ejemplo ! # $ % & *",
      ok: /[\p{P}\p{S}]/u.test(password),
    },
    {
      label: "Que no incluya tu nombre de usuario",
      ok:
        !!password &&
        !(name.length >= 3 && password.toLowerCase().includes(name)) &&
        !(
          !!username && password.toLowerCase().includes(username.toLowerCase())
        ),
    },
  ];
}

function strength(password: string, met: number, total: number) {
  if (!password) return null;
  const score =
    met === total
      ? [...password].length >= 16
        ? 3
        : 2
      : met >= total - 2
        ? 1
        : 0;
  return [
    { label: "Muy débil", level: "weak" },
    { label: "Débil", level: "weak" },
    { label: "Buena", level: "fair" },
    { label: "Fuerte", level: "strong" },
  ][score];
}

function Secret({
  id,
  label,
  value,
  onChange,
  autoComplete,
  describedBy,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-group">
      <label htmlFor={id}>
        {label}{" "}
        <span className="required" aria-hidden="true">
          *
        </span>
      </label>
      <div className="password-input">
        <input
          id={id}
          required
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          aria-label={
            visible
              ? `Ocultar ${label.toLowerCase()}`
              : `Mostrar ${label.toLowerCase()}`
          }
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
    </div>
  );
}

export function Settings() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    api<Me>("/auth/me")
      .then(setMe)
      .catch((e) => setLoadError(cleanError(e)));
  }, []);

  const rules = passwordRules(next, me?.username ?? "");
  const met = rules.filter((r) => r.ok).length;
  const meter = strength(next, met, rules.length);
  const matches = !!repeat && repeat === next;
  const same = !!next && next === current;
  const ready = !!current && met === rules.length && matches && !same && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      await api("/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: current,
          new_password: next,
        }),
      });
      setCurrent("");
      setNext("");
      setRepeat("");
      setDone(
        "Contraseña actualizada. Las sesiones abiertas en otros equipos se cerraron.",
      );
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError)
    return (
      <p className="error" role="alert">
        {loadError}
      </p>
    );
  if (!me)
    return (
      <section className="panel" role="status">
        Cargando tu cuenta…
      </section>
    );

  return (
    <div className="settings">
      <nav className="settings-tabs" aria-label="Secciones de configuración">
        <span className="selected" aria-current="page">
          <UserRound size={16} /> Mi cuenta
        </span>
      </nav>
      <div className="settings-grid">
        <section className="panel" aria-labelledby="settings-account">
          <h2 id="settings-account">Tu cuenta</h2>
          <dl className="settings-facts">
            <dt>Usuario</dt>
            <dd>{me.username}</dd>
            <dt>Forma de entrar</dt>
            <dd>
              {[
                ...(me.has_password ? ["Usuario y contraseña"] : []),
                ...me.providers,
              ].join(", ") || "—"}
            </dd>
          </dl>
        </section>

        <section className="panel" aria-labelledby="settings-password">
          <h2 id="settings-password">
            <KeyRound size={18} /> Cambiar contraseña
          </h2>
          {!me.has_password ? (
            <p className="muted">
              Entras con {me.providers.join(" o ") || "un proveedor externo"},
              así que tu cuenta no usa contraseña. Para cambiar el acceso, hazlo
              en esa cuenta.
            </p>
          ) : (
            <form className="settings-form" onSubmit={submit}>
              <input
                type="text"
                autoComplete="username"
                value={me.username}
                readOnly
                hidden
              />
              <Secret
                id="current-password"
                label="Contraseña actual"
                value={current}
                onChange={setCurrent}
                autoComplete="current-password"
              />
              <Secret
                id="new-password"
                label="Nueva contraseña"
                value={next}
                onChange={(v) => {
                  setNext(v);
                  setDone("");
                }}
                autoComplete="new-password"
                describedBy="password-rules"
              />
              {meter && (
                <div className={"strength " + meter.level}>
                  <div className="strength-bar">
                    <i style={{ width: `${(met / rules.length) * 100}%` }} />
                  </div>
                  <span>
                    Seguridad: <b>{meter.label}</b>
                  </span>
                </div>
              )}
              <ul
                id="password-rules"
                className="password-rules"
                aria-label="La nueva contraseña debe tener"
              >
                {rules.map((r) => (
                  <li key={r.label} className={r.ok ? "ok" : ""}>
                    {r.ok ? <Check size={14} /> : <X size={14} />}
                    <span>{r.label}</span>
                    <span className="sr-only">
                      {r.ok ? " (cumple)" : " (falta)"}
                    </span>
                  </li>
                ))}
                {same && (
                  <li>
                    <X size={14} />
                    <span>Debe ser distinta de la actual</span>
                  </li>
                )}
              </ul>
              <Secret
                id="repeat-password"
                label="Repite la nueva contraseña"
                value={repeat}
                onChange={setRepeat}
                autoComplete="new-password"
                describedBy="repeat-state"
                invalid={!!repeat && !matches}
              />
              {repeat && (
                <small
                  id="repeat-state"
                  className={matches ? "match ok" : "match"}
                >
                  {matches
                    ? "Las contraseñas coinciden."
                    : "Las contraseñas no coinciden."}
                </small>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              {done && (
                <p className="notice" role="status">
                  {done}
                </p>
              )}
              <div>
                <button className="primary" disabled={!ready}>
                  {busy ? "Guardando…" : "Guardar contraseña"}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
