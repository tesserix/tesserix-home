"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type CategoryConfig } from "@/lib/api/email-template-categories";

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
          <button
            key={v.name}
            onClick={() => handleCopy(v.name)}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-mono hover:bg-muted transition-colors"
            title={`${v.description} — Click to copy`}
          >
            {copiedVar === v.name ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground" />
            )}
            {`{{${v.name}}}`}
          </button>
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
            <button
              key={v.name}
              onClick={() => handleCopy(v.name)}
              className="flex w-full items-start gap-2 rounded-md p-2 text-left hover:bg-muted transition-colors"
            >
              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                {copiedVar === v.name ? (
                  <span className="text-green-500">Copied!</span>
                ) : (
                  `{{${v.name}}}`
                )}
              </code>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{v.description}</p>
                <p className="text-[10px] text-muted-foreground/70">e.g. {v.example}</p>
              </div>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
