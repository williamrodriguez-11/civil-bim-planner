import streamlit as st
import pandas as pd
import plotly.express as px
from datetime import date
from io import BytesIO

st.set_page_config(
    page_title="CIVIL BIM Planner",
    page_icon="🏗️",
    layout="wide"
)

st.title("CIVIL BIM Planner")
st.caption(
    "Cuantificación estructural y programación de obra"
)

pagina = st.sidebar.radio(
    "Selecciona un módulo",
    [
        "Inicio",
        "Cuantificación estructural",
        "Programación de obra"
    ]
)

if pagina == "Inicio":
    st.header("Bienvenido a CIVIL BIM Planner")

    st.write(
        "Herramienta académica para apoyar proyectos "
        "estructurales y de edificación."
    )

    col1, col2 = st.columns(2)

    with col1:
        st.subheader("Cuantificación estructural")
        st.write(
            "Importa tablas exportadas desde Revit, "
            "organiza cantidades y genera informes."
        )

    with col2:
        st.subheader("Programación de obra")
        st.write(
            "Organiza actividades, define duraciones "
            "y visualiza un cronograma tipo Gantt."
        )

    st.info(
        "Esta versión utiliza archivos Excel y CSV. "
        "No abre directamente modelos RVT ni modifica "
        "archivos nativos de Microsoft Project."
    )

elif pagina == "Cuantificación estructural":
    st.header("Cuantificación estructural")

    archivo = st.file_uploader(
        "Carga una tabla exportada desde Revit",
        type=["xlsx", "csv"]
    )

    if archivo is not None:
        try:
            if archivo.name.lower().endswith(".csv"):
                df = pd.read_csv(archivo)
            else:
                df = pd.read_excel(archivo)

            st.subheader("Vista previa")
            st.dataframe(df, use_container_width=True)

            columnas = list(df.columns)

            if len(columnas) < 2:
                st.error("El archivo debe tener al menos dos columnas.")
                st.stop()

            def buscar_columna(opciones):
                for i, columna in enumerate(columnas):
                    if str(columna).strip().lower() in opciones:
                        return i
                return 0

            col1, col2, col3 = st.columns(3)

            categoria = col1.selectbox(
                "Categoría",
                columnas,
                index=buscar_columna(
                    {"categoría", "categoria", "category"}
                )
            )

            nivel = col2.selectbox(
                "Nivel o piso",
                columnas,
                index=buscar_columna(
                    {"nivel", "piso", "level", "floor"}
                )
            )

            cantidad = col3.selectbox(
                "Columna de cantidad",
                columnas,
                index=buscar_columna(
                    {"cantidad", "quantity", "volume", "area"}
                )
            )

            datos = df.copy()

            datos[cantidad] = pd.to_numeric(
                datos[cantidad],
                errors="coerce"
            )

            invalidos = int(datos[cantidad].isna().sum())

            datos_validos = datos.dropna(
                subset=[cantidad]
            ).copy()

            a, b, c = st.columns(3)

            a.metric("Registros importados", len(df))
            b.metric("Cantidades válidas", len(datos_validos))
            c.metric("Registros por revisar", invalidos)

            if not datos_validos.empty:
                resumen_categoria = (
                    datos_validos
                    .groupby(categoria, dropna=False)[cantidad]
                    .sum()
                    .reset_index(name="Total numérico")
                )

                resumen_nivel = (
                    datos_validos
                    .groupby(nivel, dropna=False)[cantidad]
                    .sum()
                    .reset_index(name="Total numérico")
                )

                izquierda, derecha = st.columns(2)

                with izquierda:
                    st.subheader("Cantidades por categoría")
                    st.dataframe(
                        resumen_categoria,
                        use_container_width=True,
                        hide_index=True
                    )
                    st.bar_chart(
                        resumen_categoria.set_index(categoria)
                    )

                with derecha:
                    st.subheader("Cantidades por nivel")
                    st.dataframe(
                        resumen_nivel,
                        use_container_width=True,
                        hide_index=True
                    )
                    st.bar_chart(
                        resumen_nivel.set_index(nivel)
                    )

                st.warning(
                    "Verifica las unidades antes de interpretar "
                    "los resultados. Esta versión no convierte "
                    "ni combina automáticamente m², m³, metros "
                    "y unidades."
                )

                salida = BytesIO()

                with pd.ExcelWriter(
                    salida,
                    engine="openpyxl"
                ) as writer:
                    df.to_excel(
                        writer,
                        sheet_name="Datos importados",
                        index=False
                    )
                    resumen_categoria.to_excel(
                        writer,
                        sheet_name="Por categoria",
                        index=False
                    )
                    resumen_nivel.to_excel(
                        writer,
                        sheet_name="Por nivel",
                        index=False
                    )

                st.download_button(
                    "Descargar informe Excel",
                    data=salida.getvalue(),
                    file_name="informe_cuantificacion.xlsx",
                    mime=(
                        "application/vnd.openxmlformats-officedocument."
                        "spreadsheetml.sheet"
                    )
                )

        except Exception as error:
            st.error(
                f"No se pudo procesar el archivo: {error}"
            )

    else:
        st.info(
            "Exporta una tabla de planificación desde Revit "
            "a Excel o CSV para comenzar."
        )

elif pagina == "Programación de obra":
    st.header("Programación preliminar de obra")

    st.write(
        "Edita actividades, duraciones, fechas y predecesoras "
        "para generar una visualización inicial."
    )

    archivo = st.file_uploader(
        "Importar actividades desde Excel o CSV (opcional)",
        type=["xlsx", "csv"],
        key="archivo_cronograma"
    )

    if archivo is not None:
        try:
            if archivo.name.lower().endswith(".csv"):
                actividades = pd.read_csv(archivo)
            else:
                actividades = pd.read_excel(archivo)
        except Exception as error:
            st.error(f"No se pudo leer el archivo: {error}")
            st.stop()
    else:
        actividades = pd.DataFrame({
            "ID": ["A01", "A02", "A03", "A04"],
            "Actividad": [
                "Actividades preliminares",
                "Desmonte y limpieza",
                "Excavación",
                "Cimentación"
            ],
            "Duración (días)": [3, 2, 4, 5],
            "Predecesoras": ["", "A01", "A02", "A03"],
            "Inicio": [
                date.today(),
                date.today(),
                date.today(),
                date.today()
            ]
        })

        st.info(
            "Se muestran actividades ficticias de ejemplo. "
            "Sus fechas y duraciones no son rendimientos validados."
        )

    if "Actividad" not in actividades.columns:
        st.error(
            "El archivo debe incluir una columna llamada Actividad."
        )
        st.stop()

    if "ID" not in actividades.columns:
        actividades.insert(
            0,
            "ID",
            [f"A{i+1:02d}" for i in range(len(actividades))]
        )

    if "Duración (días)" not in actividades.columns:
        actividades["Duración (días)"] = 1

    if "Predecesoras" not in actividades.columns:
        actividades["Predecesoras"] = ""

    if "Inicio" not in actividades.columns:
        actividades["Inicio"] = date.today()

    st.subheader("Editar actividades")

    editadas = st.data_editor(
        actividades,
        num_rows="dynamic",
        use_container_width=True
    )

    editadas["Duración (días)"] = pd.to_numeric(
        editadas["Duración (días)"],
        errors="coerce"
    )

    editadas["Inicio"] = pd.to_datetime(
        editadas["Inicio"],
        errors="coerce"
    )

    duracion_invalida = (
        editadas["Duración (días)"].isna()
        | (editadas["Duración (días)"] <= 0)
    )

    fecha_invalida = editadas["Inicio"].isna()

    if duracion_invalida.any():
        st.warning(
            "Hay actividades con duración inválida. "
            "Las duraciones deben ser mayores que cero."
        )

    if fecha_invalida.any():
        st.warning(
            "Hay actividades con fechas de inicio inválidas."
        )

    validas = editadas[
        ~duracion_invalida & ~fecha_invalida
    ].copy()

    validas["Fin"] = (
        validas["Inicio"]
        + pd.to_timedelta(
            validas["Duración (días)"] - 1,
            unit="D"
        )
    )

    ids = set(validas["ID"].astype(str))
    predecesoras_faltantes = []

    for _, fila in validas.iterrows():
        texto = str(fila["Predecesoras"]).strip()

        if texto and texto.lower() != "nan":
            predecesoras = [
                p.strip()
                for p in texto.replace(";", ",").split(",")
                if p.strip()
            ]

            for predecesora in predecesoras:
                if predecesora not in ids:
                    predecesoras_faltantes.append(
                        f"{fila['ID']} depende de {predecesora}"
                    )

    if predecesoras_faltantes:
        st.warning(
            "Revisa estas predecesoras: "
            + "; ".join(predecesoras_faltantes)
        )

    if not validas.empty:
        st.subheader("Diagrama de Gantt")

        grafico = px.timeline(
            validas,
            x_start="Inicio",
            x_end="Fin",
            y="Actividad",
            color="ID",
            hover_data=[
                "ID",
                "Duración (días)",
                "Predecesoras"
            ]
        )

        grafico.update_yaxes(autorange="reversed")

        st.plotly_chart(
            grafico,
            use_container_width=True
        )

        st.caption(
            "Este Gantt muestra las fechas ingresadas. "
            "Todavía no calcula la ruta crítica ni ajusta "
            "automáticamente las fechas según las dependencias."
        )

        exportacion = validas.copy()

        exportacion["Inicio"] = (
            exportacion["Inicio"].dt.strftime("%Y-%m-%d")
        )

        exportacion["Fin"] = (
            exportacion["Fin"].dt.strftime("%Y-%m-%d")
        )

        salida = BytesIO()

        with pd.ExcelWriter(
            salida,
            engine="openpyxl"
        ) as writer:
            exportacion.to_excel(
                writer,
                sheet_name="Cronograma",
                index=False
            )

        st.download_button(
            "Descargar cronograma Excel",
            data=salida.getvalue(),
            file_name="cronograma_obra.xlsx",
            mime=(
                "application/vnd.openxmlformats-officedocument."
                "spreadsheetml.sheet"
            )
        )

        st.download_button(
            "Descargar actividades CSV",
            data=exportacion.to_csv(
                index=False
            ).encode("utf-8-sig"),
            file_name="actividades.csv",
            mime="text/csv"
        )
