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

export function measurementName(measure: Measurement) {
  return measure.category
    ? measure.label + " · " + measure.category
    : measure.label;
}
