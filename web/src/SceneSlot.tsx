import { lazy, Suspense, useEffect, useState } from "react";
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
  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const decide = () =>
      setMode(motion?.matches || !webglAvailable() ? "still" : "scene");
    // Let the form paint first, then decide and start loading the scene.
    const id = window.setTimeout(decide, 0);
    motion?.addEventListener("change", decide);
    return () => {
      window.clearTimeout(id);
      motion?.removeEventListener("change", decide);
    };
  }, []);
  const still = mode === "still";
  return (
    <div
      className={
        "login-scene" +
        (ready ? " is-ready" : "") +
        (still ? " is-still" : "") +
        (status === "pending" ? " is-pending" : "")
      }
      role="img"
      aria-label="Ilustración de un edificio de concreto en construcción sobre sus ejes de replanteo"
    >
      <div className="login-scene-poster">
        <StructureStill axesOnly={!still} />
      </div>
      {mode === "scene" && (
        <Suspense fallback={null}>
          <LoginScene
            status={status}
            onReady={() => setReady(true)}
            onFail={() => setMode("still")}
            onStage={setStage}
          />
        </Suspense>
      )}
      <div className="login-scene-caption" aria-hidden="true">
        <span>Modelo estructural</span>
        <b>{still ? "Estructura completa" : stage || "Ejes de replanteo"}</b>
      </div>
    </div>
  );
}
