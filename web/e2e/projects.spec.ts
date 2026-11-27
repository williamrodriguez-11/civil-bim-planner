import { test, expect } from "@playwright/test";

test("Borrar y restaurar proyectos desde la papelera", async ({ page }) => {
  const request = page.request;
  expect(
    (
      await request.post("/api/auth/register", {
        data: {
          username: "papelera",
          password: "cuenta para pruebas",
        },
      })
    ).status(),
  ).toBe(201);
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
  const trash = page.getByRole("button", { name: "Papelera", exact: true });
  const trashRow = (name: string) =>
    page.locator(".trash-row").filter({ hasText: name });
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
  await trash.click();
  await trashRow(first).getByRole("button", { name: "Restaurar" }).click();
  await projects.click();
  await expect(card(first)).toBeVisible();
  await moveToTrash(second);
  await expect(picker.locator("option:checked")).toHaveText(first);
  await moveToTrash(first);
  await expect(picker).toHaveCount(0);
  await expect(page.getByText("Crea tu primer proyecto")).toBeVisible();
  await page.reload();
  await trash.click();
  await expect(trashRow(first)).toBeVisible();
  await expect(trashRow(second)).toBeVisible();
  await trashRow(first).getByRole("button", { name: "Restaurar" }).click();
  await expect(picker.locator("option:checked")).toHaveText(first);
  await projects.click();
  await moveToTrash(first);
  // Permanent deletion asks for confirmation and empties the trash.
  await trash.click();
  await page.getByRole("button", { name: "Vaciar proyectos" }).click();
  await dialog
    .getByRole("button", { name: "Eliminar definitivamente" })
    .click();
  await expect(page.getByText("No hay proyectos en la papelera")).toBeVisible();
});
