import { useEffect, useRef } from "react";
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  BufferGeometry,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  RingGeometry,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
} from "three";
import { AXES_X, AXES_Z, build, height, TIMING, type Piece } from "./structure";

export type SceneStatus = "idle" | "pending" | "success";

const BLUE = new Color("#3b82f6");
const BLUE_LIT = new Color("#bfdbfe");
const EDGE = new Color("#7fb2f0");
const AMBER = new Color("#f5a524");
const CONCRETE = new Color("#aeb8c4");
const EXTEND = 2.2;
const ease = (p: number) => 1 - Math.pow(1 - p, 3);
const clamp = (v: number) => Math.min(1, Math.max(0, v));

function label(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#93c5fd";
  ctx.font = "600 38px Inter Variable, Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 34);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Isometric WebGL scene: setting-out axes, then footings, columns, beams
 * and slabs, then a slow camera sway. Loaded on demand by SceneSlot. */
export default function LoginScene({
  status,
  onReady,
  onFail,
  onStage,
}: {
  status: SceneStatus;
  onReady: () => void;
  onFail: () => void;
  onStage: (label: string) => void;
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
    scene.add(new HemisphereLight(0xdbeafe, 0x0b1220, 1.25));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(9, 16, 5);
    scene.add(sun);
    const grid = new GridHelper(34, 34, 0x1c3557, 0x132640);
    grid.position.y = -0.02;
    scene.add(grid);
    keep(grid.geometry);
    keep(grid.material as Material);

    const { pieces, stages, end, xs, zs } = build();

    // Setting-out axes: dashed blue lines drawn from one end, with bubbles.
    const axisMaterial = keep(
      new LineDashedMaterial({
        color: BLUE.clone(),
        dashSize: 1.1,
        gapSize: 0.28,
        transparent: true,
        opacity: 0.9,
      }),
    );
    const bubbleMaterial = keep(
      new MeshBasicMaterial({
        color: BLUE.clone(),
        transparent: true,
        opacity: 0,
      }),
    );
    const ring = keep(new RingGeometry(0.5, 0.64, 40));
    const axes: { group: Group; bubble: Group; delay: number }[] = [];
    const axis = (from: Vector3, to: Vector3, text: string, delay: number) => {
      const length = from.distanceTo(to);
      const geometry = keep(
        new BufferGeometry().setAttribute(
          "position",
          new Float32BufferAttribute([0, 0, 0, length, 0, 0], 3),
        ),
      );
      const line = new Line(geometry, axisMaterial);
      line.computeLineDistances();
      const group = new Group();
      group.position.copy(from);
      group.rotation.y = -Math.atan2(to.z - from.z, to.x - from.x);
      group.add(line);
      const bubble = new Group();
      const circle = new Mesh(ring, bubbleMaterial);
      circle.rotation.x = -Math.PI / 2;
      const texture = keep(label(text));
      const sprite = new Sprite(
        keep(
          new SpriteMaterial({ map: texture, transparent: true, opacity: 0 }),
        ),
      );
      sprite.scale.set(0.9, 0.9, 1);
      sprite.position.y = 0.05;
      bubble.add(circle, sprite);
      // Bubble at the end facing the viewer, so the building never hides it.
      bubble.position
        .copy(to)
        .add(new Vector3().subVectors(to, from).setLength(0.66));
      scene.add(group, bubble);
      axes.push({ group, bubble, delay });
    };
    const last = (list: number[]) => list[list.length - 1];
    zs.forEach((z, i) =>
      axis(
        new Vector3(xs[0] - EXTEND, 0.01, z),
        new Vector3(last(xs) + EXTEND, 0.01, z),
        AXES_Z[i],
        i * 0.12,
      ),
    );
    xs.forEach((x, i) =>
      axis(
        new Vector3(x, 0.01, zs[0] - EXTEND),
        new Vector3(x, 0.01, last(zs) + EXTEND),
        AXES_X[i],
        0.3 + i * 0.12,
      ),
    );

    // Vertical structural axes, lit while the sign-in is being processed.
    const vertical = keep(
      new LineBasicMaterial({
        color: BLUE_LIT.clone(),
        transparent: true,
        opacity: 0,
        // Seen through the concrete, like an x-ray view of the model.
        depthTest: false,
      }),
    );
    const columnAxes = keep(
      new BufferGeometry().setAttribute(
        "position",
        new Float32BufferAttribute(
          xs.flatMap((x) => zs.flatMap((z) => [x, 0, z, x, height + 0.8, z])),
          3,
        ),
      ),
    );
    const columnLines = new LineSegments(columnAxes, vertical);
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
          emissive: AMBER.clone(),
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

    // Isometric orthographic camera that fits the whole site.
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const target = new Vector3(0, height * 0.42, 0);
    const radius = 40;
    const place = (yaw: number) => {
      const angle = Math.PI / 4 + yaw;
      camera.position.set(
        target.x + Math.cos(angle) * radius * 0.8165,
        target.y + radius * 0.5774,
        target.z + Math.sin(angle) * radius * 0.8165,
      );
      camera.lookAt(target);
    };
    const corners: Vector3[] = [];
    for (const x of [xs[0] - EXTEND - 1, last(xs) + EXTEND + 1])
      for (const z of [zs[0] - EXTEND - 1, last(zs) + EXTEND + 1])
        for (const y of [0, height + 0.8]) corners.push(new Vector3(x, y, z));
    const fit = () => {
      const w = root.clientWidth || 1,
        h = root.clientHeight || 1;
      renderer.setSize(w, h, false);
      place(0);
      camera.updateMatrixWorld();
      let half = 0;
      let halfY = 0;
      for (const c of corners) {
        const v = c.clone().applyMatrix4(camera.matrixWorldInverse);
        half = Math.max(half, Math.abs(v.x));
        halfY = Math.max(halfY, Math.abs(v.y));
      }
      const aspect = w / h;
      const size = Math.max(halfY, half / aspect) * 1.08;
      camera.left = -size * aspect;
      camera.right = size * aspect;
      camera.top = size;
      camera.bottom = -size;
      camera.updateProjectionMatrix();
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(root);

    let elapsed = 0,
      previous = performance.now(),
      frame = 0,
      visible = true,
      stage = "",
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

      // Axes draw in; while signing in they brighten and pulse.
      for (const a of axes) {
        const p = ease(clamp((t - a.delay) / (TIMING.axes - 0.45)));
        a.group.scale.x = Math.max(p, 0.0001);
        const bubble = clamp((t - a.delay - TIMING.axes + 0.6) / 0.4);
        a.bubble.children.forEach((child) => {
          const material = (child as Mesh | Sprite).material as Material & {
            opacity: number;
          };
          material.opacity = bubble;
        });
      }
      const glow = pending ? 0.55 + 0.45 * pulse : 0;
      axisMaterial.color.copy(BLUE).lerp(BLUE_LIT, glow);
      bubbleMaterial.color.copy(axisMaterial.color);
      vertical.opacity = pending
        ? 0.25 + 0.55 * pulse
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
        // Amber accent as the piece lands, fading back to the drawing blue.
        const settle =
          p < 1 ? e : Math.max(0, 1 - (t - piece.at - TIMING.piece) / 0.7);
        material.transparent = material.opacity < 1;
        material.emissiveIntensity =
          settle * (piece.kind === "slab" ? 0.12 : 0.35);
        outline.color.copy(EDGE).lerp(AMBER, settle);
        outline.opacity = 0.35 + 0.55 * settle;
      }

      // Finished: a slow, eased sway; on success a short push-in.
      const sway = clamp((t - end) / 2.5);
      place(Math.sin(Math.max(0, t - end) * 0.22) * 0.16 * ease(sway));
      camera.zoom =
        status === "success" ? 1 + 0.35 * ease(clamp(since / 0.6)) : 1;
      camera.updateProjectionMatrix();

      const current = [...stages].reverse().find((s) => t >= s.at);
      if (current && current.label !== stage) {
        stage = current.label;
        onStage(stage);
      }
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
