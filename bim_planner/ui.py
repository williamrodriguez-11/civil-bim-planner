"""Interfaz Streamlit de importación y configuración por categoría."""

import hashlib

import pandas as pd
import streamlit as st

from .exporter import export_excel
from .importer import ImportErrorTable, read_table, sheet_names
from .quantities import (CATEGORIES, DETAIL_COLUMNS, DIMENSIONS, ISSUE_COLUMNS,
                         LABELS, UNITS, QuantityConfig, normalized, quantify, summarize)


ALIASES = {
    "level": ["nivel", "nivel base", "nivel de referencia", "restriccion de base", "base level", "reference level", "level"],
    "type": ["familia y tipo", "familia / tipo", "tipo", "family and type", "type"],
    "id": ["id de elemento", "id", "element id"],
    "count": ["recuento", "cantidad", "count"],
    "volume": ["volumen", "volume"], "area": ["area", "área", "area de material"],
    "width": ["ancho", "anchura", "width", "b"],
    "depth": ["profundidad", "depth"], "height": ["altura", "altura desconectada", "height", "h"],
    "length": ["longitud", "length"], "thickness": ["espesor", "thickness"],
}


def guess_field(columns, key):
    for alias in ALIASES[key]:
        for column in columns:
            name = normalized(column)
            if name == normalized(alias):
                return column
    return None


@st.cache_data(show_spinner=False)
def cached_read(data, filename, options):
    return read_table(data, filename, **options)


def category_panel(category):
    st.subheader(category)
    uploaded = st.file_uploader(f"Tabla de {category.lower()}", type=["csv", "txt", "tsv", "xlsx"],
                               key=f"upload_{category}")
    if uploaded is None:
        st.caption("Carga una tabla de esta categoría. Si incluye varias categorías, aplica un filtro después de importarla.")
        return None
    data = uploaded.getvalue()
    fingerprint = hashlib.sha256(data).hexdigest()[:16]
    prefix = f"{category}_{fingerprint}"
    try:
        with st.expander("Opciones de importación", expanded=True):
            left, right = st.columns(2)
            header = left.number_input("Fila de encabezados (empieza en 1)", min_value=1, value=1,
                                       step=1, key=f"{prefix}_header")
            options = {"header_row": header}
            if uploaded.name.lower().endswith(".xlsx"):
                options["sheet"] = right.selectbox("Hoja de Excel", sheet_names(data), key=f"{prefix}_sheet")
            else:
                separators = {"Automático": "auto", "Tabulación": "\t", "Punto y coma": ";", "Coma": ","}
                separator = right.selectbox("Separador de campos", list(separators), key=f"{prefix}_sep")
                options["delimiter"] = separators[separator]
                options["encoding"] = st.selectbox("Codificación", ["auto", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "cp1252"], key=f"{prefix}_enc")
        frame = cached_read(data, uploaded.name, options)
    except ImportErrorTable as exc:
        st.error(str(exc))
        return None

    # Cada esquema y hoja tienen su propio estado de configuración.
    schema = hashlib.sha256(repr((options, frame.columns.tolist())).encode()).hexdigest()[:12]
    prefix += f"_{schema}"
    st.caption(f"{len(frame)} filas importadas · {len(frame.columns)} campos")
    with st.expander("Vista previa y selección de filas", expanded=True):
        visible = st.multiselect("Campos visibles", frame.columns.tolist(), default=frame.columns.tolist(), key=f"{prefix}_visible")
        st.dataframe(frame[visible], width="stretch")
        excluded = st.multiselect("Excluir filas de origen (títulos, subtotales u otras filas)", frame.index.tolist(), key=f"{prefix}_exclude")
        filter_column = st.selectbox("Filtrar por un campo (opcional)", ["", *frame.columns],
                                     format_func=lambda v: "Sin filtro" if v == "" else v, key=f"{prefix}_filter")
        filter_values = []
        if filter_column:
            filter_values = st.multiselect("Valores que se incluirán", sorted(frame[filter_column].astype(str).unique()), key=f"{prefix}_{filter_column}_values")

    method = st.radio("Método de cuantificación", ["Volumen de Revit", "Calcular con dimensiones"], horizontal=True, key=f"{prefix}_method")
    mode = "direct" if method == "Volumen de Revit" else "dimensions"
    decimal_label = st.selectbox("Separador decimal del texto", ["Coma (1.234,56)", "Punto (1,234.56)"], key=f"{prefix}_decimal")
    decimal = "," if decimal_label.startswith("Coma") else "."
    st.caption("El separador decimal aplica a texto. Las celdas numéricas de Excel se leen directamente.")
    fields, units = {}, {}

    def field_selector(key, required=False):
        choices = ["", *frame.columns]
        default = guess_field(frame.columns, key) or ""
        fields[key] = st.selectbox(LABELS[key] + (" *" if required else " (opcional)"), choices,
                                  index=choices.index(default), format_func=lambda v: "— Sin asignar —" if v == "" else v,
                                  key=f"{prefix}_{mode}_field_{key}")
        if fields[key] and key not in {"level", "type", "id", "count"}:
            dimension = key if key in {"volume", "area"} else "length"
            units[key] = st.selectbox(f"Unidad de {LABELS[key].lower()}", list(UNITS[dimension]), key=f"{prefix}_{mode}_unit_{key}")

    left, right = st.columns(2)
    with left:
        field_selector("level", True)
        field_selector("type")
    with right:
        field_selector("id")
        field_selector("count")
    st.caption("Sin campo de cantidad, cada fila representa un elemento. El nivel se toma del campo asignado, sin repartir elementos entre pisos.")
    basis = "row_total"
    if mode == "direct":
        left, right = st.columns(2)
        with left:
            field_selector("volume", True)
        with right:
            field_selector("area")
        basis_label = st.radio("Los valores de volumen y área representan", ["El total de la fila", "Un elemento (multiplicar por cantidad)"], key=f"{prefix}_basis")
        basis = "row_total" if basis_label == "El total de la fila" else "per_element"
    else:
        st.info("Dimensiones por elemento. Se multiplicarán por la cantidad. Modelo rectangular, sin descontar huecos, uniones ni solapes.")
        formulas = {"Columnas": "ancho × profundidad × altura", "Vigas": "ancho × altura × longitud",
                    "Losas": "área por elemento × espesor", "Muros": "longitud × altura × espesor"}
        st.caption(f"Volumen = {formulas[category]} × cantidad. Área: losa en planta o una cara bruta del muro; no se calcula encofrado.")
        columns = st.columns(len(DIMENSIONS[category]))
        for column, key in zip(columns, DIMENSIONS[category]):
            with column:
                field_selector(key, True)
    config = QuantityConfig(category, fields, mode, decimal, units, basis, tuple(excluded), filter_column, tuple(filter_values))
    try:
        result = quantify(frame, config, uploaded.name)
    except ValueError as exc:
        st.warning(str(exc))
        return None
    rejected = int((result.issues["Estado"] == "Rechazada").sum())
    if rejected:
        st.warning(f"{rejected} filas rechazadas. Revisa las incidencias; los resultados incluyen únicamente filas válidas.")
    if result.detail.empty:
        st.warning("No hay filas válidas con esta configuración.")
    else:
        st.success(f"{len(result.detail)} filas válidas · {int(result.detail['Elementos'].sum())} elementos")
    if not result.issues.empty:
        st.dataframe(result.issues, hide_index=True, width="stretch")
    return uploaded.name, config, options, frame, result


def render_quantification():
    st.header("Cuantificación BIM")
    st.write("Importa las tablas de Revit y asigna los campos de cada categoría. Los resultados se actualizan al cambiar la configuración.")
    st.caption("Admite XLSX y tablas CSV/TXT/TSV, incluidas exportaciones tabuladas UTF-16. Para tablas con título, ajusta la fila de encabezados.")
    entries = []
    pending = []
    for tab, category in zip(st.tabs(list(CATEGORIES)), CATEGORIES):
        with tab:
            entry = category_panel(category)
            if entry:
                entries.append(entry)
            elif st.session_state.get(f"upload_{category}") is not None:
                pending.append(category)
    if pending:
        st.warning("Tablas pendientes de configurar: " + ", ".join(pending) + ". Completa su configuración para exportar el reporte consolidado.")
    if not entries:
        return
    detail = pd.concat([entry[4].detail for entry in entries], ignore_index=True) if entries else pd.DataFrame(columns=DETAIL_COLUMNS)
    issues = pd.concat([entry[4].issues for entry in entries], ignore_index=True) if entries else pd.DataFrame(columns=ISSUE_COLUMNS)
    st.divider()
    st.subheader("Resultados por nivel")
    st.caption("Todas las categorías configuradas. El área se informa por categoría; una celda vacía indica que no fue cuantificada.")
    if not detail.empty:
        levels = sorted(detail["Nivel"].unique())
        selected_levels = st.multiselect("Niveles a visualizar", levels, default=levels)
        view = detail[detail["Nivel"].isin(selected_levels)]
        left, middle, right = st.columns(3)
        left.metric("Elementos visibles", f"{int(view['Elementos'].sum()):,}")
        middle.metric("Volumen visible (m³)", f"{view['Volumen (m³)'].sum():,.3f}")
        right.metric("Filas rechazadas (todas)", int((issues["Estado"] == "Rechazada").sum()))
        st.dataframe(summarize(view), hide_index=True, width="stretch")
        with st.expander("Detalle de cantidades"):
            st.dataframe(view, hide_index=True, width="stretch")
    if not issues.empty:
        with st.expander("Incidencias de todas las categorías"):
            st.dataframe(issues, hide_index=True, width="stretch")
    if detail.empty or pending:
        st.info("La exportación requiere al menos una fila válida y todas las tablas cargadas configuradas.")
        return
    if (issues["Estado"] == "Rechazada").any():
        st.warning("El reporte será parcial: las filas rechazadas no suman cantidades y se incluyen en la hoja Incidencias.")
    st.caption("Excel incluye todos los niveles, independientemente del filtro de visualización: resumen, detalle, incidencias, configuración y tablas fuente.")
    workbook = export_excel(detail, issues, [(entry[0], entry[1], entry[2]) for entry in entries],
                            {entry[1].category: entry[3] for entry in entries})
    st.download_button("Descargar cuantificación en Excel", workbook, "CIVIL_BIM_cuantificacion.xlsx",
                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", type="primary")
