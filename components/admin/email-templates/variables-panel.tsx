"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { type CategoryConfig } from "@/lib/api/email-template-categories";
import { Card, CardContent, CardHeader, CardTitle, Button } from "@tesserix/web";

interface VariablesPanelProps {
  category: CategoryConfig | undefined;
  compact?: boolean;
}

export function VariablesPanel({ category, compact = false }: VariablesPanelProps) {
  const [copiedVar, setCopiedVar] = useState<string | null>(null);

  if (!category || category.variables.length === 0) {
    return null;
  }

  function handleCopy(varName: string) {
    navigator.clipboard.writeText(`{{${varName}}}`);
    setCopiedVar(varName);
    setTimeout(() => setCopiedVar(null), 1500);
  }

  if (compact) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {category.variables.map((v) => (
          <Button
            key={v.name}
            variant="outline"
            size="sm"
            onClick={() => handleCopy(v.name)}
            className="h-7 gap-1 px-2 text-xs font-mono"
            title={`${v.description} — Click to copy`}
          >
            {copiedVar === v.name ? (
              <Check className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground" />
            )}
            {`{{${v.name}}}`}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Variables</CardTitle>
        <p className="text-xs text-muted-foreground">
          Click to copy. Available for {category.label} templates.
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {category.variables.map((v) => (
            <Button
              key={v.name}
              variant="ghost"
              onClick={() => handleCopy(v.name)}
              className="h-auto w-full items-start justify-start gap-2 rounded-md p-2 text-left"
            >
              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                {copiedVar === v.name ? (
                  <span className="text-success">Copied!</span>
                ) : (
                  `{{${v.name}}}`
                )}
              </code>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{v.description}</p>
                <p className="text-[10px] text-muted-foreground/70">e.g. {v.example}</p>
              </div>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
