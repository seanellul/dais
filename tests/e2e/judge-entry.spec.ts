import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("sample room opens all three judge sheets without codes and survives reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Judge a sample room", exact: true }).click();
  await page.getByRole("button", { name: "Start judging", exact: true }).click();
  for (const round of [1, 2, 3]) {
    await expect(
      page.getByRole("button", { name: `Open round ${round} sheet`, exact: true }),
    ).toBeVisible();
  }
  await expect(page).toHaveURL(/\/j\/$/);
  await expect(page.getByLabel("Tournament code", { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Open round 1 sheet", exact: true }).click();
  await page.getByRole("button", { name: "Start scoring", exact: true }).click();
  await expect(page.locator("fieldset")).toHaveCount(4);
});

test("judge sign-in has a way home and optional settings with a code-free demo", async ({
  page,
}) => {
  await page.goto("/j/");
  await expect(page.getByRole("heading", { name: "Take your seat", exact: true })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Colour mode" })).toHaveCount(0);
  await expect(page.getByText("Add to home screen (optional)", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update app", exact: true })).toHaveCount(0);
  const settings = page.getByRole("button", { name: "Open settings", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByText("Add to home screen (optional)", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });
  const violations = (await new AxeBuilder({ page }).analyze()).violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await expect(page.getByRole("radiogroup", { name: "Colour mode" })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to Dais home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Judge a sample room", exact: true })).toBeVisible();
  await page.goto("/j/");
  await page.getByRole("link", { name: "Try a sample room", exact: true }).click();
  await expect(page).toHaveURL(/\/demo\/judge$/);
});

test("invalid QR link explains how to recover instead of silently asking for codes", async ({
  page,
}) => {
  await page.goto(`/j/join?t=invalid-${crypto.randomUUID()}`);
  await expect(
    page.getByRole("status").filter({ hasText: /join link is not valid/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Try a sample room", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Dais home", exact: true })).toBeVisible();
});
