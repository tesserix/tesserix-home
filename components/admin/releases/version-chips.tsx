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
        <button
          key={s.label}
          type="button"
          onClick={() => onSelect(s.version)}
          className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <span>{s.label}</span>
          <span className="font-mono">{s.version}</span>
        </button>
      ))}
    </div>
  );
}
