import "@/organiser/organiser.css";
import Link from "next/link";
import { headers } from "next/headers";
import { AppThemeProvider } from "@/ui/app-theme-provider";
export default async function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AppThemeProvider nonce={(await headers()).get("x-nonce") ?? undefined}>
      <div className="org-shell">
        <header className="org-top">
          <Link href="/" className="org-brand">
            Dais
          </Link>
          <Link href="/">About Dais</Link>
        </header>
        <main id="main" tabIndex={-1} className="org-auth">
          {children}
        </main>
      </div>
    </AppThemeProvider>
  );
}
