import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test("Flujo sintético desde una tabla sin esquema fijo hasta el reporte y el Gantt", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Crear una cuenta" }).click();
  await page.getByLabel("Nombre de usuario").fill("pilotes");
  await page.getByLabel("Contraseña", { exact: true }).fill("cuenta para pruebas");
  await page.getByRole("button", { name: "Crear cuenta", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Resumen general" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("inicio.png") });
  await page.getByRole("button", { name: "Crear primer proyecto" }).click();
  await page
    .getByLabel("Nombre del proyecto")
    .fill("Ensayo sintético de pilotes");
  await page
    .getByRole("button", { name: "Crear proyecto", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Importar tablas", exact: true })
    .click();
  await page.getByLabel("Seleccionar archivos").setInputFiles({
    name: "Pilotes sintéticos.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Planta;Medición;Marca\nPB;12,5;P-01\nPB;2,5;P-02"),
  });
  await page.getByRole("button", { name: "Guardar tabla" }).click();
  await page
    .getByRole("combobox", { name: "Categoría", exact: true })
    .fill("Pilotes");
  await page
    .getByRole("combobox", { name: "Nivel", exact: true })
    .selectOption("Planta");
  await page
    .getByRole("combobox", { name: "Volumen", exact: true })
    .selectOption("Medición");
  await page.getByLabel("Unidad de Volumen").selectOption("m³");
  await page.getByLabel("Decimal en texto").selectOption(".");
  await page.getByRole("button", { name: "Calcular y guardar" }).click();
  await expect(page.getByRole("status")).toContainText("sin filas cuantificadas");
  await expect(page.getByRole("status")).toContainText("coma decimal");
  await page.getByRole("button", { name: "Ver incidencias del proyecto" }).click();
  await expect(page.getByRole("button", { name: "Incidencias · 2" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("cell", { name: /12,5.*coma decimal/ })).toBeVisible();
  await page.getByRole("button", { name: "Detalle", exact: true }).click();
  await expect(page.getByText("No hay filas cuantificadas")).toBeVisible();
  await page.getByRole("button", { name: "Tablas de origen", exact: true }).click();
  await page.getByLabel("Decimal en texto").selectOption(",");
  await page.getByRole("button", { name: "Calcular y guardar" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Cuantificación guardada",
  );
  await page.getByRole("button", { name: "Ver detalle del proyecto" }).click();
  await expect(page.getByRole("button", { name: "Detalle", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("cell", { name: "12,5", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Programación", exact: true }).click();
  await page.getByRole("button", { name: "Actividad", exact: true }).click();
  await page.getByLabel("Nombre de la actividad").fill("Hormigonar pilotes");
  await page.getByLabel("Código EDT").fill("1.1");
  await page.getByLabel("Fase 1").fill("Cimentación");
  await page.getByLabel("Origen de la duración").selectOption({ index: 1 });
  await page.getByLabel("Rendimiento").fill("5");
  await page.getByRole("button", { name: "Guardar actividad" }).click();
  await expect(page.getByText("1 · Cimentación")).toBeVisible();
  await expect(page.getByRole("cell", { name: "15 m³" })).toBeVisible();
  await page.getByRole("button", { name: "Reportes", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Generar Excel" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Ensayo sintético de pilotes" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("proyecto.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Modo oscuro" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Menú" }).click();
  await page
    .getByRole("button", { name: "Cuantificación", exact: true })
    .click();
  await expect(page.getByText("15 m³", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Inventario sin volumen conserva la unidad de cada partida", async ({
  page,
}) => {
  const request = page.request;
  expect((await request.post("/api/auth/register", {data: {
    username: "inventario", password: "cuenta para pruebas"
  }})).status()).toBe(201);
  const created = await request.post("/api/projects", {
    data: { name: "Ensayo sintético de mediciones" },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const base = "/api/projects/" + id;
  const revision = async () => ({
    "If-Match": String(
      (await (await request.get(base)).json()).project.revision,
    ),
  });
  const sources = [
    {
      category: "Tuberías",
      csv: "Piso;Piezas;Largo;Peso\nN1;2 und;2,5 ml;0 kg\nN2;1;1 ml;3 kg",
      fields: { level: "Piso", count: "Piezas", length: "Largo", mass: "Peso" },
      units: { length: "m", mass: "kg" },
      category_field: "",
    },
    {
      category: "Superficies",
      csv: "Piso;Clase;Superficie\nN1;Losas;8\nN1;Muros;3\nN2;Muros;0",
      fields: { level: "Piso", area: "Superficie" },
      units: { area: "m²" },
      category_field: "Clase",
    },
  ];
  for (const { csv, ...mapping } of sources) {
    const response = await request.post(base + "/tables", {
      headers: await revision(),
      multipart: {
        file: {
          name: mapping.category + ".csv",
          mimeType: "text/csv",
          buffer: Buffer.from(csv),
        },
        options: "{}",
      },
    });
    expect(response.ok()).toBeTruthy();
    const source = await response.json();
    const saved = await request.put(
      base + "/tables/" + source.id + "/mapping",
      {
        headers: await revision(),
        data: {
          ...mapping,
          mode: "inventory",
          decimal: ",",
          direct_basis: "per_element",
        },
      },
    );
    expect(saved.ok()).toBeTruthy();
  }
  await page.goto("/");
  const card = page.getByRole("article", { name: "Cantidades de obra" });
  const picker = card.getByRole("combobox", { name: "Magnitud cuantificada" });
  await expect(picker.locator("option")).toHaveText([
    "Área · Losas (m²)",
    "Área · Muros (m²)",
    "Longitud (m lineales)",
    "Masa (kg)",
    "Conteo (ud)",
  ]);
  for (const [label, total] of [
    ["Área · Muros (m²)", "3 m²"],
    ["Longitud (m lineales)", "6 m lineales"],
    ["Conteo (ud)", "6 ud"],
    ["Masa (kg)", "3 kg"],
  ]) {
    await picker.selectOption({ label });
    await expect(card.locator("strong")).toHaveText(total);
  }
  const chart = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Distribución · Masa" }),
    });
  await expect(chart.getByText("0 kg", { exact: true })).toBeVisible();
  await chart.getByRole("button", { name: "Por categoría" }).click();
  await expect(chart.locator(".bars label")).toHaveText(/Tuberías\s*3 kg/);
  await card
    .getByRole("button", { name: "Ver cantidades consolidadas" })
    .click();
  const totals = page.getByLabel("Cantidades de la selección");
  await expect(totals.getByText("8 m²", { exact: true })).toBeVisible();
  await expect(totals.getByText("3 m²", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Nivel", exact: true }).selectOption("N1");
  await expect(totals.getByText("5 m lineales", { exact: true })).toBeVisible();
  await expect(totals.getByText("0 kg", { exact: true })).toBeVisible();
});

test("Importa un XLSX con portada y encabezado desplazado después de recuperar la conexión", async ({
  page,
}, info) => {
  const request = page.request;
  expect((await request.post("/api/auth/register", {data: {
    username: "mediciones", password: "cuenta para pruebas"
  }})).status()).toBe(201);
  const path = info.outputPath("Mediciones.xlsx");
  execFileSync(resolve("../.venv-web/Scripts/python.exe"), [
    "-c",
    [
      "from openpyxl import Workbook",
      "import sys",
      "book = Workbook()",
      "book.active.title = 'Portada'",
      "book.active.append(['Inventario de prueba'])",
      "sheet = book.create_sheet('Mediciones')",
      "for row in [['Column1','Column2'], ['Mediciones'], ['Base Level','Volume'], [], ['Sótano','0.34 m³']]: sheet.append(row)",
      "book.save(sys.argv[1])",
    ].join("\n"),
    path,
  ]);
  const project = await request.post("/api/projects", {
    data: { name: "Importación de Excel sintética" },
  });
  expect(project.ok()).toBeTruthy();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Importar tablas", exact: true })
    .click();
  await page.route(
    "**/api/preview",
    (route) => route.abort("connectionrefused"),
    { times: 1 },
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByLabel("Seleccionar archivos").click();
  await (await chooser).setFiles(path);
  await expect(page.getByRole("alert")).toContainText("No se pudo conectar");
  await page.getByRole("button", { name: "Reintentar lectura" }).click();
  await page
    .getByRole("combobox", { name: "Hoja", exact: true })
    .selectOption("Mediciones");
  await expect(
    page.getByRole("spinbutton", { name: "Fila de encabezados" }),
  ).toHaveValue("3");
  await expect(
    page.getByRole("cell", { name: "Sótano", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Guardar tabla", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Tabla activa" }),
  ).toContainText("Mediciones.xlsx");
  await expect(page.getByLabel("Nivel", { exact: true })).toHaveValue(
    "Base Level",
  );
  await expect(page.getByLabel("Volumen", { exact: true })).toHaveValue(
    "Volume",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Tablas de origen", exact: true })
    .click();
  await page.getByText("Revisar filas de origen", { exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Sótano", exact: true }),
  ).toBeVisible();
  const remove = page.getByRole("button", { name: "Borrar tabla", exact: true });
  const dialog = page.getByRole("dialog");
  await remove.click();
  await expect(dialog).toContainText("Mediciones.xlsx · Mediciones");
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByLabel("Tabla activa")).toBeVisible();
  await remove.click();
  await dialog.getByRole("button", { name: "Mover a la papelera" }).click();
  await expect(page.getByText("La biblioteca está vacía")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Tablas de origen", exact: true }).click();
  await page.getByRole("button", { name: /Papelera de tablas/ }).click();
  await expect(dialog).toContainText("Mediciones.xlsx · Mediciones");
  await dialog.getByRole("button", { name: "Restaurar" }).click();
  await expect(page.getByLabel("Tabla activa")).toContainText("Mediciones.xlsx");
  await page.getByText("Revisar filas de origen", { exact: true }).click();
  await expect(page.getByRole("cell", { name: "Sótano", exact: true })).toBeVisible();
});
