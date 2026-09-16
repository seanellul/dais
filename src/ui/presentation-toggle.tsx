"use client";

/**
 * Presentation mode: 125% scale and comfortable density for a projector.
 * It is a browser-local setting (localStorage), applied as
 * <html data-presentation="on"> so the CSS in globals.css can react to it.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Presentation } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/ui/cn";
import { PRESENTATION_STORAGE_KEY } from "@/ui/theme";

/** Fallback when localStorage throws (private mode, blocked storage). */
let memory = false;
const listeners = new Set<() => void>();

/** Reads localStorage every time, so a change made in another tab is seen. */
function readStored(): boolean {
  try {
    return window.localStorage.getItem(PRESENTATION_STORAGE_KEY) === "on";
  } catch {
    return memory;
  }
}

function writeStored(on: boolean): void {
  memory = on;
  try {
    window.localStorage.setItem(PRESENTATION_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode or blocked storage: the in-memory value still applies.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed the setting.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function applyToDocument(on: boolean): void {
  document.documentElement.dataset.presentation = on ? "on" : "off";
}

/**
 * Reads and writes presentation mode. Any mounted caller keeps the <html>
 * attribute in sync, so the organiser shell should call this (or render the
 * toggle) on every page where the mode matters.
 */
export function usePresentationMode(): [on: boolean, setOn: (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, readStored, () => false);

  useEffect(() => {
    applyToDocument(on);
  }, [on]);

  const setOn = useCallback((next: boolean) => writeStored(next), []);
  return [on, setOn];
}

/**
 * A toggle button with aria-pressed, 44px tall (--control-h). Put it in the
 * organiser top bar. The "p" shortcut belongs to the organiser shell, which
 * should call `usePresentationMode` from its key handler.
 */
export function PresentationToggle({ className }: { className?: string }) {
  const [on, setOn] = usePresentationMode();
  return (
    <Button
      variant="outline"
      aria-pressed={on}
      onClick={() => setOn(!on)}
      className={cn("h-(--control-h) px-3 text-base", className)}
      title="Larger text and spacing for a projector"
    >
      <Presentation aria-hidden="true" />
      <span>Presentation mode</span>
      <span className="sr-only">{on ? "on" : "off"}</span>
    </Button>
  );
}
