"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { SegmentedControl, type SegmentedOption } from "@/ui/segmented-control";

type Mode = "light" | "dark" | "system";

const OPTIONS: readonly SegmentedOption<Mode>[] = [
  {
    value: "light",
    label: (
      <>
        <Sun aria-hidden="true" />
        <span>Light</span>
      </>
    ),
  },
  {
    value: "dark",
    label: (
      <>
        <Moon aria-hidden="true" />
        <span>Dark</span>
      </>
    ),
  },
  {
    value: "system",
    label: (
      <>
        <Monitor aria-hidden="true" />
        <span>System</span>
      </>
    ),
  },
];

const subscribeNoop = () => () => {};

/** True after hydration. Before that, the server and client must agree on "system". */
function useMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

function isMode(value: string | undefined): value is Mode {
  return value === "light" || value === "dark" || value === "system";
}

/** Light / dark / system, remembered per browser by next-themes. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const current: Mode = mounted && isMode(theme) ? theme : "system";

  return (
    <SegmentedControl
      label="Colour mode"
      options={OPTIONS}
      value={current}
      onValueChange={setTheme}
      size="sm"
      className={className}
    />
  );
}
