import { build, type Piece } from "./structure";

/** Isometric still of the login building, drawn as SVG. Shown when WebGL is
 * missing, motion is reduced, the animation is paused or fails to load. */
const COS = Math.cos(Math.PI / 6);
const project = (x: number, y: number, z: number): [number, number] => [
  (x - z) * COS,
  (x + z) * 0.5 - y,
];
const ORDER = { footing: 0, column: 1, beam: 1, slab: 2 } as const;
const { pieces } = build();

function faces(p: Piece) {
  const x0 = p.x - p.w / 2,
    x1 = p.x + p.w / 2;
  const z0 = p.z - p.d / 2,
    z1 = p.z + p.d / 2;
  const y0 = p.y,
    y1 = p.y + p.h;
  const poly = (pts: [number, number, number][]) =>
    pts
      .map((q) =>
        project(...q)
          .map((v) => v.toFixed(2))
          .join(","),
      )
      .join(" ");
  return {
    top: poly([
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x0, y1, z1],
    ]),
    east: poly([
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x1, y0, z1],
    ]),
    south: poly([
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ]),
  };
}

// Painter's order: by floor, then layer, then far (small x + z) to near.
const sorted = [...pieces].sort(
  (a, b) =>
    a.floor - b.floor ||
    ORDER[a.kind] - ORDER[b.kind] ||
    a.x + a.z - (b.x + b.z) ||
    (a.kind === "beam" ? 1 : 0) - (b.kind === "beam" ? 1 : 0),
);
const all = [
  ...pieces.flatMap((p) => [
    project(p.x - p.w / 2, p.y + p.h, p.z - p.d / 2),
    project(p.x + p.w / 2, p.y, p.z + p.d / 2),
    project(p.x + p.w / 2, p.y, p.z - p.d / 2),
    project(p.x - p.w / 2, p.y, p.z + p.d / 2),
  ]),
];
const pad = 1.4;
const minX = Math.min(...all.map((p) => p[0])) - pad;
const minY = Math.min(...all.map((p) => p[1])) - pad;
const maxX = Math.max(...all.map((p) => p[0])) + pad;
const maxY = Math.max(...all.map((p) => p[1])) + pad;

export function StructureStill() {
  return (
    <svg
      className="structure-still"
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {sorted.map((p, i) => {
        const f = faces(p);
        return (
          <g key={i} className={"still-" + p.kind}>
            <polygon className="face-top" points={f.top} />
            <polygon className="face-east" points={f.east} />
            <polygon className="face-south" points={f.south} />
          </g>
        );
      })}
    </svg>
  );
}
