// Wraps every HomeChef admin page in the Live/Test mode context, so the global
// toggle — and the loud banner that comes with it while in Test — applies
// consistently across orders, payouts, analytics, refunds and wallets rather
// than being re-mounted per page.
import { HomechefModeProvider } from "@/components/admin/homechef/mode-toggle";

export default function HomechefAdminLayout({ children }: { children: React.ReactNode }) {
  return <HomechefModeProvider>{children}</HomechefModeProvider>;
}
