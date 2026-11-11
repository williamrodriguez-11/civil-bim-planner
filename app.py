
import streamlit as st
from bim_planner.scheduling import render_scheduling
from bim_planner.ui import render_quantification

st.set_page_config(
    page_title="CIVIL BIM Planner",
    page_icon="🏗️",
    layout="wide"
)

st.title("🏗️ CIVIL BIM Planner")
st.subheader("Cuantificación BIM y programación de obras")

st.sidebar.title("Navegación")

modulo = st.sidebar.radio(
    "Selecciona un módulo:",
    [
        "Inicio",
        "Cuantificación BIM",
        "Programación de obra"
    ]
)

if modulo == "Inicio":
    st.write("Bienvenido a CIVIL BIM Planner.")
    st.info(
        "Importa tablas de Revit, organiza cantidades "
        "y planifica actividades de construcción."
    )

elif modulo == "Cuantificación BIM":
    render_quantification()

elif modulo == "Programación de obra":
    render_scheduling()
