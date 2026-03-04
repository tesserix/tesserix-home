import { Badge, Button } from "@tesserix/web";

interface VersionChipsProps {
  currentVersion: string | null;
  onSelect: (version: string) => void;
}

function bumpVersion(
  version: string,
  type: "patch" | "minor" | "major"
): string {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return version;
  const [major, minor, patch] = parts;
  switch (type) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
  }
}

export function VersionChips({ currentVersion, onSelect }: VersionChipsProps) {
  if (!currentVersion || !/^\d+\.\d+\.\d+$/.test(currentVersion)) return null;

  const suggestions = [
    { label: "Patch", version: bumpVersion(currentVersion, "patch") },
    { label: "Minor", version: bumpVersion(currentVersion, "minor") },
    { label: "Major", version: bumpVersion(currentVersion, "major") },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {suggestions.map((s) => (
        <Button
          key={s.label}
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onSelect(s.version)}
          className="h-7 gap-1.5 rounded-full px-3 text-xs"
        >
          <span>{s.label}</span>
          <Badge variant="secondary" className="font-mono text-[10px]">
            {s.version}
          </Badge>
        </Button>
      ))}
    </div>
  );
}
