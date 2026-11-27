import { test, expect } from "@playwright/test";

test("El espacio de trabajo se adapta y permite elegir el contenido del reporte", async ({
  page,
}, info) => {
  const request = page.request;
  await request.post("/api/auth/register", {
    data: { username: "visual", password: "cuenta de ensayo visual" },
  });
  const { id } = await (
    await request.post("/api/projects", {
      data: { name: "Prueba de interfaz" },
    })
  ).json();
  const base = "/api/projects/" + id;
  const revision = async () => ({
    "If-Match": String(
      (await (await request.get(base)).json()).project.revision,
    ),
  });
  const source = await request.post(base + "/tables", {
    headers: await revision(),
    multipart: {
      file: {
        name: "Columnas.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("Nivel;Volumen\nP1;2\nP2;3\nGrand total;5"),
      },
      options: "{}",
    },
  });
  const sid = (await source.json()).id;
  await request.put(base + "/tables/" + sid + "/mapping", {
    headers: await revision(),
    data: {
      category: "Columnas",
      mode: "direct",
      decimal: ",",
      direct_basis: "row_total",
      fields: { level: "Nivel", volume: "Volumen" },
      units: { volume: "m³" },
    },
  });
  const otherSource = await request.post(base + "/tables", {
    headers: await revision(),
    multipart: {
      file: {
        name: "Vigas.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("Nivel;Volumen\nP3;10\nGrand total;10"),
      },
      options: "{}",
    },
  });
  const otherId = (await otherSource.json()).id;
  await request.put(base + "/tables/" + otherId + "/mapping", {
    headers: await revision(),
    data: {
      category: "Vigas",
      mode: "direct",
      decimal: ",",
      direct_basis: "row_total",
      fields: { level: "Nivel", volume: "Volumen" },
      units: { volume: "m³" },
    },
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Proporciones", exact: true }).click();
  await expect(page.locator(".shares-list")).toContainText("66,7 %");
  await expect(page.locator(".shares-bar")).toHaveAttribute(
    "aria-label",
    /66,7 %/,
  );
  await page.getByRole("button", { name: "Tabla", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "P1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cuantificación", exact: true })
    .click();
  await page.getByLabel("Tabla para analizar").selectOption(String(sid));
  await page.getByRole("button", { name: "Detalle", exact: true }).click();
  for (const name of [
    "Área (m²)",
    "ID",
    "Material",
    "Familia",
    "Resistencia",
  ]) {
    await expect(
      page.getByRole("columnheader", { name, exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .getByLabel("Buscar por campo")
        .getByRole("option", { name, exact: true }),
    ).toHaveCount(0);
  }
  await expect(
    page.getByRole("columnheader", { name: "Volumen (m³)", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "P3", exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Resumen", exact: true })
    .last()
    .click();
  for (const width of [2560, 1366, 390]) {
    await page.setViewportSize({ width, height: 960 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width === 2560)
      expect(
        (await page.locator(".content").boundingBox())!.width,
      ).toBeGreaterThan(2000);
    await page.screenshot({
      path: info.outputPath("cantidades-" + width + ".png"),
    });
  }
  await page.setViewportSize({ width: 1366, height: 960 });
  await page.getByRole("button", { name: "Filas por revisar · 1" }).click();
  await expect(
    page.getByRole("cell", { name: "Total omitido", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Archivar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pendientes · 0" }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Cuantificación", exact: true })
    .click();
  await page.getByRole("button", { name: "Filas por revisar · 1" }).click();
  await expect(
    page.getByRole("cell", { name: "Vigas.csv", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Historial · 1" }).click();
  await expect(
    page.getByRole("cell", { name: "Columnas.csv", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Volver a pendientes" }).click();
  await expect(
    page.getByRole("button", { name: "Pendientes · 2" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reportes", exact: true }).click();
  await page.getByLabel("Vigas.csv", { exact: true }).uncheck();
  await page.getByLabel("Resumen por nivel", { exact: true }).uncheck();
  const response = page.waitForRequest(
    (r) => r.url().endsWith("/reports") && r.method() === "POST",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Generar Excel" }).click();
  expect((await response).postDataJSON()).toEqual({
    sections: ["Detalle"],
    tables: [sid],
  });
  await download;
  await page.getByRole("button", { name: "Programación", exact: true }).click();
  await page
    .getByRole("button", { name: "Calendario y seguimiento", exact: true })
    .click();
  await page.getByLabel("Nuevo festivo").fill("2026-12-25");
  await page
    .getByRole("button", { name: "Añadir festivo", exact: true })
    .click();
  await expect(page.getByLabel("Quitar festivo 2026-12-25")).toContainText(
    "dic",
  );
  await page.screenshot({ path: info.outputPath("calendario.png") });
});
