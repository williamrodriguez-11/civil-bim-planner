import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, Layers3 } from "lucide-react";
import { api, cleanError } from "./model";
import { prefersReducedMotion, SceneSlot } from "./SceneSlot";

type User = { username: string };

export function Account({
  children,
}: {
  children: (username: string, logout: () => Promise<void>) => ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const passwordField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const expired = () => {
      setUser(null);
      setPassword("");
      setVisible(false);
    };
    const changed = (e: StorageEvent) => {
      if (e.key === "civil-session-change") window.location.reload();
    };
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("civil-session-expired", expired);
    window.addEventListener("storage", changed);
    window.addEventListener("pageshow", restored);
    const result = new URLSearchParams(location.search).get("acceso");
    if (result === "error")
      setError("No se completó el acceso. Puedes volver a intentarlo.");
    if (result === "ok")
      localStorage.setItem("civil-session-change", crypto.randomUUID());
    if (result) history.replaceState(null, "", location.pathname);
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (r) => {
        if (r.ok) setUser(await r.json());
        else if (r.status !== 401)
          throw Error("No se pudo comprobar la sesión.");
      })
      .catch((e) => setError(cleanError(e)))
      .finally(() => setLoading(false));
    return () => {
      window.removeEventListener("civil-session-expired", expired);
      window.removeEventListener("storage", changed);
      window.removeEventListener("pageshow", restored);
    };
  }, []);

  function sessionChanged() {
    localStorage.setItem("civil-session-change", crypto.randomUUID());
    setPassword("");
    setVisible(false);
    setError("");
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    sessionChanged();
    setRegister(false);
    setLeaving(false);
    setUser(null);
  }

  // The form is usable at once: the session check runs in the background
  // (a sleeping server can take a while) and opens the panel if it succeeds.
  if (user) return children(user.username, logout);
  return (
    <div className={"login" + (leaving ? " is-leaving" : "")}>
      <SceneSlot status={leaving ? "success" : busy ? "pending" : "idle"} />
      <main className="login-side">
        <section className="account-panel">
          <div className="login-brand">
            <span className="brandmark">
              <Layers3 />
            </span>
            <div>
              <b>CIVIL BIM</b>
              <span>PLANNER</span>
            </div>
          </div>
          <h1>{register ? "Crea tu cuenta" : "Inicia sesión"}</h1>
          <p>Accede a tus proyectos de obra desde cualquier equipo.</p>
          <form
            aria-busy={busy}
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                const result = await api<User>(
                  register ? "/auth/register" : "/auth/login",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username, password }),
                  },
                );
                // A brief hand-off to the panel, skipped with reduced motion.
                setLeaving(true);
                if (!prefersReducedMotion())
                  await new Promise((done) => setTimeout(done, 650));
                sessionChanged();
                setUser(result);
              } catch (e) {
                // Keep the username; select the password to type it again.
                setError(cleanError(e));
                passwordField.current?.focus();
                passwordField.current?.select();
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Nombre de usuario o correo electrónico
              <input
                required
                autoComplete="username"
                autoCapitalize="none"
                maxLength={254}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <div className="password-group">
              <label htmlFor="civil-password">Contraseña</label>
              <div className="password-input">
                <input
                  ref={passwordField}
                  id="civil-password"
                  required
                  type={visible ? "text" : "password"}
                  autoComplete={register ? "new-password" : "current-password"}
                  minLength={register ? 12 : undefined}
                  maxLength={256}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={
                    visible ? "Ocultar contraseña" : "Mostrar contraseña"
                  }
                  aria-pressed={visible}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            {register && (
              <small>Elige una contraseña de al menos 12 caracteres.</small>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary login-submit" disabled={busy || leaving}>
              {register ? "Crear cuenta" : "Iniciar sesión"}
            </button>
            <p className="login-status" role="status">
              {leaving
                ? "Acceso correcto. Abriendo tu panel…"
                : busy
                  ? "Comprobando tus datos…"
                  : loading
                    ? "Comprobando si ya tienes una sesión abierta…"
                    : ""}
            </p>
          </form>
          <button
            disabled={busy}
            onClick={() => {
              setRegister(!register);
              setPassword("");
              setVisible(false);
              setError("");
            }}
          >
            {register ? "Ya tengo una cuenta" : "Crear una cuenta"}
          </button>
        </section>
      </main>
    </div>
  );
}
