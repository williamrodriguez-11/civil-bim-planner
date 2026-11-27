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

// Three.js needs WebGL 2. Probed once, and the probe context is released.
let webgl2: boolean | null = null;
function webglAvailable() {
  if (webgl2 === null) {
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      webgl2 = !!gl;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
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
        <div className="login-scene-poster">{still && <StructureStill />}</div>
        {mode === "scene" && (
          <SceneBoundary onError={fail}>
            <Suspense fallback={null}>
              <LoginScene
                status={status}
                onReady={() => setReady(true)}
                onFail={fail}
              />
            </Suspense>
          </SceneBoundary>
        )}
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
