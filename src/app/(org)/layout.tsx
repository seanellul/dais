import { cookies, headers } from "next/headers";
import { AppThemeProvider } from "@/ui/app-theme-provider";
import { organiserIdentity } from "@/server/organiser-queries";
import { ColourThemeScope, readColourThemeFromCookies } from "@/ui";
import { OrganiserShell } from "@/organiser/shell";
import "@/organiser/organiser.css";
export default async function Layout({ children }: { children: React.ReactNode }) {
  const current = await organiserIdentity();
  return (
    <AppThemeProvider nonce={(await headers()).get("x-nonce") ?? undefined}>
      <ColourThemeScope theme={readColourThemeFromCookies(await cookies())}>
        <OrganiserShell name={current.user.name}>{children}</OrganiserShell>
      </ColourThemeScope>
    </AppThemeProvider>
  );
}
