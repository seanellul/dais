"use client";

/**
 * Two screen-reader live regions for the whole app, mounted once in the root
 * layout. Components call `useAnnounce()` instead of rendering their own
 * regions, so announcements never compete.
 *
 *   - polite: batched, at most one announcement every 3 seconds. Used for
 *     "Sheet received from Room 4" style updates on the live board.
 *   - assertive: immediate. Used for errors only.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { createPoliteQueue, POLITE_BATCH_MS, type PoliteQueue } from "@/ui/polite-queue";

export { POLITE_BATCH_MS };

export interface AnnounceOptions {
  /** Interrupt the reader now. Only for errors. */
  assertive?: boolean;
}

export type Announce = (message: string, options?: AnnounceOptions) => void;

interface Announcement {
  text: string;
  /** Changes on every announcement so identical text is still re-read. */
  key: number;
}

const LiveRegionContext = createContext<Announce | null>(null);

const EMPTY: Announcement = { text: "", key: 0 };

function next(text: string) {
  return (previous: Announcement): Announcement => ({ text, key: previous.key + 1 });
}

export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState<Announcement>(EMPTY);
  const [assertive, setAssertive] = useState<Announcement>(EMPTY);
  const queue = useRef<PoliteQueue | null>(null);
  if (queue.current === null) {
    queue.current = createPoliteQueue((text) => setPolite(next(text)));
  }

  const announce = useCallback<Announce>((message, options) => {
    if (options?.assertive) {
      setAssertive(next(message));
    } else {
      queue.current?.push(message);
    }
  }, []);

  useEffect(() => {
    const owned = queue.current;
    return () => owned?.cancel();
  }, []);

  return (
    <LiveRegionContext.Provider value={announce}>
      {children}
      <LiveRegion politeness="polite" announcement={polite} />
      <LiveRegion politeness="assertive" announcement={assertive} />
    </LiveRegionContext.Provider>
  );
}

/**
 * Returns the app-wide `announce` function. Outside a provider it returns a
 * no-op, so a component never breaks because the layout forgot the provider.
 */
export function useAnnounce(): Announce {
  const announce = useContext(LiveRegionContext);
  return announce ?? noop;
}

function noop() {}

interface LiveRegionProps {
  politeness: "polite" | "assertive";
  announcement: Announcement;
}

/** A visually hidden live region. Rendered by the provider; rarely used directly. */
export function LiveRegion({ politeness, announcement }: LiveRegionProps) {
  return (
    <div
      aria-live={politeness}
      aria-atomic="true"
      role={politeness === "assertive" ? "alert" : "status"}
      className="sr-only"
    >
      <span key={announcement.key}>{announcement.text}</span>
    </div>
  );
}
