import type { Row } from "./model";

export function reviewRow(row: Row): Row {
  const reason = String(row.Motivo ?? "");
  const total = reason.includes("total/subtotal");
  const excluded = row.Estado === "Excluida";
  let action = "Revisa el valor y la columna asignada en Tablas de origen.";
  if (total)
    action = "El total ya está representado por las filas individuales.";
  else if (excluded)
    action = "Comprueba los filtros y las exclusiones si quieres incluirla.";
  else if (reason.includes("punto decimal"))
    action = "Selecciona Punto decimal y vuelve a calcular.";
  else if (reason.includes("coma decimal"))
    action = "Selecciona Coma decimal y vuelve a calcular.";
  else if (reason.includes("Nivel vacío"))
    action =
      "Asigna una columna de nivel con valor en esta fila o revisa si es un encabezado.";
  return {
    ...row,
    Estado: total
      ? "Total omitido"
      : excluded
        ? "Omitida por filtro"
        : "Por corregir",
    "Qué hacer": action,
  };
}
