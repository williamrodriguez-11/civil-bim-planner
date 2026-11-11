from io import BytesIO
from pathlib import Path
import math
import unittest

import pandas as pd
from openpyxl import Workbook, load_workbook

from bim_planner.exporter import export_excel
from bim_planner.importer import ImportErrorTable, read_table, sheet_names
from bim_planner.quantities import (DIMENSIONS, LABELS, QuantityConfig, parse_number,
                                    quantify, summarize)


ROOT = Path(__file__).resolve().parents[1]


class ImportTests(unittest.TestCase):
    def test_revit_utf16_title_and_tabs(self):
        data = "Tabla de columnas\nNivel\tVolumen\nNivel 1\t1,25 m³\n\nNivel 2\t2,5 m³\n".encode("utf-16")
        frame = read_table(data, "revit.txt", header_row=2)
        self.assertEqual(frame.index.tolist(), [3, 5])
        self.assertEqual(frame.iloc[0]["Volumen"], "1,25 m³")

    def test_cp1252_semicolon_and_literal_na(self):
        frame = read_table("Nivel;Área;Volumen\nNA;1,2;2,0\n".encode("cp1252"), "tabla.csv")
        self.assertEqual(frame.iloc[0]["Nivel"], "NA")

    def test_excel_sheet_and_numeric_cells(self):
        book = Workbook()
        book.active.title = "Notas"
        sheet = book.create_sheet("Revit")
        sheet.append(["Tabla de muros"])
        sheet.append(["Nivel", "Volumen"])
        sheet.append(["Nivel 1", 1.25])
        data = BytesIO()
        book.save(data)
        self.assertEqual(sheet_names(data.getvalue()), ["Notas", "Revit"])
        frame = read_table(data.getvalue(), "tabla.xlsx", sheet="Revit", header_row=2)
        self.assertEqual(frame.loc[3, "Volumen"], 1.25)

    def test_bad_tables_raise_explanatory_errors(self):
        cases = [(b"", "x.csv"), (b"A;A\n1;2", "x.csv"),
                 (b"A;\n1;2", "x.csv"), (b"A;B\n1;2;3", "x.csv"),
                 (b"A;B", "x.csv"), (b"invalid", "x.xlsx"), (b"invalid", "x.rvt")]
        for data, name in cases:
            with self.subTest(name=name, data=data):
                with self.assertRaises(ImportErrorTable):
                    read_table(data, name)


class NumberTests(unittest.TestCase):
    def test_linear_metre_and_piece_suffixes_require_matching_magnitudes(self):
        for value in ("2,5 ml", "2,5 m.l.", "2,5 metros lineales"):
            self.assertEqual(parse_number(value, ",", "m"), 2.5)
        self.assertEqual(parse_number("3 und.", ",", "ud"), 3)
        for value, unit in [("3 ud", "m"), ("3 ml", "m³"), ("3 mL", "m"), ("3 kg", "ud")]:
            with self.subTest(value=value, unit=unit), self.assertRaises(ValueError):
                parse_number(value, ",", unit)

    def test_locales_units_and_numeric_excel_cells(self):
        cases = [("1.234,56 m³", ",", "m³", 1234.56),
                 ("1,234.56 ft3", ".", "ft³", 1234.56),
                 ("1\u202f234,56", ",", None, 1234.56),
                 (1.234, ",", None, 1.234), ("2e3", ",", "m³", 2000),
                 ("0", ",", None, 0)]
        for value, decimal, unit, expected in cases:
            with self.subTest(value=value):
                self.assertAlmostEqual(parse_number(value, decimal, unit), expected)

    def test_invalid_or_conflicting_units_are_not_silently_converted(self):
        for value in ("", "N/D", "12,34.56", "1.23", "1,2,3", "-2", "NaN", "inf", math.inf, True, "2 ft³", "2 kg"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_number(value, ",", "m³")


class QuantityTests(unittest.TestCase):
    def frame(self, rows):
        return pd.DataFrame(rows, columns=["Nivel", "Cantidad", "Volumen", "ID"], index=range(2, len(rows) + 2))

    def config(self, **kwargs):
        fields = {"level": "Nivel", "count": "Cantidad", "volume": "Volumen"}
        fields.update(kwargs.pop("fields", {}))
        return QuantityConfig("Columnas", fields, **kwargs)

    def test_grouped_totals_are_not_multiplied_twice(self):
        frame = self.frame([["N1", 3, "1,2", "a"], ["N1", 2, "0,8", "b"]])
        result = quantify(frame, self.config(), "x.csv")
        self.assertEqual(summarize(result.detail).iloc[0]["Elementos"], 5)
        self.assertAlmostEqual(result.detail["Volumen (m³)"].sum(), 2)
        per_element = quantify(frame, self.config(direct_basis="per_element"), "x.csv")
        self.assertAlmostEqual(per_element.detail["Volumen (m³)"].sum(), 5.2)

    def test_all_categories_direct_and_dimensions_agree(self):
        expected = {"Columnas": 1.2, "Vigas": 1.6, "Losas": 24, "Muros": 9.6}
        for category, volume in expected.items():
            with self.subTest(category=category):
                path = ROOT / "examples" / f"{category.lower()}.csv"
                frame = read_table(path.read_bytes(), path.name)
                base = {"level": "Nivel", "count": "Cantidad", "type": "Tipo"}
                direct = quantify(frame, QuantityConfig(category, {**base, "volume": "Volumen"}), path.name)
                fields = {**base, **{key: LABELS[key] for key in DIMENSIONS[category]}}
                dimensions = quantify(frame, QuantityConfig(category, fields, mode="dimensions"), path.name)
                self.assertTrue(dimensions.issues.empty)
                self.assertAlmostEqual(direct.detail["Volumen (m³)"].sum(), volume)
                self.assertAlmostEqual(dimensions.detail["Volumen (m³)"].sum(), volume)
                self.assertEqual(len(summarize(dimensions.detail)), 2)

    def test_mixed_dimension_units_and_quantity(self):
        frame = pd.DataFrame({"Nivel": ["N1"], "Ancho": [300], "Profundidad": [40], "Altura": [3], "Cantidad": [2]})
        config = QuantityConfig("Columnas", {"level": "Nivel", "width": "Ancho", "depth": "Profundidad", "height": "Altura", "count": "Cantidad"},
                                mode="dimensions", units={"width": "mm", "depth": "cm", "height": "m"})
        self.assertAlmostEqual(quantify(frame, config, "x").detail.iloc[0]["Volumen (m³)"], 0.72)

    def test_imperial_volume_conversion(self):
        frame = self.frame([["N1", 1, "10 ft³", ""]])
        result = quantify(frame, self.config(units={"volume": "ft³"}), "x")
        self.assertAlmostEqual(result.detail.iloc[0]["Volumen (m³)"], 0.28316846592)

    def test_rejects_invalid_rows_and_subtotals_without_hiding_them(self):
        frame = self.frame([["N1", 1, 1, "a"], ["", 1, 2, "b"], ["N1", "1,5", 2, "c"],
                            ["Total general", 2, 3, ""], ["N1", 1, -1, "d"], ["N1", 0, 1, "e"]])
        result = quantify(frame, self.config(), "x")
        self.assertEqual(len(result.detail), 1)
        self.assertEqual(len(result.issues), 5)
        self.assertEqual(result.issues["Fila origen"].tolist(), [3, 4, 5, 6, 7])

    def test_duplicate_ids_exclude_all_occurrences(self):
        frame = self.frame([["N1", 1, 1, "a"], ["N1", 1, 1, "a"], ["N1", 1, 2, "b"]])
        result = quantify(frame, self.config(fields={"id": "ID"}), "x")
        self.assertEqual(len(result.detail), 1)
        self.assertEqual(len(result.issues), 2)
        clean = quantify(frame, self.config(fields={"id": "ID"}, excluded_rows=(3,)), "x")
        self.assertEqual(len(clean.detail), 2)

    def test_filter_and_manual_exclusions(self):
        frame = self.frame([["N1", 1, 1, "a"], ["N2", 1, 1, "b"], ["N1", 1, 2, "c"]])
        result = quantify(frame, self.config(filter_column="Nivel", filter_values=("N1",), excluded_rows=(4,)), "x")
        self.assertEqual(len(result.detail), 1)
        self.assertEqual(result.issues["Estado"].tolist(), ["Excluida", "Excluida"])

    def test_missing_count_is_one_and_zero_volume_is_valid(self):
        config = QuantityConfig("Columnas", {"level": "Nivel", "volume": "Volumen"})
        result = quantify(self.frame([["N1", "", 0, ""]]), config, "x")
        self.assertEqual(result.detail.iloc[0]["Elementos"], 1)
        self.assertEqual(result.detail.iloc[0]["Volumen (m³)"], 0)
        self.assertTrue(pd.isna(summarize(result.detail).iloc[0]["Área (m²)"]))

    def test_config_errors(self):
        frame = self.frame([["N1", 1, 1, "a"]])
        cases = [self.config(fields={"level": None}), self.config(fields={"count": "Volumen"}),
                 self.config(units={"volume": "m"}), self.config(fields={"volume": "Inexistente"})]
        for config in cases:
            with self.subTest(config=config), self.assertRaises(ValueError):
                quantify(frame, config, "x")

    def test_area_count_and_overflow(self):
        frame = pd.DataFrame({"Nivel": ["N1"], "Cantidad": [2], "Área": [5.0], "Espesor": [0.2]})
        config = QuantityConfig("Losas", {"level": "Nivel", "count": "Cantidad", "area": "Área", "thickness": "Espesor"}, mode="dimensions")
        result = quantify(frame, config, "x")
        self.assertEqual(result.detail.iloc[0]["Área (m²)"], 10)
        self.assertEqual(result.detail.iloc[0]["Volumen (m³)"], 2)
        frame.loc[0, "Área"] = 1e308
        frame.loc[0, "Espesor"] = 1e308
        self.assertEqual(len(quantify(frame, config, "x").issues), 1)


class ExportTests(unittest.TestCase):
    def test_roundtrip_totals_sources_settings_and_text_safety(self):
        frame = read_table(b'Nivel;Volumen;Tipo\nN1;2;=1+1\nN2;invalid;Normal\n', "x.csv")
        config = QuantityConfig("Columnas", {"level": "Nivel", "volume": "Volumen", "type": "Tipo"})
        result = quantify(frame, config, "x.csv")
        data = export_excel(result.detail, result.issues, [("x.csv", config, {"header_row": 1})], {"Columnas": frame})
        book = load_workbook(BytesIO(data), data_only=False)
        self.assertEqual(book.sheetnames, ["Resumen por nivel", "Detalle", "Incidencias", "Configuración", "Fuente Columnas", "Criterios"])
        self.assertEqual(book["Resumen por nivel"]["D2"].value, 2)
        self.assertIsNone(book["Resumen por nivel"]["E2"].value)
        self.assertEqual(book["Detalle"]["C2"].value, "=1+1")
        self.assertEqual(book["Detalle"]["C2"].data_type, "s")
        self.assertEqual(book["Fuente Columnas"]["D2"].data_type, "s")
        self.assertEqual(book["Incidencias"]["C2"].value, 3)
        for sheet in book:
            self.assertEqual(sheet.freeze_panes, "A2")
            self.assertTrue(sheet.auto_filter.ref)
            self.assertFalse(any(cell.data_type == "f" for row in sheet for cell in row))


if __name__ == "__main__":
    unittest.main()
