import type { Metadata } from "next";
import { AppThemeProvider } from "@/ui/app-theme-provider";
export const metadata: Metadata = {
  title: "Judge sheets · Dais",
  manifest: "/j/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Dais", statusBarStyle: "default" },
  icons: { apple: "/j/icon-192.png" },
  robots: { index: false, follow: false },
};
export default function JudgeLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppThemeProvider>
      <main id="main" tabIndex={-1} className="min-h-dvh bg-bg text-text">
        {children}
      </main>
    </AppThemeProvider>
  );
}
