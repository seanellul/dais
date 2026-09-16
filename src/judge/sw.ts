/// <reference lib="webworker" />
import { NavigationRoute, Serwist, type PrecacheEntry } from "serwist";
declare const self: ServiceWorkerGlobalScope & { __SW_MANIFEST: (PrecacheEntry | string)[] };

// Only generated static app assets enter the precache. Judge data lives in
// IndexedDB; authenticated API requests always reach the network directly.
const manifest = self.__SW_MANIFEST.filter((entry) => {
  const url = typeof entry === "string" ? entry : entry.url;
  return !url.startsWith("/api/") && !url.startsWith("/j/join") && !url.endsWith(".map");
});
const serwist = new Serwist({
  precacheEntries: manifest,
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: false,
  precacheOptions: { cleanupOutdatedCaches: true },
  runtimeCaching: [],
});
serwist.registerRoute(
  new NavigationRoute(
    async () => {
      const shell = (await serwist.matchPrecache("/j/")) ?? (await serwist.matchPrecache("/j"));
      if (!shell) return Response.error();
      return shell;
    },
    { allowlist: [/^\/j\/?(?:\?.*)?$/], denylist: [/^\/api\//, /^\/j\/join/] },
  ),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "CHECK_READY")
    event.waitUntil(
      (async () => {
        const shell = (await serwist.matchPrecache("/j/")) ?? (await serwist.matchPrecache("/j"));
        event.ports[0]?.postMessage({ ready: !!shell });
      })(),
    );
});
serwist.addEventListeners();
