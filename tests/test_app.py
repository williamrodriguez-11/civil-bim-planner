from pathlib import Path
import unittest

from streamlit.testing.v1 import AppTest


ROOT = Path(__file__).resolve().parents[1]


class AppTests(unittest.TestCase):
    def test_navigation_preserves_scheduling(self):
        app = AppTest.from_file(str(ROOT / "app.py")).run(timeout=20)
        self.assertFalse(app.exception)
        app.sidebar.radio[0].set_value("Cuantificación BIM").run()
        self.assertFalse(app.exception)
        self.assertEqual(len(app.get("file_uploader")), 4)
        app.sidebar.radio[0].set_value("Programación de obra").run()
        self.assertFalse(app.exception)
        self.assertIn("Gantt", app.info[0].value)

    def test_complete_import_calculation_and_configuration_changes(self):
        app = AppTest.from_file(str(ROOT / "app.py")).run(timeout=20)
        app.sidebar.radio[0].set_value("Cuantificación BIM").run()
        for uploader in app.file_uploader:
            category = uploader.key.removeprefix("upload_").lower()
            path = ROOT / "examples" / f"{category}.csv"
            uploader.set_value((path.name, path.read_bytes(), "text/csv"))
        app.run(timeout=30)
        self.assertFalse(app.exception, str(app.exception))
        self.assertEqual(app.metric[0].value, "10")
        self.assertEqual(app.metric[1].value, "36.400")
        self.assertEqual(len(app.get("download_button")), 1)
        for radio in app.radio:
            if radio.label == "Método de cuantificación":
                radio.set_value("Calcular con dimensiones")
        app.run(timeout=30)
        self.assertFalse(app.exception, str(app.exception))
        self.assertEqual(app.metric[1].value, "36.400")
        levels = next(widget for widget in app.multiselect if widget.label == "Niveles a visualizar")
        levels.set_value(["Nivel 2"])
        app.run(timeout=30)
        self.assertFalse(app.exception)
        self.assertEqual(app.metric[1].value, "16.680")
        self.assertEqual(len(app.get("download_button")), 1)
        # Una asignación incompleta no debe dejar disponible un reporte anterior.
        next(widget for widget in app.selectbox if widget.label == "Nivel *").set_value("")
        app.run(timeout=30)
        self.assertFalse(app.exception)
        self.assertTrue(any("Asigna el campo Nivel" in warning.value for warning in app.warning))
        self.assertEqual(len(app.get("download_button")), 0)


if __name__ == "__main__":
    unittest.main()
