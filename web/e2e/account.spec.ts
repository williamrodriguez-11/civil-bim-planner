import { expect, test } from "@playwright/test";

test("Correo y visibilidad de la contraseña en ambos formularios", async ({
  page,
}) => {
  await page.goto("/");
  const password = page.getByLabel("Contraseña", { exact: true });
  await password.fill("frase larga de prueba");
  await page.getByRole("button", { name: "Mostrar contraseña" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Crear una cuenta" }).click();
  await expect(password).toHaveAttribute("type", "password");
  await page
    .getByLabel("Nombre de usuario o correo electrónico")
    .fill("prueba@example.org");
  await password.fill("frase larga de prueba");
  await page.getByRole("button", { name: "Mostrar contraseña" }).click();
  await page.getByRole("button", { name: "Ocultar contraseña" }).click();
  await expect(password).toHaveValue("frase larga de prueba");
  await page.getByRole("button", { name: "Crear cuenta", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Resumen general" }),
  ).toBeVisible();
});
