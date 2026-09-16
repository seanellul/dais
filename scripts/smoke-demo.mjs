// Exercise a fresh self-hosted instance after its health check succeeds.
const origin = process.env.DAIS_SMOKE_ORIGIN ?? "http://localhost:3000";
const response = await fetch(new URL("/demo", origin), {
  method: "POST",
  headers: { Origin: origin },
  redirect: "manual",
  signal: AbortSignal.timeout(60_000),
});
if (response.status !== 303) {
  throw new Error(`Demo creation returned HTTP ${response.status}`);
}
const location = new URL(response.headers.get("location"), origin);
if (location.origin !== origin || !location.pathname.startsWith("/t/")) {
  throw new Error("Demo did not redirect to its tournament");
}
const cookie = response.headers.get("set-cookie")?.split(";")[0];
if (!cookie?.startsWith("dais.org=")) throw new Error("Demo did not issue an organiser session");
const dashboard = await fetch(location, {
  headers: { Cookie: cookie },
  redirect: "manual",
  signal: AbortSignal.timeout(60_000),
});
if (dashboard.status !== 200 || !(await dashboard.text()).includes("Run sheet")) {
  throw new Error(`Demo dashboard did not load: HTTP ${dashboard.status}`);
}
console.log("Fresh demo created; authenticated run sheet loaded.");
