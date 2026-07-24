"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";

export type TimeWindow = "1h" | "24h" | "7d" | "30d";

const OPTIONS: ReadonlyArray<{ value: TimeWindow; label: string }> = [
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
];

interface TimeWindowPickerProps {
  value: TimeWindow;
  onChange: (next: TimeWindow) => void;
  disabled?: boolean;
}

export function TimeWindowPicker({ value, onChange, disabled }: TimeWindowPickerProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TimeWindow)} disabled={disabled}>
      <SelectTrigger className="h-8 w-32 text-xs" aria-label="Time window">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
