import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Console",
    template: "%s | Console",
  },
  description: "Tesserix console.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 bg-background border rounded-lg px-4 py-2 z-[100] font-medium"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
