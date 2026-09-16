import { SiteFooter, SiteHeader } from "./site-chrome";
import { AppThemeProvider } from "@/ui/app-theme-provider";

/**
 * The public site (landing page, design gallery). It owns the page's
 * landmarks: the site header and footer sit beside <main>, not inside it, so
 * assistive technology lists banner, navigation, main and contentinfo.
 *
 * This layout reads no request data, so the pages under it are prerendered.
 */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <AppThemeProvider>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        {children}
      </main>
      <SiteFooter />
    </AppThemeProvider>
  );
}
