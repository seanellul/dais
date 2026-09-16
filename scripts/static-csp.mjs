/** Embed immutable HTML script hashes in the built proxy, across Next adapters. */
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, access } from "node:fs/promises";
import { join, relative } from "node:path";

const nextDir = join(process.cwd(), ".next");
const appDir = join(nextDir, "server", "app");
const policies = {};
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.name.endsWith(".html")) {
      const html = await readFile(path, "utf8");
      const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
        .filter((match) => !/\bsrc\s*=/i.test(match[1]))
        .map((match) => `'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`);
      const file = relative(appDir, path).replace(/\.html$/, "");
      policies[file === "index" ? "/" : `/${file}`] = [
        "default-src 'self'",
        `script-src 'self' ${[...new Set(hashes)].join(" ")}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "media-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; ");
    }
  }
}
await collect(appDir);
for (const path of ["/", "/j", "/j/join", "/design", "/demo/judge"]) {
  if (!policies[path]) throw new Error(`Missing static CSP source: ${path}`);
}
let patched = 0;
async function patch(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await patch(path);
    else if (entry.name.endsWith(".js")) {
      const code = await readFile(path, "utf8");
      if (!code.includes("__DAIS_STATIC_CSP__")) continue;
      const next = code.replace(/(["'])__DAIS_STATIC_CSP__\1/g, () =>
        JSON.stringify(JSON.stringify(policies)),
      );
      if (next === code) throw new Error(`Unrecognised CSP marker in ${path}`);
      await writeFile(path, next);
      patched++;
    }
  }
}
await patch(join(nextDir, "server"));
if (!patched)
  throw new Error("Compiled proxy CSP marker was not found; refusing an unprotected build.");
const standalone = join(nextDir, "standalone", ".next", "server");
const adapterDirs = [standalone, join(process.cwd(), ".vercel", "output", "functions")];
if (process.env.VERCEL === "1") adapterDirs.push("/vercel/output/functions");
for (const dir of new Set(adapterDirs)) {
  try {
    await access(dir);
    await patch(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
console.log(
  `Embedded hash-based CSP for ${Object.keys(policies).length} static pages in ${patched} proxy outputs.`,
);
