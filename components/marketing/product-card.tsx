import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProductCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  status: "available" | "coming-soon";
  featured?: boolean;
}

export function ProductCard({
  title,
  description,
  icon,
  href,
  status,
  featured = false,
}: ProductCardProps) {
  const isComingSoon = status === "coming-soon";

  return (
    <div
      className={cn(
        "group relative rounded-lg border p-6 transition-colors hover:border-foreground/20",
        featured && "border-foreground/20",
        isComingSoon && "opacity-60"
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-background">
          {icon}
        </div>
        <div>
          <h3 className="font-medium text-foreground">{title}</h3>
          {isComingSoon && (
            <span className="text-xs text-muted-foreground">Coming soon</span>
          )}
        </div>
      </div>

      <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
        {description}
      </p>

      {!isComingSoon && (
        <Link
          href={href}
          className="mt-4 inline-flex items-center text-sm font-medium text-foreground hover:underline"
        >
          Learn more
          <ArrowRight className="ml-1 h-3 w-3" />
        </Link>
      )}
    </div>
  );
}
