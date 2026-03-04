"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, Badge, Button } from "@tesserix/web";
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
    <Card
      className={cn(
        "group relative transition-colors hover:border-foreground/20",
        featured && "border-foreground/20",
        isComingSoon && "opacity-60"
      )}
    >
      <CardContent className="p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-background">
            {icon}
          </div>
          <div>
            <h3 className="font-medium text-foreground">{title}</h3>
            {isComingSoon && (
              <Badge variant="secondary" className="mt-1 text-[10px] uppercase tracking-wide">
                Coming soon
              </Badge>
            )}
          </div>
        </div>

        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
          {description}
        </p>

        {!isComingSoon && (
          <Button asChild variant="link" className="mt-3 h-auto px-0">
            <Link href={href}>
              Learn more
              <ArrowRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
