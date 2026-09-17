"use client";
import { useEffect, useState, useSyncExternalStore } from "react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export function useJudgePwa() {
  const [ready, setReady] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const ios = useSyncExternalStore(
    () => () => {},
    () => /iPad|iPhone|iPod/.test(navigator.userAgent),
    () => false,
  );
  useEffect(() => {
    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    if (!("serviceWorker" in navigator))
      return () => window.removeEventListener("beforeinstallprompt", onInstall);
    let disposed = false;
    const check = () => {
      const controller = navigator.serviceWorker.controller;
      if (!controller) return;
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        if (!disposed) setReady(event.data?.ready === true);
        channel.port1.close();
      };
      controller.postMessage({ type: "CHECK_READY" }, [channel.port2]);
    };
    navigator.serviceWorker.addEventListener("controllerchange", check);
    navigator.serviceWorker
      .register("/j/sw.js", { scope: "/j/", updateViaCache: "none" })
      .then((registration) => {
        if (disposed) return;
        setWaiting(registration.waiting);
        check();
        registration.addEventListener("updatefound", () =>
          registration.installing?.addEventListener("statechange", () => {
            if (!disposed && registration.waiting) setWaiting(registration.waiting);
          }),
        );
      })
      .catch(() => {
        if (!disposed) setReady(false);
      });
    return () => {
      disposed = true;
      window.removeEventListener("beforeinstallprompt", onInstall);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
    };
  }, []);
  return {
    ready,
    waiting,
    install,
    ios,
    async installApp() {
      await install?.prompt();
      setInstall(null);
    },
    activate() {
      if (!waiting) return;
      navigator.serviceWorker.addEventListener("controllerchange", () => location.replace("/j/"), {
        once: true,
      });
      waiting.postMessage({ type: "SKIP_WAITING" });
    },
  };
}
