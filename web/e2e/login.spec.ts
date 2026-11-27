import { expect, test, type Page } from "@playwright/test";

const user = { username: "acceso", password: "frase de acceso segura" };

async function register(page: Page) {
  const res = await page.request.post("/api/auth/register", { data: user });
  expect([201, 409]).toContain(res.status());
  await page.request.post("/api/auth/logout");
}

for (const [name, options] of [
  ["escritorio", { viewport: { width: 1440, height: 900 } }],
  ["móvil", { viewport: { width: 390, height: 844 }, hasTouch: true }],
] as const) {
  test(`Inicio de sesión en ${name}: error, teclado y acceso correcto`, async ({
    browser,
  }) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await register(page);
    // The form must not wait for the 3D scene.
    await page.route(/LoginScene-.*\.js$/, async (route) => {
      await new Promise((done) => setTimeout(done, 2000));
      await route.continue();
    });
    await page.goto("/");
    const username = page.getByLabel("Nombre de usuario o correo electrónico");
    const password = page.getByLabel("Contraseña", { exact: true });
    await expect(username).toBeEditable();
    await expect(page.locator(".login-scene.is-ready")).toHaveCount(0);
    await expect(username).toHaveAttribute("autocomplete", "username");
    await expect(password).toHaveAttribute("autocomplete", "current-password");

    // Keyboard only: user, password, show password, submit.
    await username.focus();
    await page.keyboard.type(user.username);
    await page.keyboard.press("Tab");
    await page.keyboard.type("clave equivocada");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(password).toHaveAttribute("type", "text");
    await page.keyboard.press("Enter");
    await expect(password).toHaveAttribute("type", "password");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText("incorrectos");
    await expect(username).toHaveValue(user.username);
    await expect(password).toBeFocused();

    await password.fill(user.password);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await expect(
      page.getByRole("heading", { name: "Resumen general" }),
    ).toBeVisible();
    await context.close();
  });
}

test("Movimiento reducido: imagen fija, sin Three.js y acceso inmediato", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await register(page);
  const scripts: string[] = [];
  page.on("request", (r) => scripts.push(r.url()));
  await page.goto("/");
  await expect(page.locator(".login-scene.is-still svg")).toBeVisible();
  await expect(page.locator(".login-scene canvas")).toHaveCount(0);
  await page
    .getByLabel("Nombre de usuario o correo electrónico")
    .fill(user.username);
  await page.getByLabel("Contraseña", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(
    page.getByRole("heading", { name: "Resumen general" }),
  ).toBeVisible();
  expect(scripts.some((url) => /LoginScene-/.test(url))).toBe(false);
  await context.close();
});
