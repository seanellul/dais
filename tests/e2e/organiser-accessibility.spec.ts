import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import QRCode from "qrcode";
import { readFile, writeFile } from "node:fs/promises";
import { encodeHandoff } from "../../src/judge/handoff";
import type { SheetPayload } from "../../src/domain/types";
import type { JudgeBootstrap } from "../../src/judge/api-types";

const cache = "/tmp/dais-organiser-accessibility-fixture.json";
type Fixture = { root: string; storage: Awaited<ReturnType<BrowserContext["storageState"]>> };
type Check = {
  path: string;
  variant: string;
  violations: { id: string; impact: string | null | undefined; targets: string[] }[];
  overflow: number;
  smallTargets: string[];
};

async function fixtureFor(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<Fixture> {
  let fixture: Fixture | undefined;
  try {
    fixture = JSON.parse(await readFile(cache, "utf8")) as Fixture;
    await context.addCookies(fixture.storage.cookies);
    await page.goto(fixture.root);
    if (!new URL(page.url()).pathname.startsWith("/t/")) fixture = undefined;
  } catch {
    fixture = undefined;
  }
  if (!fixture) {
    const response = await page.request.post("/demo", {
      headers: { Origin: new URL(baseURL!).origin },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    const root = new URL(response.headers().location).pathname;
    await page.goto(root);
    await expect(page.getByRole("heading", { name: "The run sheet" })).toBeVisible();
    fixture = { root, storage: await context.storageState() };
    await writeFile(cache, JSON.stringify(fixture), { mode: 0o600 });
  }
  return fixture;
}
test("organiser and auth routes are accessible in light, dark and phone layouts", async ({
  page,
  context,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "organiser",
    "One shared fixture; this test checks desktop and phone itself.",
  );
  test.setTimeout(300000);
  const fixture = await fixtureFor(page, context, baseURL);
  const root = fixture.root;
  const routes = [
    "/t",
    "/t/new",
    root,
    ...[
      "teams",
      "judges",
      "rooms",
      "draw",
      "rounds/1",
      "rounds/2",
      "rounds/3",
      "results",
      "exports",
      "settings",
      "history",
    ].map((p) => `${root}/${p}`),
    ...["doors", "itineraries", "judges", "scoresheets", "feedback", "results"].map(
      (p) => `${root}/print/${p}`,
    ),
  ];
  const checks: Check[] = [];
  async function inspect(target: Page, path: string, variant: string, phone: boolean) {
    await target.goto(path);
    await expect(target.locator("main#main")).toHaveCount(1);
    // Wait for the remembered mode to hydrate: SSR starts at system, then
    // the selected radio changes and its colour transition must finish.
    if (path.startsWith("/t")) {
      const mode = variant === "desktop-dark" ? "Dark" : "Light";
      await expect(target.getByRole("radio", { name: mode, exact: true })).toBeChecked();
    }
    await target.evaluate(async () => {
      await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
    });
    const violations = (await new AxeBuilder({ page: target }).analyze()).violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => ({
        id: v.id,
        impact: v.impact,
        targets: v.nodes.flatMap((n) => n.target.map(String)),
      }));
    const geometry = await target.evaluate(() => ({
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      smallTargets: Array.from(
        document.querySelectorAll<HTMLElement>(
          'button,input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),select,textarea,summary,nav a,.org-button',
        ),
      )
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            getComputedStyle(e).visibility !== "hidden" &&
            getComputedStyle(e).display !== "none" &&
            (r.width < 43.5 || r.height < 43.5)
          );
        })
        .map(
          (e) =>
            `${e.tagName.toLowerCase()} ${e.getAttribute("aria-label") ?? e.textContent?.trim().slice(0, 50) ?? e.getAttribute("name") ?? "control"}`,
        ),
    }));
    checks.push({ path, variant, violations, ...geometry });
    await writeFile(
      testInfo.outputPath("accessibility-summary.json"),
      JSON.stringify(checks, null, 2),
    );
    expect.soft(violations, `${variant} ${path} serious/critical axe`).toEqual([]);
    if (phone) {
      expect.soft(geometry.overflow, `${path} document overflow`).toBeLessThanOrEqual(1);
      expect.soft(geometry.smallTargets, `${path} controls below44px`).toEqual([]);
    }
  }
  for (const variant of [
    { name: "desktop-light", width: 1440, height: 1000, mode: "light" },
    { name: "desktop-dark", width: 1440, height: 1000, mode: "dark" },
    { name: "phone390", width: 390, height: 844, mode: "light" },
  ] as const) {
    await page.setViewportSize({ width: variant.width, height: variant.height });
    await page.emulateMedia({ colorScheme: variant.mode });
    await page.evaluate((mode) => localStorage.setItem("theme", mode), variant.mode);
    for (const route of routes) await inspect(page, route, variant.name, variant.width === 390);
  }
  const anonymous = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const auth = await anonymous.newPage();
  await auth.goto("/signin");
  for (const variant of [
    { name: "auth-light", width: 1440, mode: "light" },
    { name: "auth-dark", width: 1440, mode: "dark" },
    { name: "auth-phone", width: 390, mode: "light" },
  ] as const) {
    await auth.setViewportSize({ width: variant.width, height: 1000 });
    await auth.emulateMedia({ colorScheme: variant.mode });
    await auth.evaluate((mode) => localStorage.setItem("theme", mode), variant.mode);
    for (const route of ["/signin", "/setup", "/invite/expired-example-invitation"])
      await inspect(auth, route, variant.name, variant.width === 390);
  }
  await anonymous.close();
  await testInfo.attach("organiser-accessibility-summary", {
    body: JSON.stringify(checks, null, 2),
    contentType: "application/json",
  });
});

test("organiser scans a hand-off QR image and merges original phone retry comments", async ({
  page,
  context,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== "organiser", "One cached organiser fixture.");
  const { root } = await fixtureFor(page, context, baseURL);
  // Issue one intentional private card, authenticate its judge, and choose an unreceived slot.
  await page.goto(`${root}/judges`);
  await page.getByRole("button", { name: "Issue QR card", exact: true }).nth(1).click();
  const link = page.getByRole("link", { name: "Open judge scoresheets", exact: true });
  await expect(link).toBeVisible();
  const token = new URL((await link.getAttribute("href"))!).searchParams.get("t")!;
  const phone = await browser.newContext({ baseURL });
  const joined = await phone.request.post("/api/judge/join", {
    headers: { Origin: new URL(baseURL!).origin },
    data: { token },
  });
  expect(joined.status()).toBe(200);
  const me = await phone.request.get("/api/judge/me");
  expect(me.status()).toBe(200);
  const bootstrap = ((await me.json()) as { data: JudgeBootstrap }).data;
  const slot = bootstrap.assignments.find(
    (a) => !a.retiredAt && !a.current && !a.divisionFinalized,
  )!;
  expect(slot).toBeTruthy();
  const payload: SheetPayload = {
    scores: Object.fromEntries(
      slot.display.speakers.map((s) => [
        s.id,
        {
          argumentation: 24,
          rebuttal: 25,
          presentation: 24,
          poi: 3,
          overall: 78,
          www: "Comments retained by the phone",
          ebi: "Add another supporting example",
        },
      ]),
    ),
    sideFlipped: false,
    roleSwaps: {},
  };
  const requestId = `browser-handoff-${Date.now()}`;
  const encoded = encodeHandoff({
    assignmentId: slot.id,
    judgeId: bootstrap.judge.id,
    requestId,
    baseVersion: 0,
    payload,
  });
  await page.goto(`${root}/rounds/${slot.identity.round}`);
  const seat = page
    .locator(".org-table tbody button")
    .filter({ hasText: bootstrap.judge.name })
    .first();
  await seat.click();
  const drawer = page.getByRole("region", { name: "Sheet detail" });
  const detail = drawer
    .count()
    .then((n) => (n ? drawer : page.locator('section[aria-label="Sheet detail"]')));
  const sheet = await detail;
  await sheet.getByText("Enter a phone hand-off", { exact: true }).click();
  await sheet.getByLabel("Choose a hand-off QR image or photo", { exact: true }).setInputFiles({
    name: "fictional-hand-off.png",
    mimeType: "image/png",
    buffer: await QRCode.toBuffer(encoded.text, { type: "png", width: 1024, margin: 4 }),
  });
  await expect(sheet.getByRole("textbox", { name: "Hand-off text", exact: true })).toHaveValue(
    encoded.text,
  );
  const handoff = sheet
    .locator("details")
    .filter({ has: page.getByText("Enter a phone hand-off", { exact: true }) });
  await handoff
    .getByLabel("Reason kept in the history", { exact: true })
    .fill("Checked the phone hand-off against the judge and four debaters.");
  await handoff.getByRole("button", { name: "Receive hand-off", exact: true }).click();
  await expect(page.getByText(/version 1 · judge_handoff/)).toBeVisible();
  const retry = await phone.request.post("/api/judge/sheets", {
    headers: { Origin: new URL(baseURL!).origin },
    data: { assignmentId: slot.id, requestId, baseVersion: 0, payload },
  });
  expect(retry.status()).toBe(409);
  const conflict = ((await retry.json()) as { details: { receipt: { conflictId: string } } })
    .details.receipt.conflictId;
  expect(conflict).toBeTruthy();
  await page.reload();
  await page
    .locator(".org-table tbody button")
    .filter({ hasText: bootstrap.judge.name })
    .first()
    .click();
  const review = page
    .getByRole("heading", { name: "Two versions to review", exact: true })
    .locator("..");
  await review.getByLabel("Version decision").selectOption("merge_comments");
  await review
    .getByLabel("Reason kept in the history")
    .fill("Numbers match the hand-off; merge the phone’s original comments.");
  await review.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Two versions to review", exact: true }),
  ).toHaveCount(0);
  const replay = await phone.request.post("/api/judge/sheets", {
    headers: { Origin: new URL(baseURL!).origin },
    data: { assignmentId: slot.id, requestId, baseVersion: 0, payload },
  });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({
    ok: true,
    data: { status: "received", resolution: "merge_comments", version: 2 },
  });
  const final = await phone.request.get("/api/judge/me");
  const finalData = ((await final.json()) as { data: JudgeBootstrap }).data;
  expect(finalData.assignments.find((a) => a.id === slot.id)?.current?.payload.scores).toEqual(
    payload.scores,
  );
  await phone.close();
});

test("organiser keyboard reaches main and focuses route headings on desktop and phone", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== "organiser", "Desktop and phone checked within one fixture.");
  const { root } = await fixtureFor(page, context, baseURL);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(root);
    await expect.soft(page.locator("#page-title")).toBeFocused();
    const skip = page.getByRole("link", { name: "Skip to content" });
    // Route focus starts at its heading. Walk backwards through the chrome;
    // blur alone does not reset the browser’s sequential-navigation position.
    for (
      let i = 0;
      i < 30 && !(await skip.evaluate((node) => node === document.activeElement));
      i++
    )
      await page.keyboard.press("Shift+Tab");
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
    await page
      .getByRole("navigation", { name: "Organiser" })
      .getByRole("link", { name: "Teams", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${root}/teams`));
    await expect.soft(page.locator("#page-title")).toBeFocused();
  }
  const presentation = page.getByRole("button", { name: /Presentation mode/ });
  await page.locator("#page-title").focus();
  await page.keyboard.press("p");
  await expect(presentation).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Team name", { exact: true }).first().focus();
  await page.keyboard.press("p");
  await expect(presentation).toHaveAttribute("aria-pressed", "true");
  await presentation.click();
  await expect(presentation).toHaveAttribute("aria-pressed", "false");
});
