import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Pause, Play } from "lucide-react";
import { StructureStill } from "./StructureStill";
import type { SceneStatus } from "./LoginScene";

// Three.js lives in its own chunk, fetched only after the form is on screen.
const LoginScene = lazy(() => import("./LoginScene"));

function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** A failed download of the scene (e.g. after a deploy) shows the still
 * image instead of taking the sign-in page down. */
class SceneBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const PAUSE_KEY = "civil-login-animation";
function pausedBefore() {
  try {
    return localStorage.getItem(PAUSE_KEY) === "paused";
  } catch {
    return false;
  }
}

export function prefersReducedMotion() {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

/** The login illustration. Decides between the animated scene and the still
 * image, and never delays the form: the form renders independently. */
export function SceneSlot({ status }: { status: SceneStatus }) {
  const [mode, setMode] = useState<"wait" | "scene" | "still">("wait");
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState("");
  const [paused, setPaused] = useState(pausedBefore);
  const [failed, setFailed] = useState(false);
  // Whether this browser can animate at all (WebGL and no reduced motion).
  const [animatable, setAnimatable] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const decide = () => {
      const can = !motion?.matches && webglAvailable();
      setAnimatable(can);
      setMode(can && !paused && !failed ? "scene" : "still");
    };
    // Let the form paint first, then decide and start loading the scene.
    const id = window.setTimeout(decide, 0);
    motion?.addEventListener("change", decide);
    return () => {
      window.clearTimeout(id);
      motion?.removeEventListener("change", decide);
    };
  }, [paused, failed]);
  const still = mode === "still";
  const fail = () => {
    setFailed(true);
    setMode("still");
  };
  function togglePause() {
    const next = !paused;
    setPaused(next);
    setReady(false);
    try {
      localStorage.setItem(PAUSE_KEY, next ? "paused" : "playing");
    } catch {
      // Remembering the choice is only a convenience.
    }
  }
  return (
    <div
      className={
        "login-scene" +
        (ready ? " is-ready" : "") +
        (still ? " is-still" : "") +
        (status === "pending" ? " is-pending" : "")
      }
    >
      <div
        className="login-scene-art"
        role="img"
        aria-label="Ilustración de un edificio de concreto en construcción sobre sus ejes de replanteo"
      >
        <div className="login-scene-poster">
          <StructureStill axesOnly={!still} />
        </div>
        {mode === "scene" && (
          <SceneBoundary onError={fail}>
            <Suspense fallback={null}>
              <LoginScene
                status={status}
                onReady={() => setReady(true)}
                onFail={fail}
                onStage={setStage}
              />
            </Suspense>
          </SceneBoundary>
        )}
      </div>
      <div className="login-scene-caption" aria-hidden="true">
        <span>Modelo estructural</span>
        <b>{still ? "Estructura completa" : stage || "Ejes de replanteo"}</b>
      </div>
      {/* Decorative motion longer than 5 s must be stoppable (WCAG 2.2.2). */}
      {animatable && !failed && mode !== "wait" && (
        <button
          type="button"
          className="login-scene-toggle"
          aria-pressed={paused}
          onClick={togglePause}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? "Animar" : "Pausar animación"}
        </button>
      )}
    </div>
  );
}
