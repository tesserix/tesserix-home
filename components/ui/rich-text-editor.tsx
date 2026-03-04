"use client";

import { RichTextEditor as DsRichTextEditor } from "@tesserix/web";
import { cn } from "@/lib/utils";

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  minHeight?: string;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = "Start writing...",
  className,
  minHeight = "300px",
}: RichTextEditorProps) {
  return (
    <div className={cn("rounded-lg", className)} style={{ minHeight }}>
      <DsRichTextEditor
        value={value}
        onValueChange={onChange}
        placeholder={placeholder}
        className="h-full"
      />
    </div>
  );
}
