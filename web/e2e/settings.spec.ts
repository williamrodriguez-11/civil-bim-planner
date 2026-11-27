import { expect, test } from "@playwright/test";

test("Configuración: cambiar la contraseña con requisitos a la vista", async ({
  page,
}) => {
  await page.request.post("/api/auth/register", {
    data: { username: "ajustes", password: "frase de prueba larga" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Configuración" }).click();
  await expect(page.getByRole("heading", { name: "Tu cuenta" })).toBeVisible();
  await expect(page.getByText("Usuario y contraseña")).toBeVisible();

  const save = page.getByRole("button", { name: "Guardar contraseña" });
  await page.locator("#current-password").fill("frase de prueba larga");
  const fresh = page.locator("#new-password");
  await fresh.fill("corta");
  const rules = page.getByRole("list", {
    name: "La nueva contraseña debe tener",
  });
  await expect(rules.locator("li.ok")).toHaveCount(2); // minúscula y usuario
  await expect(page.getByText("Seguridad:")).toContainText("Muy débil");
  await expect(save).toBeDisabled();

  await fresh.fill("Obra-Segura-2026");
  await expect(rules.locator("li:not(.ok)")).toHaveCount(0);
  await expect(page.getByText("Seguridad:")).toContainText("Fuerte");
  await page.locator("#repeat-password").fill("Obra-Segura-202");
  await expect(page.getByText("Las contraseñas no coinciden.")).toBeVisible();
  await expect(save).toBeDisabled();
  await page.locator("#repeat-password").fill("Obra-Segura-2026");
  await expect(page.getByText("Las contraseñas coinciden.")).toBeVisible();

  await page.getByRole("button", { name: "Mostrar nueva contraseña" }).click();
  await expect(fresh).toHaveAttribute("type", "text");

  await save.click();
  await expect(page.getByText("Contraseña actualizada.")).toBeVisible();
  await expect(page.locator("#current-password")).toHaveValue("");

  const login = await page.request.post("/api/auth/login", {
    data: { username: "ajustes", password: "Obra-Segura-2026" },
  });
  expect(login.status()).toBe(200);
});

test("Configuración: avisa si la contraseña actual no es correcta", async ({
  page,
}) => {
  await page.request.post("/api/auth/register", {
    data: { username: "ajustes-error", password: "frase de prueba larga" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Configuración" }).click();
  await page.locator("#current-password").fill("no es esta");
  await page.locator("#new-password").fill("Obra-Segura-2026");
  await page.locator("#repeat-password").fill("Obra-Segura-2026");
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "La contraseña actual no es correcta.",
  );
  // Still signed in.
  await expect(page.getByRole("heading", { name: "Tu cuenta" })).toBeVisible();
});
