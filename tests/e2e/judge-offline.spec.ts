import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { judgeFixture } from "../unit/judge/fixtures";

test("judge shell reopens offline, autosaves all speakers, queues once and recovers a receipt", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "judge", "Mobile judge project only");
  const bootstrap = judgeFixture();
  const requests: string[] = [];
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/api/judge/me") data = bootstrap;
    if (path === "/api/judge/sheets") {
      const body = route.request().postDataJSON();
      requests.push(body.requestId);
      bootstrap.assignments[0].current = {
        version: 1,
        payload: body.payload,
        receivedAt: new Date().toISOString(),
      };
      data = {
        status: "received",
        version: 1,
        receivedAt: bootstrap.assignments[0].current.receivedAt,
      };
    }
    await route.fulfill({
      json: { ok: true, data },
      headers: { "X-Dais": "1", "Cache-Control": "no-store" },
    });
  });
  await page.goto("/j/");
  await expect(page.getByRole("heading", { name: "Hello, Sample Judge" })).toBeVisible();
  await expect(page.getByText("Ready to work without signal", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  expect(violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual([]);
  await context.setOffline(true);
  // Unroute before reload: the browser must obtain its real HTML/chunks from the SW.
  await context.unroute("**/api/**");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Hello, Sample Judge" })).toBeVisible();
  await page.getByRole("button", { name: "Open round 1 sheet" }).click();
  await page.getByRole("button", { name: "Start scoring", exact: true }).click();
  await expect(page.locator("fieldset")).toHaveCount(4);
  for (const card of await page.locator("fieldset").all()) {
    await card.getByLabel("Argumentation", { exact: true }).fill("24");
    await card.getByLabel("Rebuttal", { exact: true }).fill("25");
    await card.getByLabel("Presentation", { exact: true }).fill("24");
    await card.getByRole("radio", { name: "3", exact: true }).click();
    await card.getByLabel(/^Overall score/).fill("78");
    await card.getByLabel("What went well", { exact: true }).fill("Saved without signal");
    await card.getByLabel("Even better if", { exact: true }).fill("Develop rebuttal");
  }
  await expect(page.getByText(/^Saved on this phone/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Open round 1 sheet" }).click();
  for (const card of await page.locator("fieldset").all())
    await expect(card.getByLabel(/^Overall score/)).toHaveValue("78");
  await page.getByRole("button", { name: "Review sheet", exact: true }).click();
  await page.getByRole("button", { name: "Save to send when connected", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Waiting to send", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Open round 1 sheet" }).click();
  await expect(page.getByRole("heading", { name: "Waiting to send", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keep aside this local copy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Copies kept aside", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Copies kept aside", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore round 1 · Room 1", exact: true }).click();
  await page.getByRole("button", { name: "Open round 1 sheet", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Waiting to send", exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/j/");
  await expect(other.getByRole("heading", { name: "Hello, Sample Judge" })).toBeVisible();
  await expect(other.getByText("Waiting to send", { exact: true })).toBeVisible();
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/api/judge/me") data = bootstrap;
    if (path === "/api/judge/sheets") {
      const body = route.request().postDataJSON();
      requests.push(body.requestId);
      bootstrap.assignments[0].current = {
        version: 1,
        payload: body.payload,
        receivedAt: new Date().toISOString(),
      };
      data = {
        status: "received",
        version: 1,
        receivedAt: bootstrap.assignments[0].current.receivedAt,
      };
    }
    await route.fulfill({
      json: { ok: true, data },
      headers: { "X-Dais": "1", "Cache-Control": "no-store" },
    });
  });
  await context.setOffline(false);
  await expect(
    page.getByRole("heading", { name: "Received by the tournament", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  expect(requests).toHaveLength(1);
  await other.close();
  await context.setOffline(true);
  await context.unroute("**/api/**");
  await page.reload();
  await page.getByRole("button", { name: "Open round 1 sheet" }).click();
  await expect(
    page.getByRole("heading", { name: "Received by the tournament", exact: true }),
  ).toBeVisible();
  const cached = await page.evaluate(async () =>
    (
      await Promise.all(
        (await caches.keys()).map(async (key) =>
          (await (await caches.open(key)).keys()).map((r) => new URL(r.url).pathname),
        ),
      )
    ).flat(),
  );
  expect(cached.some((path) => path.startsWith("/api/"))).toBe(false);
});

test("judge enters printed codes and QR proof is removed from the address", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "judge", "Mobile judge project only");
  let signedIn = false;
  const credentials: unknown[] = [];
  const tokens: unknown[] = [];
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/judge/login") {
      credentials.push(route.request().postDataJSON());
      signedIn = true;
    }
    if (path === "/api/judge/join") {
      tokens.push(route.request().postDataJSON());
      signedIn = true;
    }
    if (path === "/api/judge/me" && !signedIn) {
      await route.fulfill({
        status: 401,
        json: { code: "unauthenticated", message: "Sign in", retryable: false },
        headers: { "X-Dais": "1" },
      });
      return;
    }
    await route.fulfill({
      json: { ok: true, data: path === "/api/judge/me" ? judgeFixture() : {} },
      headers: { "X-Dais": "1" },
    });
  });
  await page.goto("/j/");
  await page.getByLabel("Tournament code", { exact: true }).fill("SAMPLE");
  await page.getByLabel("Judge code", { exact: true }).fill("J01");
  await page.getByRole("button", { name: "Open my sheets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hello, Sample Judge" })).toBeVisible();
  expect(credentials).toEqual([{ tournamentCode: "SAMPLE", judgeCode: "J01" }]);
  await page.goto("/j/join?token=test-qr-proof");
  await expect(page).toHaveURL(/\/j\/$/);
  await expect(page.getByRole("heading", { name: "Hello, Sample Judge" })).toBeVisible();
  expect(tokens).toEqual([{ token: "test-qr-proof" }]);
  const storage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(JSON.stringify(storage)).not.toContain("test-qr-proof");
});
