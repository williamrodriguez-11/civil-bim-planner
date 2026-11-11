import { useEffect, useState, type ReactNode } from "react";
import { Layers3 } from "lucide-react";
import { api, cleanError } from "./model";

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

  useEffect(() => {
    const expired = () => {
      setUser(null);
      setPassword("");
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
    setError("");
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    sessionChanged();
    setRegister(false);
    setUser(null);
  }

  if (loading)
    return (
      <div className="account-screen" role="status">
        Abriendo tu espacio…
      </div>
    );
  if (user) return children(user.username, logout);
  return (
    <div className="account-screen">
      <section className="panel account-panel">
        <div className="section-title">
          <Layers3 />
          <b>CIVIL BIM Planner</b>
        </div>
        <h1>{register ? "Crea tu cuenta" : "Inicia sesión"}</h1>
        <p>Accede a tus proyectos de obra desde cualquier equipo.</p>
        <form
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
              sessionChanged();
              setUser(result);
            } catch (e) {
              setError(cleanError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Nombre de usuario
            <input
              required
              autoComplete="username"
              autoCapitalize="none"
              maxLength={64}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            Contraseña
            <input
              required
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              minLength={register ? 12 : undefined}
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {register && (
            <small>Elige una contraseña de al menos 12 caracteres.</small>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {register ? "Crear cuenta" : "Entrar"}
          </button>
        </form>
        <button
          disabled={busy}
          onClick={() => {
            setRegister(!register);
            setPassword("");
            setError("");
          }}
        >
          {register ? "Ya tengo una cuenta" : "Crear una cuenta"}
        </button>
      </section>
    </div>
  );
}
