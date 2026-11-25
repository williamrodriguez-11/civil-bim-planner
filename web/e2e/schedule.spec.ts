import { test, expect } from "@playwright/test";

test("Programa dependencias y compara el progreso a una fecha de seguimiento", async ({
  page,
}, info) => {
  const request = page.request;
  expect(
    (
      await request.post("/api/auth/register", {
        data: { username: "cronograma", password: "prueba de calendario" },
      })
    ).status(),
  ).toBe(201);
  const { id } = await (
    await request.post("/api/projects", { data: { name: "Obra de prueba" } })
  ).json();
  const base = `/api/projects/${id}`;
  const state = await (await request.get(base)).json();
  expect(
    (
      await request.put(base + "/plan", {
        headers: { "If-Match": String(state.project.revision) },
        data: {
          ...state.plan,
          start: "2026-11-02",
          holidays: ["2026-11-04"],
          status_date: "2026-11-03",
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto("/");
  await page.getByRole("button", { name: "Programación", exact: true }).click();
  await page.getByRole("button", { name: "Actividad", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Nombre de la actividad").fill("Excavación");
  await modal.getByLabel("Código EDT").fill("1.1");
  await modal.getByLabel("Fase 1").fill("Cimentación");
  await modal.getByLabel("Duración (días laborables)").fill("4");
  await expect(
    modal.getByText(/Registra el avance observado en obra/),
  ).toBeVisible();
  await modal.getByRole("button", { name: "25%", exact: true }).click();
  await page.screenshot({ path: info.outputPath("actividad.png") });
  await modal.getByRole("button", { name: "Guardar actividad" }).click();
  await expect(modal).not.toBeVisible();
  await page.getByRole("button", { name: "Actividad", exact: true }).click();
  await modal.getByLabel("Nombre de la actividad").fill("Fundir zapatas");
  await modal.getByLabel("Código EDT").fill("1.2");
  await modal.getByLabel("Duración (días laborables)").fill("2");
  await modal.getByRole("button", { name: "Añadir predecesora" }).click();
  await expect(modal.getByLabel("Relación")).toHaveValue("FS");
  await expect(
    modal.getByText(/comienza después de que termina la predecesora/),
  ).toBeVisible();
  await modal.getByLabel("Desfase (días laborables)").fill("1");
  await modal.getByRole("button", { name: "Guardar actividad" }).click();
  await expect(modal).not.toBeVisible();
  const row = page
    .getByRole("row")
    .filter({
      has: page.getByRole("button", { name: "Excavación", exact: true }),
    });
  await expect(row).toContainText("25 %");
  await expect(row).toContainText("50 %");
  await expect(row).toContainText("Por debajo de lo previsto");
  const saved = await (await request.get(base)).json();
  expect(saved.schedule[1].start).toBe("2026-11-10");
  expect(saved.schedule[1].finish).toBe("2026-11-11");
  await page
    .getByRole("button", { name: "Calendario y seguimiento", exact: true })
    .click();
  await modal.getByLabel("Fecha de seguimiento (opcional)").fill("2026-11-08");
  await modal.getByRole("button", { name: "Guardar calendario" }).click();
  await expect(modal).not.toBeVisible();
  await expect(row).toContainText("100 %");
  await expect(row).toContainText("25 %");
  await page.reload();
  await page.getByRole("button", { name: "Programación", exact: true }).click();
  await expect(row).toContainText("100 %");
  await page.screenshot({
    path: info.outputPath("cronograma.png"),
    fullPage: true,
  });
  await page.getByLabel("Buscar actividad").fill("zapatas");
  await expect(
    page.getByRole("button", { name: "Excavación", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Fundir zapatas", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Buscar actividad").fill("no existe");
  await expect(
    page.getByText("No hay actividades que coincidan con los filtros."),
  ).toBeVisible();
  await page.getByLabel("Buscar actividad").fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: info.outputPath("cronograma-movil.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Excavación", exact: true }).click();
  await expect(modal.getByLabel("% completado", { exact: true })).toHaveValue(
    "25",
  );
  expect(
    await modal.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  await page.screenshot({ path: info.outputPath("actividad-movil.png") });
});
