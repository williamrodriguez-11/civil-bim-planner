/** Geometry of the login illustration: an original three-storey concrete
 * frame on a 4 × 3 grid of setting-out axes. Shared by the 3D scene and the
 * still image so both always show the same building. Units are meters. */

export type Kind = "footing" | "column" | "beam" | "slab";
export interface Piece {
  kind: Kind;
  /** Center of the base (x, z) and its height above ground. */
  x: number;
  y: number;
  z: number;
  /** Size along x, y (height) and z. */
  w: number;
  h: number;
  d: number;
  /** Seconds after the start when the piece begins to appear. */
  at: number;
  floor: number;
}

export const SPAN_X = 5;
export const SPAN_Z = 4.5;
export const AXES_X = ["A", "B", "C", "D"];
export const AXES_Z = ["1", "2", "3"];
export const STOREY = 3.1;
export const FLOORS = 3;

const COLUMN = 0.45;
const BEAM_W = 0.32;
const BEAM_H = 0.5;
const SLAB = 0.2;

/** Durations of each stage of the build, in seconds. */
export const TIMING = {
  axes: 1.3,
  footings: 0.9,
  piece: 0.55,
  columns: 0.7,
  beams: 0.8,
  slab: 0.6,
};

export const width = (AXES_X.length - 1) * SPAN_X;
export const depth = (AXES_Z.length - 1) * SPAN_Z;
const xs = AXES_X.map((_, i) => i * SPAN_X - width / 2);
const zs = AXES_Z.map((_, i) => i * SPAN_Z - depth / 2);

export interface Stage {
  at: number;
  label: string;
}

export function build() {
  const pieces: Piece[] = [];
  const stages: Stage[] = [{ at: 0, label: "Ejes de replanteo" }];
  let t = TIMING.axes;
  stages.push({ at: t, label: "Zapatas" });
  const nodes = xs.flatMap((x) => zs.map((z) => ({ x, z })));
  nodes.forEach(({ x, z }, i) =>
    pieces.push({
      kind: "footing",
      x,
      y: -0.15,
      z,
      w: 1.5,
      h: 0.5,
      d: 1.5,
      at: t + (i / nodes.length) * TIMING.footings,
      floor: 0,
    }),
  );
  t += TIMING.footings + TIMING.piece * 0.6;
  for (let f = 0; f < FLOORS; f++) {
    const base = f * STOREY + (f ? 0 : 0.35);
    const top = (f + 1) * STOREY;
    const level = f === 0 ? "Piso 1" : `Piso ${f + 1}`;
    stages.push({ at: t, label: `Columnas · ${level}` });
    nodes.forEach(({ x, z }, i) =>
      pieces.push({
        kind: "column",
        x,
        y: base,
        z,
        w: COLUMN,
        h: top - base - BEAM_H,
        d: COLUMN,
        at: t + (i / nodes.length) * TIMING.columns,
        floor: f + 1,
      }),
    );
    t += TIMING.columns + TIMING.piece * 0.5;
    stages.push({ at: t, label: `Vigas · ${level}` });
    const beams: Omit<Piece, "at">[] = [];
    for (const z of zs)
      for (let i = 0; i < xs.length - 1; i++)
        beams.push({
          kind: "beam",
          x: (xs[i] + xs[i + 1]) / 2,
          y: top - BEAM_H,
          z,
          w: SPAN_X + COLUMN,
          h: BEAM_H,
          d: BEAM_W,
          floor: f + 1,
        });
    for (const x of xs)
      for (let i = 0; i < zs.length - 1; i++)
        beams.push({
          kind: "beam",
          x,
          y: top - BEAM_H,
          z: (zs[i] + zs[i + 1]) / 2,
          w: BEAM_W,
          h: BEAM_H,
          d: SPAN_Z + COLUMN,
          floor: f + 1,
        });
    beams.forEach((b, i) =>
      pieces.push({ ...b, at: t + (i / beams.length) * TIMING.beams }),
    );
    t += TIMING.beams + TIMING.piece * 0.5;
    stages.push({ at: t, label: `Losa · ${level}` });
    pieces.push({
      kind: "slab",
      x: 0,
      y: top,
      z: 0,
      w: width + 1.2,
      h: SLAB,
      d: depth + 1.2,
      at: t,
      floor: f + 1,
    });
    t += TIMING.slab + TIMING.piece;
  }
  stages.push({ at: t, label: "Estructura completa" });
  return { pieces, stages, end: t, xs, zs };
}

export const height = FLOORS * STOREY + SLAB;
