"""Reportes Excel generados por la aplicación con trazabilidad de las fuentes."""

from dataclasses import asdict
from io import BytesIO
import json

import pandas as pd
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

from .quantities import QuantityConfig, summarize


def export_excel(detail: pd.DataFrame, issues: pd.DataFrame,
                 configs: list[tuple[str, QuantityConfig, dict]],
                 sources: dict[str, pd.DataFrame], *, project_info: dict | None = None) -> bytes:
    """Devuelve valores calculados, no fórmulas ni vínculos ejecutables del archivo fuente."""
    book = Workbook()
    book.active.title = "Resumen por nivel"

    def write_frame(name, frame, existing=False):
        sheet = book[name] if existing else book.create_sheet(name)
        sheet.append(list(frame.columns))
        for record in frame.itertuples(index=False, name=None):
            sheet.append([None if pd.isna(value) else value for value in record])
        for row in sheet:
            for cell in row:
                if isinstance(cell.value, str):
                    # Los nombres de tipos/archivos pueden empezar con '='. Mantenerlos como texto.
                    cell.value = ILLEGAL_CHARACTERS_RE.sub("", cell.value)
                    cell.data_type = "s"
                elif isinstance(cell.value, float):
                    cell.number_format = "#,##0.000"
                cell.alignment = Alignment(vertical="top")
        for cell in sheet[1]:
            cell.fill = PatternFill("solid", fgColor="16324F")
            cell.font = Font(color="FFFFFF", bold=True)
            cell.alignment = Alignment(wrap_text=True, vertical="center")
        sheet.row_dimensions[1].height = 30
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for index, column in enumerate(frame.columns, 1):
            width = max([len(str(column))] + [len(str(v)) for v in frame.iloc[:200, index - 1]])
            sheet.column_dimensions[get_column_letter(index)].width = min(max(width + 2, 14), 60)
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
        sheet.page_setup.orientation = "landscape"
        sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
        sheet.page_setup.fitToWidth = 1
        sheet.page_setup.fitToHeight = 0
        sheet.print_title_rows = "1:1"

    if project_info:
        write_frame("Proyecto", pd.DataFrame(project_info.items(), columns=["Concepto", "Valor"]))
        book.move_sheet("Proyecto", offset=-1)
    write_frame("Resumen por nivel", summarize(detail), existing=True)
    write_frame("Detalle", detail)
    write_frame("Incidencias", issues)
    settings = []
    for filename, config, import_options in configs:
        for key, value in {**asdict(config), "importacion": import_options}.items():
            settings.append([config.category, filename, key,
                             json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, tuple, list)) else value])
    write_frame("Configuración", pd.DataFrame(settings, columns=["Categoría", "Archivo", "Parámetro", "Valor"]))
    for category, frame in sources.items():
        source = frame.copy()
        # No alterar un campo de origen que ya se llame Fila origen.
        source.insert(0, "Fila en archivo fuente", frame.index, allow_duplicates=True)
        write_frame(f"Fuente {category}", source)
    notes = [
        ["Alcance", "Solo las filas válidas se incluyen. Revisa Incidencias antes de utilizar los resultados."],
        ["Unidades de salida", "Volumen: m³. Área: m². Elementos: unidades. No se redondean los cálculos, solo su presentación."],
        ["Nivel", "Cada fila pertenece al nivel asignado en la tabla. No se reparte un elemento entre varios niveles."],
        ["Mediciones directas", "row_total: valores totales de la fila; per_element: multiplicados por cantidad de elementos."],
        ["Dimensiones", "Dimensiones por elemento, multiplicadas por cantidad. Columnas y vigas: sección rectangular."],
        ["Losas y muros", "Losas: área × espesor; muros: longitud × altura × espesor. Área de muro: una cara bruta."],
        ["Geometría", "Las dimensiones no descuentan huecos, uniones ni solapes. Usa el volumen de Revit para geometría irregular o neta."],
        ["Áreas", "Un área vacía significa no cuantificada. No se suman áreas entre categorías con significados distintos."],
        ["Alcance BIM", "No se calculan acero, encofrado, desperdicio ni costos. No se importan archivos RVT o IFC."],
        ["Fuentes", "Las hojas Fuente conservan la tabla importada antes de filtros y validación. Filas de texto son registros tras el encabezado."],
    ]
    write_frame("Criterios", pd.DataFrame(notes, columns=["Concepto", "Criterio"]))
    sheet = book["Criterios"]
    sheet.column_dimensions["B"].width = 100
    for row in sheet.iter_rows(min_row=2):
        row[1].alignment = Alignment(wrap_text=True, vertical="top")
        sheet.row_dimensions[row[0].row].height = 44
    output = BytesIO()
    book.save(output)
    return output.getvalue()
