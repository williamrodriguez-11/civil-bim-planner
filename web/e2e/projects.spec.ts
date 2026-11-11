import { test, expect } from "@playwright/test";

test("Borrar y restaurar proyectos desde la papelera", async ({
  page,
}) => {
  const request = page.request;
  expect((await request.post("/api/auth/register", {data: {
    username: "papelera", password: "cuenta para pruebas"
  }})).status()).toBe(201);
  const first = "Proyecto de prueba A";
  const second = "Proyecto de prueba B";
  for (const name of [first, second]) {
    const created = await request.post("/api/projects", { data: { name } });
    expect(created.ok()).toBeTruthy();
  }

  await page.goto("/");
  const projects = page.getByRole("button", { name: "Proyectos", exact: true });
  const picker = page.getByLabel("Proyecto activo");
  const card = (name: string) =>
    page.locator(".project-list section").filter({
      has: page.getByRole("heading", { name, exact: true }),
    });
  const dialog = page.getByRole("dialog");
  async function moveToTrash(name: string) {
    await card(name).getByRole("button", { name: "Borrar proyecto" }).click();
    await expect(dialog).toContainText(name);
    await dialog.getByRole("button", { name: "Mover a la papelera" }).click();
    await expect(card(name)).toHaveCount(0);
  }

  await projects.click();
  await card(first).getByRole("button", { name: "Borrar proyecto" }).click();
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(card(first)).toBeVisible();
  await moveToTrash(first);
  await expect(picker.locator("option:checked")).toHaveText(second);
  await page.getByRole("button", { name: "Papelera", exact: true }).click();
  await card(first).getByRole("button", { name: "Restaurar" }).click();
  await page.getByRole("button", { name: "Volver a proyectos" }).click();
  await expect(card(first)).toBeVisible();
  await moveToTrash(second);
  await expect(picker.locator("option:checked")).toHaveText(first);
  await moveToTrash(first);
  await expect(picker).toHaveCount(0);
  await expect(page.getByText("Crea tu primer proyecto")).toBeVisible();
  await page.reload();
  await projects.click();
  await page.getByRole("button", { name: "Papelera", exact: true }).click();
  await expect(card(first)).toBeVisible();
  await expect(card(second)).toBeVisible();
  await card(first).getByRole("button", { name: "Restaurar" }).click();
  await expect(picker.locator("option:checked")).toHaveText(first);
  await page.getByRole("button", { name: "Volver a proyectos" }).click();
  await moveToTrash(first);
});
