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
        {children}
      </main>
    </div>
  );
}
