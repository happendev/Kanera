import { contextDefaults } from "./support/env";
import { expect, test } from "./support/fixtures";

// The interface language loads before the app boots (apps/web/src/app/core/i18n/locale.ts), so
// every switch is a full reload. These tests cover the parts unit tests can't reach: the reload
// itself, the account copy following the person to a fresh device, and the API answering in the
// language on screen.

for (const language of [
  { locale: "zh-CN", name: "简体中文", signIn: "登录", heading: "语言", shortcut: "快速记录", days: /星期[一二三四五六日天]|周[一二三四五六日天]/ },
  { locale: "zh-TW", name: "繁體中文", signIn: "登入", heading: "語言", shortcut: "快速記錄", days: /星期[一二三四五六日天]|週[一二三四五六日天]/ },
  { locale: "nl", name: "Nederlands", signIn: "Inloggen", heading: "Taal", shortcut: "Snel vastleggen", days: /maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag/i },
  { locale: "nb", name: "Norsk (bokmål)", signIn: "Logg inn", heading: "Språk", shortcut: "Hurtigregistrering", days: /mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag/i },
]) {
  for (const width of [1280, 390]) {
    test(`${language.locale} sign-in and installed-app copy at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/login");
      await page.getByRole("button", { name: "Language" }).click();
      await page.getByRole("menuitemradio", { name: language.name }).click();
      await expect(page.getByRole("button", { name: language.signIn, exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", language.locale);
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", `/assets/favicon/manifest.${language.locale}.json`);
      const manifest = await page.request.get(`/assets/favicon/manifest.${language.locale}.json`);
      expect((await manifest.json() as { shortcuts: { name: string }[] }).shortcuts[0]?.name).toBe(language.shortcut);
      await page.reload();
      await expect(page.getByRole("button", { name: language.signIn, exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${language.locale}-${width}.png`), fullPage: true });
    });
  }

  test(`${language.locale} account language persists and formats dates and API errors`, async ({ page, browser, signIn, apiAs }, testInfo) => {
    const api = await apiAs("priya");
    const previous = await (await api.get("/api/me")).json() as { locale: string | null };
    try {
      await api.patch("/api/auth/me", { data: { locale: "en-GB" } });
      await signIn(page, "priya");
      await page.goto("/settings/profile");
      await page.getByRole("button", { name: "Language" }).click();
      await page.getByRole("menuitemradio", { name: language.name }).click();
      await expect(page.getByRole("heading", { name: language.heading })).toBeVisible();
      expect((await (await api.get("/api/me")).json() as { locale: string }).locale).toBe(language.locale);
      await page.screenshot({ path: testInfo.outputPath(`${language.locale}-profile.png`), fullPage: true });
      const fresh = await browser.newContext(contextDefaults);
      try {
        const other = await fresh.newPage();
        await signIn(other, "priya");
        await expect(other.locator("html")).toHaveAttribute("lang", language.locale);
        await expect(other.locator("k-page-header")).toContainText(language.days);
      } finally {
        await fresh.close();
      }
      const missing = await api.get("/api/boards/00000000-0000-7000-8000-000000000000", { headers: { "Accept-Language": language.locale } });
      expect(missing.ok()).toBe(false);
      expect((await missing.json() as { message: string }).message).not.toBe("board not found");
    } finally {
      await api.patch("/api/auth/me", { data: { locale: previous.locale ?? "en-GB" } });
    }
  });
}

test("a signed-out visitor can switch the sign-in page to another language", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  await page.getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitemradio", { name: /Español/ }).click();

  await expect(page.getByRole("button", { name: "Iniciar sesión" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/assets/favicon/manifest.es.json");
  const manifest = await page.request.get("/assets/favicon/manifest.es.json");
  expect((await manifest.json() as { shortcuts: { name: string }[] }).shortcuts[0]?.name).toBe("Captura rápida");
  // The choice is kept on the device, so the next visit starts in Spanish too.
  await page.reload();
  await expect(page.getByRole("button", { name: "Iniciar sesión" })).toBeVisible();
});

test("the account language follows the person to a new device, with dates and API errors in it", async ({ page, browser, signIn, apiAs }) => {
  const priya = await apiAs("priya");
  try {
    await signIn(page, "priya");
    await page.goto("/settings/profile");
    await page.getByRole("button", { name: "Language" }).click();
    await page.getByRole("menuitemradio", { name: /Deutsch/ }).click();

    // Saved to the account, then reloaded into German.
    await expect(page.getByRole("heading", { name: "Sprache" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    const me = await priya.get("/api/me");
    expect(((await me.json()) as { locale: string | null }).locale).toBe("de");

    // A fresh browser that has never seen German (en-GB) still lands in German after sign-in.
    const fresh = await browser.newContext(contextDefaults);
    try {
      const other = await fresh.newPage();
      await signIn(other, "priya");
      await expect(other.locator("html")).toHaveAttribute("lang", "de");
      await expect(other).toHaveTitle(/Start · Kanera/);
      // Dates follow the language, not the browser: German weekday and month names.
      await expect(other.locator("k-page-header")).toContainText(/Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag/);
    } finally {
      await fresh.close();
    }

    // The API writes user-facing errors in the language the web app sends.
    const missing = await priya.get("/api/boards/00000000-0000-7000-8000-000000000000", { headers: { "Accept-Language": "de" } });
    expect(missing.ok()).toBe(false);
    expect(((await missing.json()) as { message: string }).message).not.toMatch(/^[a-z ]+$/);
  } finally {
    // Seed users are shared across the suite; put Priya back in the source language.
    await priya.patch("/api/auth/me", { data: { locale: "en-GB" } });
  }
});

test("chat language persists independently of the viewer and validation details are translated", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const previous = (await (await api.get("/api/me")).json()) as { locale: string | null };
  const created = await api.post("/api/workspaces", { data: { name: uniqueName("Localized integrations"), lists: [{ name: "Todo" }, { name: "Done" }] } });
  expect(created.ok()).toBe(true);
  const workspace = (await created.json()) as { id: string; name: string };
  try {
    // Keep the destination paused: this test exercises configuration, never sends to a real chat.
    const response = await api.post(`/api/workspaces/${workspace.id}/chat-destinations`, {
      headers: { "Accept-Language": "es" },
      data: { provider: "slack", name: "Equipo", enabled: false, eventTypes: ["card_created"], credentials: { webhookUrl: "https://hooks.slack.com/services/TEST/TEST/not-a-real-webhook" } },
    });
    expect(response.status()).toBe(201);
    const destination = (await response.json()) as { id: string; locale: string; connectionSummary: string };
    expect(destination.locale).toBe("es");
    expect(destination.connectionSummary).toBe("Webhook configurado");
    await api.patch("/api/auth/me", { data: { locale: "es" } });
    await signIn(page, "amelia");
    await page.goto(`/w/${workspace.id}/settings/integrations`);
    const card = page.locator(".chat-destination-card").filter({ hasText: "Equipo" });
    await expect(card).toContainText("Webhook configurado");
    await card.locator("button:has(.ti-pencil)").click();
    const editor = card.locator(".destination-editor");
    await editor.getByRole("combobox", { name: "Idioma de los mensajes" }).selectOption("ja");
    await expect.poll(async () => {
      const rows = (await (await api.get(`/api/workspaces/${workspace.id}/chat-destinations`)).json()) as { locale: string }[];
      return rows[0]?.locale;
    }).toBe("ja");
    // Schema length errors used to expose the untranslated Zod issue.message in this editor.
    const name = editor.locator("input").first();
    await name.fill("x".repeat(121));
    await name.blur();
    await expect(page.locator(".form-error")).toContainText("Demasiado grande");
    await name.fill("Equipo actualizado");
    await name.blur();
    await expect(page.locator(".form-error")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("chat-language-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.scrollIntoViewIfNeeded();
    await expect(editor.getByRole("combobox", { name: "Idioma de los mensajes" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("chat-language-phone.png"), fullPage: true });
    await page.reload();
    await card.locator("button:has(.ti-pencil)").click();
    await expect(card.getByRole("combobox", { name: "Idioma de los mensajes" })).toHaveValue("ja");
  } finally {
    await api.patch("/api/auth/me", { data: { locale: previous.locale } });
    await api.delete(`/api/workspaces/${workspace.id}`, { data: { confirmationName: workspace.name } });
  }
});

test("import warnings stay translated through the real import wizard", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const previous = (await (await api.get("/api/me")).json()) as { locale: string | null };
  const created = await api.post("/api/workspaces", { data: { name: uniqueName("Localized import"), lists: [{ name: "Todo" }, { name: "Done" }] } });
  expect(created.ok()).toBe(true);
  const workspace = (await created.json()) as { id: string; name: string };
  try {
    await api.patch("/api/auth/me", { data: { locale: "es" } });
    await signIn(page, "amelia");
    await page.goto(`/w/${workspace.id}/settings/import`);
    const wizard = page.locator("k-trello-import");
    await wizard.locator('input[type="file"]').setInputFiles({
      name: "trello.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ name: "Imported", lists: [{ id: "todo", name: "Todo" }], cards: [
        { id: "active", idList: "todo", name: "Keep me", closed: false },
        { id: "archived", idList: "todo", name: "Skip me", closed: true },
      ] })),
    });
    await wizard.locator('button[type="submit"]').click();
    await expect(wizard.locator(".wizard-actions")).toBeVisible();
    // Advance the mappings unchanged; user-provided board/list names remain user content.
    for (let step = 0; step < 8 && !(await wizard.locator(".import-action button").isVisible()); step += 1) {
      const heading = wizard.getByRole("heading", { level: 3 });
      const previousStep = await heading.innerText();
      await wizard.getByRole("button", { name: "Siguiente", exact: false }).click();
      await expect(heading).not.toHaveText(previousStep);
    }
    await wizard.locator(".import-action button").click();
    await expect(wizard.getByText("Tarjetas archivadas omitidas de forma predeterminada: 1.", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("import-warnings-es.png"), fullPage: true });
  } finally {
    await api.patch("/api/auth/me", { data: { locale: previous.locale } });
    await api.delete(`/api/workspaces/${workspace.id}`, { data: { confirmationName: workspace.name } });
  }
});
