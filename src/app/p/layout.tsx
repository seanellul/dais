import { headers } from "next/headers";
import { AppThemeProvider } from "@/ui/app-theme-provider";
export default async function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AppThemeProvider nonce={(await headers()).get("x-nonce") ?? undefined}>
      {children}
    </AppThemeProvider>
  );
}
