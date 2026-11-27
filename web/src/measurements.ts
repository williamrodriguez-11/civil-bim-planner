import type { Row } from "./model";

// The column names are part of the persisted Python quantity result.
export const measures = [
  { column: "Volumen (m³)", label: "Volumen", unit: "m³" },
  { column: "Área (m²)", label: "Área", unit: "m²" },
  { column: "Longitud (m)", label: "Longitud", unit: "m" },
  { column: "Masa (kg)", label: "Masa", unit: "kg" },
  { column: "Elementos", label: "Conteo", unit: "ud" },
] as const;

type Measure = (typeof measures)[number];
export const unitLabel = (unit: string) => (unit === "m" ? "m lineales" : unit);

export function availableMeasures(rows: Row[]) {
  return measures.filter((m) =>
    rows.some((row) => typeof row[m.column] === "number"),
  );
}
export type Measurement = Measure & {
  key: string;
  category?: string;
  total: number;
  measuredRows: number;
  sourceRows: number;
};

export function summarizeMeasurements(
  rows: Row[],
  definitions: readonly Measure[] = measures,
): Measurement[] {
  const result: Measurement[] = [];
  for (const measure of definitions) {
    const groups = new Map<string | undefined, Measurement>();
    for (const row of rows) {
      // A wall face and a slab footprint have different measurement bases.
      const category =
        measure.unit === "m²" ? String(row.Categoría) : undefined;
      let group = groups.get(category);
      if (!group) {
        group = {
          ...measure,
          category,
          key: JSON.stringify([measure.column, category]),
          total: 0,
          measuredRows: 0,
          sourceRows: 0,
        };
        groups.set(category, group);
      }
      group.sourceRows++;
      const value = row[measure.column];
      if (typeof value === "number" && Number.isFinite(value)) {
        group.total += value;
        group.measuredRows++;
      }
    }
    result.push(
      ...Array.from(groups.values())
        .filter((g) => g.measuredRows > 0)
        .sort((a, b) =>
          (a.category ?? "").localeCompare(b.category ?? "", "es"),
        ),
    );
  }
  return result;
}

export function measurementTotal(measure: Measurement): number | null {
  if (measure.unit === "m²" && measure.measuredRows < measure.sourceRows)
    return null;
  return measure.total;
}

/** Position of a level from bottom to top. Uses the elevation in the name
 * («NE -2.90m», «NE+14.35m») and otherwise words such as sótano, piso 3 or
 * cubierta. Unknown names return null and keep their natural order. */
const ELEVATION = /([+-])\s*(\d+(?:[.,]\d+)?)\s*m\b/;
const plain = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** Elevation in meters written in the name («NE -2.90m»), if any. */
export function levelElevation(name: string): number | null {
  const found = plain(name).match(ELEVATION);
  return found ? Number(found[1] + found[2].replace(",", ".")) : null;
}

/** Floor rank from words and numbers (sótano 1, planta baja, piso 3…),
 * never from meters: it is compared only with other floor ranks. */
export function levelHeight(name: string): number | null {
  const text = plain(name).replace(ELEVATION, " ");
  const number = Number(text.match(/\d+/)?.[0] ?? 1);
  if (/cimentaci|fundaci|zapata/.test(text)) return -10000;
  if (/semi\s*-?\s*sotano/.test(text)) return -500;
  if (/sotano|basement/.test(text)) return -1000 - number;
  if (/planta baja|ground|\bpb\b/.test(text)) return 0.5;
  if (/cubierta|azotea|terraza|roof/.test(text)) return 10000;
  if (/piso|nivel|planta|level|story|storey/.test(text)) return number;
  return null;
}

export function compareLevels(a: string, b: string) {
  // Meters only against meters; otherwise floor ranks against floor ranks.
  const ea = levelElevation(a),
    eb = levelElevation(b);
  if (ea !== null && eb !== null && ea !== eb) return ea - eb;
  const x = levelHeight(a),
    y = levelHeight(b);
  if (x !== null && y !== null && x !== y) return x - y;
  if (x !== null && y === null) return -1;
  if (x === null && y !== null) return 1;
  return a.localeCompare(b, "es", { numeric: true });
}

export function measurementName(measure: Measurement) {
  return measure.category
    ? measure.label + " · " + measure.category
    : measure.label;
}
