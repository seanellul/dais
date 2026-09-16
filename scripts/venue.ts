/** Local LAN fallback. HTTPS is still required for offline phone installation. */
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import QRCode from "qrcode";

async function main() {
  const address =
    process.env.VENUE_ADDRESS ??
    Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!address) throw new Error("Connect to the venue network or set VENUE_ADDRESS.");
  const port = process.env.PORT ?? "3000";
  if (!/^\d{2,5}$/.test(port) || Number(port) > 65535)
    throw new Error("PORT must be a valid TCP port.");
  const origin = `http://${address}:${port}`;
  console.log(`Venue organiser: ${origin}\nJudge sign-in: ${origin}/j/`);
  console.log(await QRCode.toString(`${origin}/j/`, { type: "terminal", small: true }));
  console.log(
    "Phones must join this network. Plain HTTP cannot install the offline service worker on phones. Keep the local server and network connected; use HTTPS for offline scoring. Data stays in ./data/venue.",
  );
  const child = spawn("pnpm", ["exec", "next", "dev", "--hostname", "0.0.0.0", "--port", port], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: "", PGLITE_DIR: "./data/venue", APP_URL: origin },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Venue startup failed");
  process.exitCode = 1;
});
