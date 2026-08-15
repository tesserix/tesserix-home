import { ConsoleSidebar } from "@/components/nav/sidebar";

export default function ConsoleLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-screen">
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex">
        <ConsoleSidebar />
      </div>
      <main id="main-content" className="flex-1 lg:pl-56">
        {/* Every console surface gets the same measure and gutters here rather
            than each page inventing its own. Without this, content sits flush
            against the viewport edge. */}
        {/* Gutters, not a centred measure. An operator console is a dense
            full-width frame; centring a max-width column inside the space left
            by the sidebar reads as off-centre, with dead margin on both sides. */}
        <div className="w-full px-6 py-8 sm:px-8">{children}</div>
      </main>
    </div>
  );
}
