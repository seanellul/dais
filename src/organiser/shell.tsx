"use client";
import { useEffect } from "react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/server/actions/auth";
import { AppSettings, PresentationToggle, usePresentationMode } from "@/ui";
export function OrganiserShell({ name, children }: { name: string; children: React.ReactNode }) {
  const path = usePathname();
  const [, setOn] = usePresentationMode();
  const [on] = usePresentationMode();
  const slug = path.split("/")[2];
  const base = slug && slug !== "new" ? `/t/${slug}` : "/t";
  const links =
    base === "/t"
      ? [
          ["/t", "Tournaments"],
          ["/t/new", "New tournament"],
        ]
      : [
          [base, "Run sheet"],
          [`${base}/teams`, "Teams"],
          [`${base}/judges`, "Judges"],
          [`${base}/rooms`, "Rooms & panels"],
          [`${base}/draw`, "Draw"],
          [`${base}/rounds/1`, "Live rounds"],
          [`${base}/results`, "Results"],
          [`${base}/exports`, "Exports & print"],
          [`${base}/history`, "History"],
          [`${base}/settings`, "Settings"],
          ["/t", "All tournaments"],
        ];
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === "p" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !(
          e.target instanceof HTMLElement &&
          e.target.closest("input,textarea,select,[contenteditable]")
        )
      ) {
        e.preventDefault();
        setOn(!on);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [on, setOn]);
  useEffect(() => {
    document.getElementById("page-title")?.focus();
  }, [path]);
  return (
    <div className="org-shell">
      <header className="org-top">
        <Link href={"/t" as Route} className="org-brand">
          Dais<span className="org-muted"> / order of the day</span>
        </Link>
        <div className="org-actions">
          <span className="org-muted">{name}</span>
          <AppSettings>
            <PresentationToggle className="w-full justify-start" />
          </AppSettings>
          <form
            action={async () => {
              await signOutAction();
            }}
          >
            <button className="org-button">Sign out</button>
          </form>
        </div>
      </header>
      <div className="org-body">
        <nav className="org-nav" aria-label="Organiser">
          {links.map(([href, label]) => (
            <Link key={href} href={href as Route} aria-current={path === href ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <main id="main" tabIndex={-1} className="org-main">
          {children}
        </main>
      </div>
    </div>
  );
}
