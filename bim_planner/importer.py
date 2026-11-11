"""Lectura de tablas Revit conservando la posición de las filas de origen."""

import csv
import io
from pathlib import Path

import pandas as pd


class ImportErrorTable(ValueError):
    """Archivo o configuración de importación no válida."""


def decode_text(data: bytes, encoding: str = "auto") -> str:
    candidates = [encoding] if encoding != "auto" else (
        ["utf-16"] if data.startswith((b"\xff\xfe", b"\xfe\xff"))
        else ["utf-8-sig", "cp1252"]
    )
    for candidate in candidates:
        try:
            text = data.decode(candidate)
            if "\x00" in text:
                raise ImportErrorTable("El texto contiene bytes nulos. Selecciona UTF-16 LE o BE.")
            return text
        except UnicodeError:
            continue
    raise ImportErrorTable("No se pudo decodificar el archivo con la codificación seleccionada.")


def sheet_names(data: bytes, filename: str = "table.xlsx") -> list[str]:
    try:
        engine = "xlrd" if Path(filename).suffix.lower() == ".xls" else "openpyxl"
        with pd.ExcelFile(io.BytesIO(data), engine=engine) as book:
            return book.sheet_names
    except Exception as exc:
        raise ImportErrorTable("No se pudo abrir el libro. Verifica el formato y que esté sin cifrar.") from exc


def read_table(data: bytes, filename: str, *, sheet: str | int = 0,
               header_row: int = 1, delimiter: str = "auto",
               encoding: str = "auto") -> pd.DataFrame:
    if not data:
        raise ImportErrorTable("El archivo está vacío.")
    if header_row < 1:
        raise ImportErrorTable("La fila de encabezados debe ser mayor o igual a 1.")
    extension = Path(filename).suffix.lower()
    try:
        if extension in {".xlsx", ".xls"}:
            raw = pd.read_excel(io.BytesIO(data), sheet_name=sheet, header=None,
                                dtype=object, keep_default_na=False, engine="xlrd" if extension == ".xls" else "openpyxl")
            if header_row > len(raw):
                raise ImportErrorTable("La fila de encabezados está fuera de la tabla.")
            headers = raw.iloc[header_row - 1].tolist()
            rows = raw.iloc[header_row:].values.tolist()
        elif extension in {".csv", ".txt", ".tsv"}:
            lines = decode_text(data, encoding).splitlines(keepends=True)[header_row - 1:]
            sample = "".join(lines[:20])
            if not sample.strip():
                raise ImportErrorTable("No hay encabezados en la fila indicada.")
            if delimiter == "auto":
                try:
                    delimiter = csv.Sniffer().sniff(sample, delimiters="\t;,").delimiter
                except csv.Error:
                    # Encabezados válidos permiten detectar tablas con líneas de totales irregulares.
                    delimiter = max(("\t", ";", ","), key=lines[0].count)
            records = list(csv.reader(io.StringIO("".join(lines)), delimiter=delimiter))
            headers, rows = records[0], records[1:]
            rows = [row + [""] * (len(headers) - len(row)) for row in rows]
            if any(len(row) > len(headers) for row in rows):
                raise ImportErrorTable("Hay filas con más campos que el encabezado. Revisa el separador.")
        else:
            raise ImportErrorTable("Formato no soportado. Usa XLSX, CSV, TXT o TSV.")
        headers = [str(h).strip() for h in headers]
        if not headers or any(not h for h in headers):
            raise ImportErrorTable("Hay encabezados vacíos. Ajusta la fila de encabezados o corrige la tabla.")
        if len(set(headers)) != len(headers):
            raise ImportErrorTable("Hay encabezados repetidos. Asigna un nombre único a cada campo.")
        frame = pd.DataFrame(rows, columns=headers, dtype=object)
        frame.index = pd.RangeIndex(header_row + 1, header_row + 1 + len(frame), name="Fila origen")
        nonempty = frame.apply(lambda col: col.map(lambda value: str(value).strip() != ""))
        frame = frame.loc[nonempty.any(axis=1)]
        if frame.empty:
            raise ImportErrorTable("La tabla no contiene filas de datos.")
        return frame
    except ImportErrorTable:
        raise
    except Exception as exc:
        raise ImportErrorTable("No se pudo leer la tabla. Revisa hoja, encabezados, separador y formato.") from exc
