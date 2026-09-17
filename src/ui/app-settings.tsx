"use client";

import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/ui/cn";
import { ThemeToggle } from "@/ui/theme-toggle";

export interface AppSettingsProps {
  /** Additional controls to show below the shared appearance setting. */
  children?: ReactNode;
  className?: string;
}

/** A compact settings disclosure for appearance and screen-level preferences. */
export function AppSettings({ children, className }: AppSettingsProps) {
  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Open settings"
            className={cn("h-(--control-h) min-h-(--control-h)", className)}
          />
        }
      >
        <Settings2 aria-hidden="true" />
        <span>Settings</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50 outline-none">
          <Popover.Popup className="w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <Popover.Title className="font-heading text-base leading-none font-medium">
              Appearance
            </Popover.Title>
            <ThemeToggle className="mt-3 w-full" />
            {children ? (
              <>
                <div className="my-3 h-px bg-border" />
                <div className="grid gap-2">{children}</div>
              </>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
