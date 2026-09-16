import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import type { LoadFixture } from "../../scripts/load-judge";
import type { JudgeBootstrap } from "../../src/judge/api-types";
import { judgeFixture } from "../unit/judge/fixtures";
async function filled(page: Page, round = 1) {
  await page.getByRole("button", { name: `Open round ${round} sheet`, exact: true }).click();
  await page.getByRole("button", { name: "Start scoring", exact: true }).click();
  await expect(page.locator("fieldset")).toHaveCount(4);
  for (const card of await page.locator("fieldset").all()) {
    await card.getByLabel("Argumentation", { exact: true }).fill("24");
    await card.getByLabel("Rebuttal", { exact: true }).fill("25");
    await card.getByLabel("Presentation", { exact: true }).fill("24");
    await card.getByRole("radio", { name: "3", exact: true }).click();
    await card.getByLabel(/^Overall score/).fill("78");
  }
  await page.getByRole("button", { name: "Review sheet", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your sheet", exact: true })).toBeVisible();
}
async function pending(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("dais-judge-v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<{ requestId: string; state: string }[]>((resolve, reject) => {
        const req = db.transaction("workspaces").objectStore("workspaces").getAll();
        req.onsuccess = () =>
          resolve(
            req.result.flatMap(
              (row: { outbox: Record<string, { requestId: string; state: string }> }) =>
                Object.values(row.outbox).map((item) => ({
                  requestId: item.requestId,
                  state: item.state,
                })),
            ),
          );
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  });
}

test("real judge codes submit to JSON API and appear on organiser board", async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.skip(info.project.name !== "judge", "Judge project");
  test.skip(!process.env.E2E_JUDGE_FIXTURE, "Explicit private fictional fixture required");
  const fixture = JSON.parse(await readFile(process.env.E2E_JUDGE_FIXTURE!, "utf8")) as LoadFixture;
  expect(fixture.fictional).toBe(true);
  expect(fixture.name).toMatch(/^Dais load check /);
  await page.goto("/j/");
  await page.getByLabel("Tournament code", { exact: true }).fill(fixture.tournamentCode);
  await page.getByLabel("Judge code", { exact: true }).fill(fixture.judges[0].code);
  await page.getByRole("button", { name: "Open my sheets", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open round 3 sheet", exact: true })).toBeVisible();
  const bootstrap = (await (await page.request.get("/api/judge/me")).json()).data as JudgeBootstrap;
  expect(bootstrap.tournament.id).toBe(fixture.tournamentId);
  expect(bootstrap.judge.id).toBe(fixture.judges[0].id);
  const assignment = bootstrap.assignments.find(
    (row) => row.identity.round === 3 && !row.retiredAt,
  )!;
  expect(assignment).toBeTruthy();
  expect(assignment.current).toBeNull();
  await filled(page, 3);
  const receipt = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/judge/sheets" && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send to the tournament", exact: true }).click();
  const response = await receipt;
  expect(response.status()).toBe(200);
  expect((await response.json()).data.status).toBe("received");
  await expect(
    page.getByRole("heading", { name: "Received by the tournament", exact: true }),
  ).toBeVisible();
  const organiser = await browser.newContext({ baseURL });
  try {
    await organiser.addCookies([
      {
        name: "dais.org",
        value: fixture.ownerSession,
        url: baseURL!,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const board = await organiser.request.get(`/api/t/${fixture.tournamentId}/live?round=3`);
    expect(board.status()).toBe(200);
    const data = (await board.json()).data;
    expect(
      data.rooms
        .flatMap((room: { seats: unknown[] }) => room.seats)
        .find((seat: { assignmentId: string }) => seat.assignmentId === assignment.id),
    ).toMatchObject({ state: "in-phone", version: 1 });
    const orgPage = await organiser.newPage();
    await orgPage.goto(`/t/${fixture.slug}/rounds/3`);
    await expect(orgPage.getByRole("heading", { name: "Round 3", exact: true })).toBeVisible();
    await expect(orgPage.getByText("In · phone", { exact: true })).toBeVisible();
  } finally {
    await organiser.close();
  }
});

test("captive portal and retryable 429/503 retain one frozen queue before recovery", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "judge", "Judge project");
  const bootstrap = judgeFixture();
  let mode = "good";
  const sent: string[] = [];
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health" && mode === "portal") {
      await route.fulfill({ body: "<html>Venue Wi-Fi sign-in</html>", contentType: "text/html" });
      return;
    }
    if (path === "/api/judge/sheets") {
      sent.push(route.request().postDataJSON().requestId);
      if (mode === "429" || mode === "503") {
        await route.fulfill({
          status: Number(mode),
          json: {
            code: mode === "429" ? "rate_limited" : "database_unavailable",
            message: "Retry when connected",
            retryable: true,
          },
          headers: { "X-Dais": "1", "Retry-After": "1" },
        });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          data: { status: "received", version: 1, receivedAt: new Date().toISOString() },
        },
        headers: { "X-Dais": "1" },
      });
      return;
    }
    await route.fulfill({
      json: { ok: true, data: path === "/api/judge/me" ? bootstrap : {} },
      headers: { "X-Dais": "1" },
    });
  });
  await page.goto("/j/");
  await filled(page);
  mode = "portal";
  await page.getByRole("button", { name: "Send to the tournament", exact: true }).click();
  await expect(page.getByText(/connection is showing a sign-in page/)).toBeVisible();
  expect(sent).toEqual([]);
  const original = await pending(page);
  expect(original).toHaveLength(1);
  expect(original[0].state).toBe("queued");
  for (const failure of ["429", "503"]) {
    mode = failure;
    const rejected = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/judge/sheets" &&
        response.status() === Number(failure),
    );
    await page.getByRole("button", { name: "Retry saved sheet", exact: true }).click();
    await rejected;
    await expect(page.getByRole("heading", { name: "Waiting to send", exact: true })).toBeVisible();
    await expect
      .poll(() => pending(page))
      .toEqual([{ requestId: original[0].requestId, state: "queued" }]);
  }
  mode = "good";
  await page.getByRole("button", { name: "Retry saved sheet", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Received by the tournament", exact: true }),
  ).toBeVisible();
  expect(sent).toEqual([original[0].requestId, original[0].requestId, original[0].requestId]);
});

for (const failure of ["conflict", "stale", "published"] as const)
  test(`judge ${failure} receipt preserves scores and provides recovery exits`, async ({
    page,
    context,
  }, info) => {
    test.skip(info.project.name !== "judge", "Judge project");
    const bootstrap = judgeFixture();
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/judge/sheets") {
        if (failure === "stale") {
          const successor = structuredClone(bootstrap.assignments[0]);
          successor.id = "asg_successor";
          successor.identity.debateId = "00000000-0000-4000-8000-000000000099";
          bootstrap.assignments[0].retiredAt = new Date().toISOString();
          bootstrap.assignments[0].successorId = successor.id;
          bootstrap.assignments.push(successor);
        }
        if (failure === "published") bootstrap.assignments[0].divisionFinalized = true;
        await route.fulfill({
          status: failure === "published" ? 423 : 409,
          json: {
            code:
              failure === "conflict"
                ? "version_conflict"
                : failure === "stale"
                  ? "assignment_retired"
                  : "division_finalized",
            message:
              failure === "conflict"
                ? "Two versions are with the organiser"
                : failure === "stale"
                  ? "The draw changed"
                  : "Results are published",
            retryable: false,
            details: failure === "stale" ? { successorId: "asg_successor" } : {},
          },
          headers: { "X-Dais": "1" },
        });
        return;
      }
      await route.fulfill({
        json: { ok: true, data: path === "/api/judge/me" ? bootstrap : {} },
        headers: { "X-Dais": "1" },
      });
    });
    await page.goto("/j/");
    await filled(page);
    await page.getByRole("button", { name: "Send to the tournament", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name:
          failure === "conflict"
            ? "Under organiser review"
            : failure === "stale"
              ? "The draw changed"
              : "Needs attention",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Hand off to the organiser", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Keep aside this local copy", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Get help", exact: true })).toBeVisible();
    if (failure === "stale") {
      await page
        .getByRole("button", { name: "Open the new sheet · copy matching debaters", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Before you score", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Start scoring", exact: true }).click();
      for (const card of await page.locator("fieldset").all())
        await expect(card.getByLabel(/^Overall score/)).toHaveValue("78");
    } else {
      await page.getByRole("button", { name: "Hand off to the organiser", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: "Complete hand-off code", exact: true }),
      ).toHaveValue(/^DAIS1\./);
    }
  });

test("waiting app update activates only after reviewed outbox is empty", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "judge", "Judge project");
  await context.addInitScript(() => {
    const messages: unknown[] = [];
    Reflect.set(window, "daisTestUpdateMessages", messages);
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = async (...args) => {
      const registration = await register(...args);
      Object.defineProperty(registration, "waiting", {
        configurable: true,
        get: () => ({ postMessage: (message: unknown) => messages.push(message) }),
      });
      return registration;
    };
  });
  const bootstrap = judgeFixture();
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") {
      await route.fulfill({ body: "Wi-Fi sign-in", contentType: "text/html" });
      return;
    }
    await route.fulfill({
      json: { ok: true, data: path === "/api/judge/me" ? bootstrap : {} },
      headers: { "X-Dais": "1" },
    });
  });
  await page.goto("/j/");
  await expect(page.getByRole("button", { name: "Update app", exact: true })).toBeEnabled();
  await filled(page);
  await page.getByRole("button", { name: "Send to the tournament", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Waiting to send", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update app", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(window, "daisTestUpdateMessages"))).toEqual([]);
  await page.getByRole("button", { name: "Keep aside this local copy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Copies kept aside", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update app", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Update app", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "daisTestUpdateMessages")))
    .toEqual([{ type: "SKIP_WAITING" }]);
});
