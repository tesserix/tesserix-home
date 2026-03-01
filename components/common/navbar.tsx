"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu, X, ChevronDown, ShoppingBag, ChefHat, Hospital, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const products = [
  {
    name: "Mark8ly",
    description: "Multi-tenant marketplace platform",
    href: "/products/mark8ly",
    icon: ShoppingBag,
  },
  {
    name: "HomeChef",
    description: "Home cooked food delivery",
    href: "/products/homechef",
    icon: ChefHat,
  },
  {
    name: "MediCare",
    description: "Hospital management system",
    href: "/products/medicare",
    icon: Hospital,
  },
  {
    name: "FanZone",
    description: "Cricket live scores & banter",
    href: "/products/fanzone",
    icon: Trophy,
  },
];

const navigation = [
  { name: "About", href: "/about" },
  { name: "Contact", href: "/contact" },
];

export function Navbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [productsOpen, setProductsOpen] = React.useState(false);
  const productsRef = React.useRef<HTMLDivElement>(null);
  const mobileMenuRef = React.useRef<HTMLDivElement>(null);

  // Close products dropdown when clicking outside
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (productsRef.current && !productsRef.current.contains(event.target as Node)) {
        setProductsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Focus trap for mobile menu
  React.useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
      const firstFocusable = mobileMenuRef.current?.querySelector<HTMLElement>(
        'a, button, input, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  // Close mobile menu on escape
  React.useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
        setProductsOpen(false);
      }
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, []);

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm">
      <nav
        className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-8"
        aria-label="Main navigation"
      >
        {/* Logo */}
        <div className="flex lg:flex-1">
          <Link href="/" className="-m-1.5 p-1.5">
            <Image src="/logo.png" alt="Tesserix" width={108} height={32} priority />
          </Link>
        </div>

        {/* Mobile menu button */}
        <div className="flex lg:hidden">
          <button
            type="button"
            className="-m-2.5 inline-flex items-center justify-center rounded-md p-2.5 text-foreground"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-menu"
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          >
            <span className="sr-only">{mobileMenuOpen ? "Close menu" : "Open menu"}</span>
            {mobileMenuOpen ? (
              <X className="h-6 w-6" aria-hidden="true" />
            ) : (
              <Menu className="h-6 w-6" aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Desktop navigation */}
        <div className="hidden lg:flex lg:gap-x-8 lg:items-center">
          {/* Products Mega Menu */}
          <div ref={productsRef} className="relative">
            <button
              type="button"
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setProductsOpen(!productsOpen)}
              aria-expanded={productsOpen}
              aria-haspopup="true"
            >
              Products
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", productsOpen && "rotate-180")}
                aria-hidden="true"
              />
            </button>

            {/* Mega Menu Dropdown */}
            <div
              className={cn(
                "absolute left-1/2 -translate-x-1/2 top-full mt-3 w-[500px] rounded-xl border bg-background p-4 shadow-lg transition-all",
                productsOpen
                  ? "opacity-100 visible translate-y-0"
                  : "opacity-0 invisible -translate-y-2"
              )}
              role="menu"
            >
              <div className="grid grid-cols-2 gap-2">
                {products.map((product) => (
                  <Link
                    key={product.name}
                    href={product.href}
                    className="flex items-start gap-3 rounded-lg p-3 transition-colors hover:bg-muted"
                    onClick={() => setProductsOpen(false)}
                    role="menuitem"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-background">
                      <product.icon className="h-5 w-5 text-foreground" />
                    </div>
                    <div>
                      <span className="font-medium text-foreground">{product.name}</span>
                      <p className="text-sm text-muted-foreground">{product.description}</p>
                    </div>
                  </Link>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t">
                <Link
                  href="/products"
                  className="flex items-center justify-center text-sm font-medium text-foreground hover:text-primary"
                  onClick={() => setProductsOpen(false)}
                >
                  View all products →
                </Link>
              </div>
            </div>
          </div>

          {navigation.map((item) => (
            <Link
              key={item.name}
              href={item.href}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.name}
            </Link>
          ))}
        </div>

        {/* Desktop CTA */}
        <div className="hidden lg:flex lg:flex-1 lg:justify-end lg:gap-x-4">
          <Button variant="ghost" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </nav>

      {/* Mobile menu overlay */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/20 backdrop-blur-sm lg:hidden transition-opacity",
          mobileMenuOpen ? "opacity-100 visible" : "opacity-0 invisible"
        )}
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden="true"
      />

      {/* Mobile menu panel */}
      <div
        id="mobile-menu"
        ref={mobileMenuRef}
        className={cn(
          "fixed top-0 right-0 z-50 h-full w-full max-w-sm bg-background shadow-xl lg:hidden transition-transform duration-300 ease-in-out",
          mobileMenuOpen ? "translate-x-0" : "translate-x-full"
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <Image src="/logo.png" alt="Tesserix" width={108} height={32} />
          <button
            type="button"
            className="-m-2.5 rounded-md p-2.5 text-foreground"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close menu"
          >
            <X className="h-6 w-6" aria-hidden="true" />
          </button>
        </div>

        <div className="px-6 py-6 space-y-6 overflow-y-auto h-[calc(100%-73px)]">
          {/* Products section */}
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Products
            </h3>
            <div className="space-y-1">
              {products.map((product) => (
                <Link
                  key={product.name}
                  href={product.href}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-base font-medium text-foreground hover:bg-muted transition-colors"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <product.icon className="h-5 w-5" aria-hidden="true" />
                  {product.name}
                </Link>
              ))}
            </div>
          </div>

          {/* Other links */}
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Company
            </h3>
            <div className="space-y-1">
              {navigation.map((item) => (
                <Link
                  key={item.name}
                  href={item.href}
                  className="block rounded-lg px-3 py-2.5 text-base font-medium text-foreground hover:bg-muted transition-colors"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {item.name}
                </Link>
              ))}
            </div>
          </div>

          {/* CTA buttons */}
          <div className="pt-6 border-t space-y-3">
            <Button variant="outline" asChild className="w-full">
              <Link href="/login" onClick={() => setMobileMenuOpen(false)}>
                Sign in
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
