import { expect, test } from "@playwright/test";

test("organiser routes require sign-in and show password errors accessibly", async ({ page }) => {
  await page.goto("/t");
  await expect(page).toHaveURL(/\/signin/);
  await expect(page.locator("main#main")).toBeVisible();
  await page.getByLabel("Email address").fill("fictional-organiser@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("A fictional wrong password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/signin/);
});

test("organiser receives three rounds, traces scores, confirms finalists, publishes and reopens", async ({
  page,
  baseURL,
}) => {
  const response = await page.request.post("/demo", {
    headers: { Origin: new URL(baseURL!).origin },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  const location = response.headers().location;
  expect(location).toBeTruthy();
  await page.goto(new URL(location).pathname);
  await expect(page.getByRole("heading", { name: "The run sheet" })).toBeVisible();
  const root = new URL(page.url()).pathname;
  await page.goto(`${root}/teams`);
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("joinTokenHash");
  await page.goto(`${root}/draw`);
  await expect(page.getByRole("heading", { name: "The draw", exact: true })).toBeVisible();
  for (const round of [1, 2, 3]) {
    await page.goto(`${root}/rounds/${round}`);
    await expect(page.getByRole("heading", { name: `Round ${round}`, exact: true })).toBeVisible();
    await page.goto(root);
    const simulation = page.getByRole("heading", { name: "Practice the day" }).locator("..");
    await simulation
      .getByRole("combobox", { name: "Round", exact: true })
      .selectOption(String(round));
    await simulation.getByLabel("Sheets to leave missing").fill("0");
    await simulation.getByRole("button", { name: "Simulate round", exact: true }).click();
    await expect(simulation.getByText("Saved to the tournament.", { exact: true })).toBeVisible();
  }
  await page.goto(`${root}/rounds/1`);
  await page.locator(".org-table tbody tr").first().locator("td button").first().click();
  await page.getByRole("button", { name: "Introduce two versions", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Two versions to review", exact: true }),
  ).toBeVisible();
  const decision = page
    .getByRole("heading", { name: "Two versions to review", exact: true })
    .locator("..");
  await decision.getByLabel("Version decision").selectOption("keep");
  await decision
    .getByLabel("Reason kept in the history")
    .fill("Checked both fictional versions against the judge’s paper.");
  await decision.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Two versions to review", exact: true }),
  ).toHaveCount(0);
  await page.goto(`${root}/results`);
  await expect(page.getByRole("heading", { name: "Results", exact: true })).toBeVisible();
  const debaters = page.getByRole("table").first();
  await debaters.locator("summary").first().click();
  await expect(debaters.getByText(/kept scores average/).first()).toBeVisible();
  const finalist = page.getByRole("heading", { name: "Finalists", exact: true }).locator("..");
  await finalist
    .getByLabel("Reason kept in the history")
    .fill("Eligible top teams checked by the sample organiser.");
  await finalist.getByRole("button", { name: "Confirm finalists" }).click();
  await expect(finalist.getByText("Confirmed", { exact: true })).toBeVisible();
  const publishing = page
    .getByRole("heading", { name: "Publish results", exact: true })
    .locator("..");
  await publishing.getByRole("checkbox").check();
  await publishing.getByRole("button", { name: /Publish .* results/ }).click();
  await expect(page.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
  const reopen = page.getByRole("heading", { name: "Published", exact: true }).locator("..");
  await reopen
    .getByLabel("Reason kept in the history")
    .fill("Review a fictional late sheet before republishing.");
  await reopen.getByRole("button", { name: "Reopen results", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Publish results", exact: true })).toBeVisible();
});

test("landing live demo button posts and opens the organiser run sheet", async ({ page }) => {
  await page.goto("/");
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/demo" && response.request().method() === "POST",
      { timeout: 10000 },
    ),
    page.getByRole("button", { name: "Try the live demo", exact: true }).click(),
  ]);
  expect(response.status()).toBe(303);
  await expect(page).toHaveURL(/\/t\/demo-/);
  await expect(page.getByRole("heading", { name: "The run sheet", exact: true })).toBeVisible();
});
