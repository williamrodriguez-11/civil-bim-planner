import { useEffect, useRef } from "react";
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Material,
} from "three";
import { build, height, TIMING, type Piece } from "./structure";

export type SceneStatus = "idle" | "pending" | "success";

// The app's palette: deep green surfaces, pale concrete, lime accent.
const CONCRETE = new Color("#c9d3cc");
const EDGE = new Color("#8fb5a2");
const ACCENT = new Color("#cfeb9e");
const ACCENT_LIT = new Color("#e6f7c4");
const ELEVATION = Math.asin(1 / Math.sqrt(3)); // true isometric
// Push-in on a successful sign-in; the framing leaves room for it.
const SUCCESS_ZOOM = 1.1;
const ease = (p: number) => 1 - Math.pow(1 - p, 3);
const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Isometric WebGL scene: footings, columns, beams and slabs rise in order;
 * the finished frame sways gently and follows the pointer. Loaded on demand
 * by SceneSlot. */
export default function LoginScene({
  status,
  onReady,
  onFail,
}: {
  status: SceneStatus;
  onReady: () => void;
  onFail: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ status, changed: 0 });
  useEffect(() => {
    live.current = { status, changed: performance.now() };
  }, [status]);

  useEffect(() => {
    const root = host.current!;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
    } catch {
      onFail();
      return;
    }
    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(item: T) => {
      disposables.push(item);
      return item;
    };
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute("aria-hidden", "true");
    root.appendChild(renderer.domElement);
    const lost = (e: Event) => {
      e.preventDefault();
      onFail();
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);

    const scene = new Scene();
    scene.add(new HemisphereLight(0xeef7ee, 0x0d1f19, 1.3));
    const sun = new DirectionalLight(0xffffff, 1.5);
    sun.position.set(9, 16, 5);
    scene.add(sun);
    const grid = new GridHelper(34, 34, 0x2f5a4b, 0x1f3e34);
    grid.position.y = -0.02;
    scene.add(grid);
    keep(grid.geometry);
    keep(grid.material as Material);

    const { pieces, end, xs, zs } = build();

    // Vertical structural axes, lit while the sign-in is being processed.
    const vertical = keep(
      new LineBasicMaterial({
        color: ACCENT_LIT.clone(),
        transparent: true,
        opacity: 0,
        // Seen through the concrete, like an x-ray view of the model.
        depthTest: false,
      }),
    );
    const columnLines = new LineSegments(
      keep(
        new BufferGeometry().setAttribute(
          "position",
          new Float32BufferAttribute(
            xs.flatMap((x) => zs.flatMap((z) => [x, 0, z, x, height + 0.8, z])),
            3,
          ),
        ),
      ),
      vertical,
    );
    columnLines.visible = false;
    columnLines.renderOrder = 10;
    scene.add(columnLines);

    // Concrete pieces with their own materials, so each can fade and glow.
    const shapes = new Map<
      string,
      { box: BoxGeometry; edges: EdgesGeometry }
    >();
    const parts = pieces.map((piece: Piece) => {
      const key = `${piece.w}x${piece.h}x${piece.d}`;
      if (!shapes.has(key)) {
        const box = keep(new BoxGeometry(piece.w, piece.h, piece.d));
        box.translate(0, piece.h / 2, 0);
        shapes.set(key, { box, edges: keep(new EdgesGeometry(box)) });
      }
      const shape = shapes.get(key)!;
      const material = keep(
        new MeshStandardMaterial({
          color: CONCRETE,
          roughness: 0.88,
          metalness: 0,
          transparent: true,
          opacity: 0,
          emissive: ACCENT.clone(),
          emissiveIntensity: 0,
        }),
      );
      const outline = keep(
        new LineBasicMaterial({
          color: EDGE.clone(),
          transparent: true,
          opacity: 0,
        }),
      );
      const mesh = new Mesh(shape.box, material);
      mesh.add(new LineSegments(shape.edges, outline));
      mesh.position.set(piece.x, piece.y, piece.z);
      mesh.visible = false;
      scene.add(mesh);
      return { piece, mesh, material, outline };
    });

    // Isometric orthographic camera that fits the building.
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const target = new Vector3(0, height * 0.42, 0);
    const radius = 40;
    const place = (yaw: number, pitch: number) => {
      const angle = Math.PI / 4 + yaw;
      const up = ELEVATION + pitch;
      camera.position.set(
        target.x + Math.cos(angle) * Math.cos(up) * radius,
        target.y + Math.sin(up) * radius,
        target.z + Math.sin(angle) * Math.cos(up) * radius,
      );
      camera.lookAt(target);
    };
    const last = (list: number[]) => list[list.length - 1];
    const corners: Vector3[] = [];
    for (const x of [xs[0] - 1.6, last(xs) + 1.6])
      for (const z of [zs[0] - 1.6, last(zs) + 1.6])
        for (const y of [0, height + 0.8]) corners.push(new Vector3(x, y, z));
    const fit = () => {
      const w = root.clientWidth || 1,
        h = root.clientHeight || 1;
      renderer.setSize(w, h, false);
      // Fit the widest view the pointer can reach, so nothing is cut off.
      let half = 0;
      let halfY = 0;
      for (const yaw of [-0.4, 0, 0.4])
        for (const pitch of [-0.12, 0.12]) {
          place(yaw, pitch);
          camera.updateMatrixWorld();
          for (const c of corners) {
            const v = c.clone().applyMatrix4(camera.matrixWorldInverse);
            half = Math.max(half, Math.abs(v.x));
            halfY = Math.max(halfY, Math.abs(v.y));
          }
        }
      const aspect = w / h;
      const size = Math.max(halfY, half / aspect) * (1.04 * SUCCESS_ZOOM);
      camera.left = -size * aspect;
      camera.right = size * aspect;
      camera.top = size;
      camera.bottom = -size;
      camera.updateProjectionMatrix();
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(root);

    // The structure turns toward the pointer while it is over the scene.
    const aim = { yaw: 0, pitch: 0, active: false };
    const view = { yaw: 0, pitch: 0 };
    const move = (e: PointerEvent) => {
      const box = root.getBoundingClientRect();
      const nx = (e.clientX - box.left) / box.width - 0.5;
      const ny = (e.clientY - box.top) / box.height - 0.5;
      aim.yaw = Math.max(-0.4, Math.min(0.4, nx * 0.8));
      aim.pitch = Math.max(-0.12, Math.min(0.12, -ny * 0.24));
      aim.active = true;
    };
    const leave = () => {
      aim.active = false;
    };
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerleave", leave);
    root.addEventListener("pointercancel", leave);

    let elapsed = 0,
      previous = performance.now(),
      frame = 0,
      visible = true,
      ready = false;
    const onScreen = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !frame) loop();
    });
    onScreen.observe(root);
    const onHidden = () => {
      if (!document.hidden && !frame) loop();
    };
    document.addEventListener("visibilitychange", onHidden);

    function draw(now: number) {
      const t = elapsed;
      const { status, changed } = live.current;
      const since = (now - changed) / 1000;
      const pending = status === "pending";
      const pulse = 0.5 + 0.5 * Math.sin(now / 160);

      vertical.opacity = pending
        ? 0.3 + 0.6 * pulse
        : Math.max(0, vertical.opacity - 0.05);
      columnLines.visible = vertical.opacity > 0;

      for (const { piece, mesh, material, outline } of parts) {
        const p = clamp((t - piece.at) / TIMING.piece);
        mesh.visible = p > 0;
        if (!mesh.visible) continue;
        const e = ease(p);
        if (piece.kind === "footing" || piece.kind === "column") {
          mesh.scale.y = Math.max(e, 0.001);
          mesh.position.y = piece.y;
          material.opacity = 1;
        } else {
          const drop = piece.kind === "slab" ? 2.6 : 1.8;
          mesh.position.y = piece.y + (1 - e) * drop;
          material.opacity = e;
        }
        material.transparent = material.opacity < 1;
        // Lime accent as the piece lands, fading back to concrete; while
        // signing in, every outline glows softly with the axes.
        const settle =
          p < 1 ? e : Math.max(0, 1 - (t - piece.at - TIMING.piece) / 0.7);
        const glow = Math.max(settle, pending ? 0.35 * pulse : 0);
        material.emissiveIntensity =
          settle * (piece.kind === "slab" ? 0.12 : 0.3);
        outline.color.copy(EDGE).lerp(ACCENT, glow);
        outline.opacity = 0.4 + 0.5 * glow;
      }

      // Follow the pointer; otherwise sway slowly once the frame is complete.
      const sway =
        Math.sin(Math.max(0, t - end) * 0.22) *
        0.16 *
        ease(clamp((t - end) / 2.5));
      view.yaw += ((aim.active ? aim.yaw : sway) - view.yaw) * 0.08;
      view.pitch += ((aim.active ? aim.pitch : 0) - view.pitch) * 0.08;
      place(view.yaw, view.pitch);
      camera.zoom =
        status === "success"
          ? 1 + (SUCCESS_ZOOM - 1) * ease(clamp(since / 0.6))
          : 1;
      camera.updateProjectionMatrix();

      renderer.render(scene, camera);
      if (!ready) {
        ready = true;
        onReady();
      }
    }

    function loop() {
      frame = 0;
      if (!visible || document.hidden) return;
      frame = requestAnimationFrame((now) => {
        elapsed += Math.min((now - previous) / 1000, 0.1);
        previous = now;
        draw(now);
        loop();
      });
    }
    previous = performance.now();
    loop();

    return () => {
      cancelAnimationFrame(frame);
      frame = -1;
      visible = false;
      resize.disconnect();
      onScreen.disconnect();
      document.removeEventListener("visibilitychange", onHidden);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", leave);
      root.removeEventListener("pointercancel", leave);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      disposables.forEach((item) => item.dispose());
      renderer.dispose();
      // Give the context back now instead of waiting for the browser.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
    // The scene is built once; status reaches it through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="login-scene-canvas" ref={host} />;
}
