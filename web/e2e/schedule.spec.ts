import { test, expect, type Page } from "@playwright/test";

const rowOf = (page: Page, name: string) =>
  page.locator(".planner-row", { has: page.locator(`input[value="${name}"]`) });
const startOf = (page: Page, name: string) =>
  rowOf(page, name).locator(".date").first();

test("Arma un cronograma desde cero: pegar, fases, encadenar, hito, recalcular, guardar y exportar", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  expect(
    (
      await page.request.post("/api/auth/register", {
        data: { username: "cronograma", password: "prueba de calendario" },
      })
    ).status(),
  ).toBe(201);
  await page.request.post("/api/projects", {
    data: { name: "Edificio Norte" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Programación", exact: true }).click();

  // 1. Project start, then five activities pasted from Excel.
  await page.getByLabel("Inicio del proyecto").fill("2026-11-02");
  const first = page.getByLabel("Primera actividad");
  await first.focus();
  await first.evaluate((el) => {
    const data = new DataTransfer();
    data.setData(
      "text/plain",
      "Actividad\tDuración\nExcavación\t3\nZapatas\t4\nColumnas\t5\nVigas\t4\nLosa\t3\n",
    );
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.locator('input[data-field="name"]')).toHaveCount(5);
  await expect(page.getByText("Se pegaron 5 actividades.")).toBeVisible();

  // 2. Two phases.
  const pick = (name: string) => page.getByLabel(`Seleccionar ${name}`).click();
  const phase = async (name: string, members: string[]) => {
    for (const m of members) await pick(m);
    await page.getByRole("button", { name: "Agrupar en fase" }).click();
    await page.getByLabel("Nombre de la nueva fase").fill(name);
    await page.getByRole("button", { name: "Crear fase" }).click();
  };
  await phase("Cimentación", ["Excavación", "Zapatas"]);
  await phase("Estructura", ["Columnas", "Vigas", "Losa"]);
  await expect(page.getByLabel("Nombre de la fase 1")).toHaveValue(
    "Cimentación",
  );
  await expect(page.getByLabel("Nombre de la fase 2")).toHaveValue(
    "Estructura",
  );

  // 3. Chain the five activities in order with one click.
  for (const m of ["Excavación", "Zapatas", "Columnas", "Vigas", "Losa"])
    await pick(m);
  await page.getByRole("button", { name: "Encadenar" }).click();
  await expect(rowOf(page, "Zapatas")).toContainText("Empieza cuando termine");
  await expect(rowOf(page, "Zapatas")).toContainText("FC");

  // 4. A delivery milestone after the slab, linked by searching its name.
  await page.getByRole("button", { name: "Hito", exact: true }).click();
  const milestone = page.locator('input[data-field="name"]').last();
  await milestone.fill("Entrega de obra");
  await page
    .getByLabel("Buscar predecesora de Entrega de obra")
    .fill("2.3 · Losa");
  await expect(startOf(page, "Losa")).toHaveText("24 nov");
  await expect(startOf(page, "Entrega de obra")).toHaveText("26 nov");
  await expect(
    rowOf(page, "Entrega de obra").locator(".milestone"),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("cronograma.png") });

  // 5. Longer footings: successors move by working days, skipping weekends.
  const bar = rowOf(page, "Losa").locator(".bar");
  const before = await bar.evaluate((e) => parseFloat(e.style.left));
  await page.getByLabel("Duración en días laborables de Zapatas").fill("6");
  await expect(startOf(page, "Columnas")).toHaveText("13 nov");
  await expect(startOf(page, "Losa")).toHaveText("26 nov");
  await expect(startOf(page, "Entrega de obra")).toHaveText("30 nov");
  expect(await bar.evaluate((e) => parseFloat(e.style.left))).toBeGreaterThan(
    before,
  );
  await expect(page.getByLabel("Nombre de la fase 2")).toBeVisible();
  await expect(rowOf(page, "Estructura").first()).toBeDefined();

  // The detail explains the date: predecessor and the weekend in between.
  await rowOf(page, "Columnas").locator(".bar").click();
  const why = page.locator(".details-why");
  await expect(why).toContainText("Empieza cuando termine «Zapatas» (FC)");
  await expect(why).toContainText("sábado");

  // Errors appear on the cell: a circular dependency names its activities.
  await page
    .getByLabel("Buscar predecesora de Excavación")
    .fill("2.4 · Entrega de obra");
  await expect(page.getByRole("alert")).toContainText("Dependencia circular");
  await expect(
    page.getByLabel("Buscar predecesora de Excavación"),
  ).toHaveAttribute("aria-invalid", "true");
  await rowOf(page, "Excavación")
    .getByRole("button", { name: "Quitar predecesora Entrega de obra" })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // 6. Save, reload and export.
  await page.getByRole("button", { name: "Guardar cronograma" }).click();
  await expect(page.getByText("Cronograma guardado.")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Programación", exact: true }).click();
  await expect(startOf(page, "Entrega de obra")).toHaveText("30 nov");
  await expect(page.getByLabel("Nombre de la fase 1")).toHaveValue(
    "Cimentación",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Exportar XML" }).click();
  const xml = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of xml!) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  expect(text).toContain("<Name>Entrega de obra</Name>");
  expect(text).toContain("<Milestone>1</Milestone>");
  expect(text).toContain("<Name>Estructura</Name>");
  expect(errors).toEqual([]);
});

test("Enter añade filas, Tab pasa de celda y el seguimiento compara el avance", async ({
  page,
}) => {
  await page.request.post("/api/auth/register", {
    data: { username: "teclado", password: "prueba de calendario" },
  });
  const { id } = await (
    await page.request.post("/api/projects", { data: { name: "Obra" } })
  ).json();
  await page.goto("/");
  await page.getByRole("button", { name: "Programación", exact: true }).click();
  await page.getByLabel("Inicio del proyecto").fill("2026-11-02");
  await page.getByLabel("Primera actividad").fill("Replanteo");
  await page.keyboard.press("Tab");
  await page.keyboard.type("2");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Instalaciones");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  await expect(page.locator('input[data-field="name"]')).toHaveCount(3);
  await expect(
    page.getByLabel("Duración en días laborables de Instalaciones"),
  ).toHaveValue("3");
  // A duration that is not a whole number is flagged on its cell.
  await page.getByLabel("Duración en días laborables de Replanteo").fill("dos");
  await expect(
    page.getByLabel("Duración en días laborables de Replanteo"),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("button", { name: "Guardar cronograma" }),
  ).toBeDisabled();
  await page.getByLabel("Duración en días laborables de Replanteo").fill("2");
  // The detail panel explains the activity in plain blocks.
  await page.getByLabel("Nombre de la actividad 1", { exact: true }).focus();
  const details = page.locator(".planner-details");
  await expect(details).toContainText("Resumen");
  await expect(details).toContainText("¿De qué depende?");
  await expect(details).toContainText("No depende de ninguna");
  await expect(details.getByLabel("% completado")).toHaveCount(0);
  await page.getByRole("button", { name: "Calendario y seguimiento" }).click();
  await page.getByLabel("Fecha de seguimiento (opcional)").fill("2026-11-02");
  await page.getByRole("button", { name: "Aplicar al cronograma" }).click();
  await page.getByRole("button", { name: "Guardar cronograma" }).click();
  await expect(page.getByText("Cronograma guardado.")).toBeVisible();
  const saved = await (await page.request.get(`/api/projects/${id}`)).json();
  expect(saved.plan.tasks.map((t: { name: string }) => t.name)).toEqual([
    "Replanteo",
    "Instalaciones",
  ]);
  expect(saved.plan.status_date).toBe("2026-11-02");
  expect(saved.schedule[0].planned).toBe(50);
  // Clearing a saved activity's name is an error, not a silent delete.
  const name = page.getByLabel("Nombre de la actividad 1", { exact: true });
  await name.fill("");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("button", { name: "Guardar cronograma" }),
  ).toBeDisabled();
  await name.fill("Replanteo");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
});

test("Como en Project: fechas en la tabla, predecesoras por número y enlazar arrastrando", async ({
  page,
}) => {
  await page.request.post("/api/auth/register", {
    data: { username: "como-project", password: "prueba de calendario" },
  });
  await page.request.post("/api/projects", { data: { name: "Obra" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Programación", exact: true }).click();
  await page.getByLabel("Inicio del proyecto").fill("2026-11-02");
  await page.getByLabel("Primera actividad").fill("Desmonte y limpieza");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Zapatas");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Columnas");
  const date = (field: "Inicio" | "Fin", name: string) =>
    page.getByRole("button", { name: new RegExp(`^${field} de ${name}:`) });

  // Typing a finish changes the duration (working days, weekend skipped).
  await date("Fin", "Desmonte y limpieza").click();
  await page.getByLabel("Fin de Desmonte y limpieza").fill("2026-11-10");
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("Duración en días laborables de Desmonte y limpieza"),
  ).toHaveValue("7");

  // Typing a start sets «no empezar antes de» that date.
  await date("Inicio", "Columnas").click();
  await page.getByLabel("Inicio de Columnas").fill("2026-11-18");
  await page.keyboard.press("Enter");
  await expect(date("Inicio", "Columnas")).toHaveText("18 nov");

  // Predecessor typed by number, with a lag, as in Project.
  const preds = page.getByLabel("Buscar predecesora de Zapatas");
  await preds.fill("1+2");
  await preds.press("Enter");
  await expect(date("Inicio", "Zapatas")).toHaveText("13 nov");
  const row = page.locator(".planner-row", {
    has: page.locator('input[value="Zapatas"]'),
  });
  await expect(row).toContainText("Empieza cuando termine (+2 d)");
  // An unknown number is reported on the cell.
  const own = page.getByLabel("Buscar predecesora de Columnas");
  await own.fill("9");
  await own.press("Enter");
  await expect(own).toHaveAttribute("aria-invalid", "true");
  // The red cell can be cleared with its button.
  await page
    .getByRole("button", { name: "Borrar la predecesora escrita en Columnas" })
    .click();
  await expect(own).toHaveValue("");
  await expect(own).not.toHaveAttribute("aria-invalid", "true");

  // Drag from the «Zapatas» bar onto the «Columnas» row to link them.
  const from = row.locator(".bar");
  const to = page
    .locator(".planner-row", { has: page.locator('input[value="Columnas"]') })
    .locator(".planner-track");
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width - 3, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByText("«Columnas» empezará cuando termine «Zapatas»."),
  ).toBeVisible();
  await expect(date("Inicio", "Columnas")).toHaveText("18 nov");

  // Both fixed dates set: the panel offers to fit the duration to them.
  await page.getByLabel("Nombre de la actividad 1", { exact: true }).focus();
  await page.getByLabel("No empezar antes del").fill("2026-11-16");
  await page.getByLabel("Terminar exactamente el").fill("2026-11-19");
  await page.getByRole("button", { name: /Que dure del/ }).click();
  await expect(
    page.getByLabel("Duración en días laborables de Desmonte y limpieza"),
  ).toHaveValue("4");
  await expect(date("Inicio", "Desmonte y limpieza")).toHaveText("16 nov");

  // A start earlier than its predecessor allows is explained, with a way out.
  await expect(date("Inicio", "Zapatas")).toHaveText("24 nov");
  await date("Inicio", "Zapatas").click();
  await page.getByLabel("Inicio de Zapatas").fill("2026-11-20");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      /«Zapatas» no puede empezar el .*20 de nov porque depende de «Desmonte y limpieza»/,
    ),
  ).toBeVisible();
  await expect(date("Inicio", "Zapatas")).toHaveText("24 nov");
  await page.getByRole("button", { name: /Quitar el vínculo con/ }).click();
  await expect(date("Inicio", "Zapatas")).toHaveText("20 nov");
});
