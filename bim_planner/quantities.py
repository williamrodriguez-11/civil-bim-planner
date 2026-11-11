"""Cálculos independientes de Streamlit, con unidades SI y validación por fila."""

from dataclasses import dataclass, field
import math
import numbers
import re
import unicodedata

import pandas as pd


CATEGORIES = ("Columnas", "Vigas", "Losas", "Muros")
DIMENSIONS = {
    "Columnas": ("width", "depth", "height"),
    "Vigas": ("width", "height", "length"),
    "Losas": ("area", "thickness"),
    "Muros": ("length", "height", "thickness"),
}
LABELS = {
    "level": "Nivel", "type": "Familia / tipo", "id": "ID de elemento",
    "count": "Cantidad de elementos", "volume": "Volumen", "area": "Área",
    "width": "Ancho", "depth": "Profundidad", "height": "Altura",
    "length": "Longitud", "thickness": "Espesor", "mass": "Masa",
}
UNITS = {
    "mass": {"kg": 1.0, "g": 0.001, "t": 1000.0, "lb": 0.45359237},
    "length": {"m": 1.0, "cm": 0.01, "mm": 0.001, "ft": 0.3048},
    "area": {"m²": 1.0, "cm²": 0.0001, "mm²": 0.000001, "ft²": 0.09290304},
    "volume": {"m³": 1.0, "cm³": 0.000001, "mm³": 0.000000001, "ft³": 0.028316846592},
}
DETAIL_COLUMNS = ["Categoría", "Nivel", "Tipo", "ID", "Elementos", "Volumen (m³)",
                  "Área (m²)", "Archivo", "Fila origen"]
ISSUE_COLUMNS = ["Categoría", "Archivo", "Fila origen", "Estado", "Motivo"]


@dataclass
class QuantityConfig:
    category: str
    fields: dict[str, str | None]
    mode: str = "direct"
    decimal: str = ","
    units: dict[str, str] = field(default_factory=dict)
    direct_basis: str = "row_total"
    excluded_rows: tuple[int, ...] = ()
    filter_column: str | None = None
    filter_values: tuple[str, ...] = ()


@dataclass
class QuantityResult:
    detail: pd.DataFrame
    issues: pd.DataFrame


def normalized(value: object) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", str(value).lower())
                   if not unicodedata.combining(c)).strip()


def _number_pattern(decimal: str):
    thousands = r"\." if decimal == "," else ","
    integer = rf"(?:\d+|\d{{1,3}}(?:{thousands}\d{{3}})+|\d{{1,3}}(?: \d{{3}})+)"
    point = re.escape(decimal)
    return re.compile(rf"[+-]?(?:{integer}(?:{point}\d+)?|{point}\d+)(?:[eE][+-]?\d+)?")


_NUMBER_PATTERNS = {separator: _number_pattern(separator) for separator in (",", ".")}


def parse_number(value: object, decimal: str = ",", unit: str | None = None) -> float:
    """Locale explícito; rechaza unidades incompatibles y agrupaciones ambiguas."""
    if decimal not in {",", "."}:
        raise ValueError("Separador decimal inválido")
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        result = float(value)
    else:
        text = str(value).strip().replace("\u00a0", " ").replace("\u202f", " ")
        if unit:
            match = re.search(
                r"\s*((?:mm|cm|ft|m)[²³23]?|kg|g|lb|t|(?-i:ml|m\.l\.?)|"
                r"metro lineal|metros lineales|uds?\.?|unds?\.?|unidad(?:es)?)$",
                text, re.IGNORECASE,
            )
            if match:
                suffix = match.group(1).replace("2", "²").replace("3", "³")
                symbol = suffix.lower().rstrip(".")
                if symbol in {"ml", "m.l", "metro lineal", "metros lineales"}:
                    symbol = "m"
                elif symbol in {"ud", "uds", "und", "unds", "unidad", "unidades"}:
                    symbol = "ud"
                if symbol != unit.lower():
                    raise ValueError(f"unidad '{suffix}' distinta de {unit}")
                text = text[:match.start()].strip()
        thousands = "." if decimal == "," else ","
        if not _NUMBER_PATTERNS[decimal].fullmatch(text):
            if _NUMBER_PATTERNS[thousands].fullmatch(text):
                expected = "punto decimal" if thousands == "." else "coma decimal"
                raise ValueError(f"'{value}' corresponde al formato con {expected}. Revisa el separador decimal.")
            raise ValueError(f"valor numérico inválido: '{value}'")
        result = float(text.replace(thousands, "").replace(" ", "").replace(decimal, "."))
    if not math.isfinite(result) or result < 0:
        raise ValueError("se requiere un número finito no negativo")
    return result


def validate_config(frame: pd.DataFrame, config: QuantityConfig) -> None:
    if (not config.category.strip() or config.mode not in {"direct", "dimensions", "inventory"}
            or (config.mode == "dimensions" and config.category not in DIMENSIONS)):
        raise ValueError("Categoría o método no válido.")
    if config.direct_basis not in {"row_total", "per_element"}:
        raise ValueError("La base de las mediciones no es válida.")
    if config.decimal not in {",", "."}:
        raise ValueError("Separador decimal inválido.")
    required = ["level"]
    if config.mode == "direct":
        required.append("volume")
    elif config.mode == "dimensions":
        required.extend(DIMENSIONS[config.category])
    for key in required:
        if not config.fields.get(key):
            raise ValueError(f"Asigna el campo {LABELS[key]}.")
    selected = [value for value in config.fields.values() if value]
    if len(selected) != len(set(selected)):
        raise ValueError("Un campo de origen no puede representar dos magnitudes distintas.")
    for key, column in config.fields.items():
        if column and column not in frame.columns:
            raise ValueError(f"El campo '{column}' no existe en la tabla.")
        if column and key not in {"level", "type", "id", "count"}:
            dimension = key if key in UNITS else "length"
            if config.units.get(key, next(iter(UNITS[dimension]))) not in UNITS[dimension]:
                raise ValueError(f"Unidad incompatible para {LABELS[key]}.")
    if config.filter_column and config.filter_column not in frame.columns:
        raise ValueError("El campo del filtro no existe.")


def quantify(frame: pd.DataFrame, config: QuantityConfig, filename: str) -> QuantityResult:
    validate_config(frame, config)
    details, issues = [], []
    active = frame.drop(index=list(config.excluded_rows), errors="ignore")
    if config.filter_column:
        active = active[active[config.filter_column].astype(str).isin(config.filter_values)]
    id_column = config.fields.get("id")
    duplicate_ids = set()
    if id_column:
        ids = active[id_column].map(lambda v: str(v).strip())
        duplicate_ids = set(ids[ids.ne("") & ids.duplicated(keep=False)])

    def issue(index, state, reason):
        issues.append([config.category, filename, index, state, reason])

    for index, row in frame.iterrows():
        if index not in active.index:
            issue(index, "Excluida", "Exclusión manual o filtro de categoría")
            continue
        def raw(key):
            column = config.fields.get(key)
            return row[column] if column else ""

        def number(key):
            dimension = key if key in UNITS else "length"
            unit = config.units.get(key, next(iter(UNITS[dimension])))
            try:
                return parse_number(raw(key), config.decimal, unit) * UNITS[dimension][unit]
            except ValueError as exc:
                raise ValueError(f"{LABELS[key]}: {exc}") from exc

        try:
            level = str(raw("level")).strip()
            element_id = str(raw("id")).strip()
            if not level or level.lower() in {"nan", "none"}:
                raise ValueError("Nivel vacío; asigna un nivel antes de cuantificar")
            if any(re.match(r"^(?:grand total|total general|total|subtotal)(?:\b|:)", normalized(raw(k)))
                   for k in ("level", "type", "id")):
                raise ValueError("Posible fila de total/subtotal; no se incluye para evitar duplicados")
            if element_id in duplicate_ids:
                raise ValueError(f"ID duplicado: {element_id}; revisa todas sus apariciones")
            count = parse_number(raw("count"), config.decimal, "ud") if config.fields.get("count") else 1.0
            if count <= 0 or not count.is_integer():
                raise ValueError("La cantidad debe ser un entero mayor que cero")
            area = math.nan
            extra = []
            if config.mode in {"inventory", "direct"}:
                factor = count if config.direct_basis == "per_element" else 1
                volume = number("volume") * factor if config.fields.get("volume") else math.nan
                if config.fields.get("area"):
                    area = number("area") * factor
                if config.mode == "inventory":
                    extra = [number(key) * factor if config.fields.get(key) else math.nan
                             for key in ("length", "mass")]
            else:
                values = {key: number(key) for key in DIMENSIONS[config.category]}
                volume = math.prod(values.values()) * count
                if config.category == "Losas":
                    area = values["area"] * count
                elif config.category == "Muros":
                    area = values["length"] * values["height"] * count
            if any(math.isinf(v) for v in (volume, area, *extra)) or (
                    math.isnan(volume) and (config.mode != "inventory" or config.fields.get("volume"))):
                raise ValueError("El cálculo excede el rango numérico permitido")
            details.append([config.category, level, str(raw("type")).strip(), element_id,
                            int(count), volume, area, filename, index, *extra])
        except ValueError as exc:
            issue(index, "Rechazada", str(exc))
    columns = DETAIL_COLUMNS + (["Longitud (m)", "Masa (kg)"] if config.mode == "inventory" else [])
    return QuantityResult(pd.DataFrame(details, columns=columns),
                          pd.DataFrame(issues, columns=ISSUE_COLUMNS))


def summarize(detail: pd.DataFrame) -> pd.DataFrame:
    columns = ["Categoría", "Nivel", "Elementos", "Volumen (m³)", "Área (m²)", "Filas sin área"]
    if detail.empty:
        return pd.DataFrame(columns=columns)
    groups = detail.groupby(["Categoría", "Nivel"], sort=True, dropna=False)
    summary = groups[["Elementos", "Volumen (m³)", "Área (m²)"]].sum(min_count=1)
    summary["Filas sin área"] = groups["Área (m²)"].agg(lambda values: values.isna().sum())
    # No presentar como completo un total de área calculado con datos parciales.
    summary.loc[summary["Filas sin área"] > 0, "Área (m²)"] = math.nan
    for key in ["Longitud (m)", "Masa (kg)"]:
        if key in detail:
            summary[key] = groups[key].sum(min_count=1)
            columns.append(key)
    if detail["Volumen (m³)"].isna().any():
        summary["Filas sin volumen"] = groups["Volumen (m³)"].agg(lambda values: values.isna().sum())
        columns.append("Filas sin volumen")
    return summary.reset_index()[columns]
