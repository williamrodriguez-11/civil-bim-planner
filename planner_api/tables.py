import csv
import hashlib
import io
import re
import zipfile
from datetime import date
from dataclasses import replace
from pathlib import Path
from itertools import islice

import pandas as pd
from fastapi import HTTPException

from bim_planner.importer import decode_text, read_table, sheet_names
from bim_planner.quantities import (
    DIMENSIONS,
    DETAIL_COLUMNS,
    ISSUE_COLUMNS,
    LABELS,
    UNITS,
    QuantityConfig,
    QuantityResult,
    parse_number,
    quantify,
    validate_config,
)

from .models import Mapping

MAX_BYTES = 16 * 1024 * 1024


def inspect_file(data, name):
    suffix = Path(name).suffix.lower()
    if suffix not in {".csv", ".txt", ".tsv", ".xls", ".xlsx"}:
        raise ValueError("Usa un archivo CSV, TXT, TSV, XLS o XLSX.")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "El límite es 16 MiB por archivo.")
    if suffix == ".xlsx":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if sum(f.file_size for f in z.infolist()) > 64 * 1024 * 1024:
                    raise ValueError("El libro supera los 64 MiB descomprimidos.")
        except zipfile.BadZipFile as exc:
            raise ValueError("El archivo XLSX no es un libro válido.") from exc
    return sheet_names(data, name) if suffix in {".xls", ".xlsx"} else []


def read(data, name, options):
    args = options.model_dump(exclude={"trim"})
    frame = read_table(data, name, **args)
    if len(frame) * len(frame.columns) > 600000:
        raise ValueError("La tabla supera el límite local de 600 000 celdas.")
    if options.trim:
        frame = frame.map(lambda v: v.strip() if isinstance(v, str) else v)
    return frame


def _schedule_header(rows, sheet_name):
    # Some Excel tables wrap the Revit schedule in Excel-generated column names.
    populated = (
        item for item in enumerate(rows, 1) if any(str(v).strip() for v in item[1])
    )
    first_three = list(islice(populated, 3))
    if len(first_three) < 3:
        return None
    (_, columns), (_, title), (header_row, headers) = first_three
    if len(columns) < 2 or not all(
        str(value).strip().casefold() in {f"column{i}", f"columna{i}"}
        for i, value in enumerate(columns, 1)
    ):
        return None
    title_cells = [str(v).strip().casefold() for v in title if str(v).strip()]
    if title_cells == [sheet_name.strip().casefold()] and all(
        isinstance(v, str) and any(c.isalpha() for c in v) for v in headers
    ):
        return header_row
    return None


def suggest_header(data, name, options):
    """Skip leading report titles only. Preserve invalid headers for manual correction."""
    suffix = Path(name).suffix.lower()
    if suffix in {".xls", ".xlsx"}:
        engine = "xlrd" if suffix == ".xls" else "openpyxl"
        with pd.ExcelFile(io.BytesIO(data), engine=engine) as book:
            sample = pd.read_excel(
                book,
                sheet_name=options.sheet,
                header=None,
                nrows=20,
                keep_default_na=False,
            )
            sheet_name = (
                book.sheet_names[options.sheet]
                if isinstance(options.sheet, int)
                else options.sheet
            )
        rows = list(sample.itertuples(index=False, name=None))
        schedule_header = _schedule_header(rows, sheet_name)
        if schedule_header is not None:
            return schedule_header
    else:
        lines = list(islice(io.StringIO(decode_text(data, options.encoding)), 20))
        rows = []
        for line in lines:
            separator = options.delimiter
            if separator == "auto":
                separator = max(("\t", ";", ","), key=line.count)
            rows.append(next(csv.reader([line], delimiter=separator), []))
    for i, row in enumerate(rows, 1):
        if sum(bool(str(cell).strip()) for cell in row) > 1:
            return i
    return 1


def records(frame):
    # Preserve very small SI volumes and native Excel numeric cells.
    rows = frame.astype(object).where(frame.notna(), None).to_dict(orient="records")
    for row in rows:
        for key, value in row.items():
            if isinstance(value, date):
                row[key] = value.isoformat()
    return rows


def profile(frame):
    fields = []
    for col in frame:
        values = frame[col]
        empty = values.map(lambda v: not str(v).strip())
        sample = values[~empty].head(100)

        units = re.findall(
            r"(?<!\w)(?:mm|cm|ft|m)[²³23]?(?!\w)|\b(?:kg|lb|g|t)\b", str(col)
        )

        def numeric(v):
            for decimal in [",", "."]:
                try:
                    parse_number(
                        v,
                        decimal,
                        units[-1].replace("2", "²").replace("3", "³")
                        if units
                        else None,
                    )
                    return True
                except ValueError:
                    continue
            return False

        kind = "Texto"
        if (
            len(sample)
            and sample.map(
                lambda v: (
                    isinstance(v, date)
                    or bool(re.fullmatch(r"\d{4}-\d\d-\d\d", str(v)))
                )
            ).all()
        ):
            kind = "Fecha"
        elif len(sample):
            numeric_count = int(sample.map(numeric).sum())
            if numeric_count == len(sample):
                kind = "Número"
            elif numeric_count >= len(sample) / 2:
                kind = "Mixto · revisar valores"
        fields.append(
            {
                "name": col,
                "kind": kind,
                "empty": int(empty.sum()),
                "unit": units[-1] if units else None,
            }
        )
    return {
        "columns": list(frame.columns),
        "fields": fields,
        "count": len(frame),
        "duplicates": int(frame.duplicated(keep=False).sum()),
        "indexes": list(frame.index),
        "rows": records(frame),
    }


def calculate(frame, mapping: Mapping, name):
    fields = {k: v for k, v in mapping.fields.items() if v}
    if set(fields) - LABELS.keys():
        raise ValueError("Parámetro de cuantificación desconocido.")
    if mapping.mode == "dimensions" and mapping.category not in DIMENSIONS:
        raise ValueError(
            "Esta categoría requiere un volumen de origen. No tiene una fórmula dimensional definida."
        )
    for key in fields.keys() - {"id", "level", "count", "type"}:
        dimension = key if key in UNITS else "length"
        if mapping.units.get(key) not in UNITS[dimension]:
            raise ValueError(f"Confirma la unidad de {LABELS[key]}.")
    args = mapping.model_dump(
        exclude={"family", "material", "strength", "attributes", "category_field"}
    )
    cfg = QuantityConfig(**args)
    if mapping.category_field:
        validate_config(frame, cfg)
        if mapping.category_field not in frame or mapping.mode == "dimensions":
            raise ValueError(
                "La clasificación por columna requiere un campo existente y mediciones de origen."
            )
        parts = []
        for category, subset in frame.groupby(
            frame[mapping.category_field].map(lambda value: str(value).strip()),
            sort=False,
        ):
            if not category:
                rejected = []
                for i, row in subset.iterrows():
                    excluded = i in cfg.excluded_rows or (
                        cfg.filter_column
                        and str(row[cfg.filter_column]) not in cfg.filter_values
                    )
                    rejected.append(
                        [
                            mapping.category,
                            name,
                            i,
                            "Excluida" if excluded else "Rechazada",
                            "Exclusión manual o filtro de categoría"
                            if excluded
                            else "Categoría vacía",
                        ]
                    )
                parts.append(
                    QuantityResult(
                        pd.DataFrame(columns=DETAIL_COLUMNS),
                        pd.DataFrame(rejected, columns=ISSUE_COLUMNS),
                    )
                )
            else:
                parts.append(quantify(subset, replace(cfg, category=category), name))
        result = QuantityResult(
            pd.concat([part.detail for part in parts], ignore_index=True),
            pd.concat([part.issues for part in parts], ignore_index=True),
        )
    else:
        result = quantify(frame, cfg, name)
    for key, label in [
        ("material", "Material"),
        ("strength", "Resistencia"),
        ("family", "Familia"),
    ]:
        column = getattr(mapping, key)
        if column and column not in frame:
            raise ValueError(f"El campo {column} ya no existe.")
        result.detail[label] = [
            str(frame.at[i, column]) if column else ""
            for i in result.detail["Fila origen"]
        ]
    for column in mapping.attributes:
        if column not in frame:
            raise ValueError(f"El atributo {column} no existe en la tabla.")
        result.detail["Campo · " + column] = [
            frame.at[i, column] for i in result.detail["Fila origen"]
        ]
    result.detail["Procedencia"] = (
        "Calculado por dimensiones"
        if cfg.mode == "dimensions"
        else "Medición de origen"
    )
    return {"detail": records(result.detail), "issues": records(result.issues)}


def identity(data, options, sheets):
    sheet = options.sheet
    if sheets:
        sheet = sheets[sheet] if isinstance(sheet, int) else sheet
    return hashlib.sha256(data).hexdigest(), str(sheet if sheets else "")
