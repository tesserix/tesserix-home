"use client";

import { useState, useCallback, KeyboardEvent } from "react";
import {
  Check,
  ChevronRight,
  Database,
  GitPullRequest,
  HardDrive,
  Loader2,
  Package,
  Radio,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Switch,
} from "@tesserix/web";
import {
  SERVICE_REGISTRY,
  type AppGroup,
  type MigrationStrategy,
  type ServiceLang,
  type ServiceType,
} from "@/lib/releases/services";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WizardForm {
  // Step 1 – Basics
  name: string;
  displayName: string;
  appGroup: AppGroup | "";
  type: ServiceType | "";
  lang: ServiceLang | "";
  // Step 2 – Infrastructure
  hasDb: boolean;
  migration: MigrationStrategy;
  usesGoShared: boolean;
  sidecar: "cloud-sql-proxy" | "none";
  publishesEvents: boolean;
  pubsubTopic: string;
  // Step 3 – Dependencies
  invokes: string[];
  secrets: string[];
  storageApps: string[];
}

const INITIAL_FORM: WizardForm = {
  name: "",
  displayName: "",
  appGroup: "",
  type: "",
  lang: "",
  hasDb: false,
  migration: "none",
  usesGoShared: false,
  sidecar: "none",
  publishesEvents: false,
  pubsubTopic: "",
  invokes: [],
  secrets: [],
  storageApps: [],
};

interface AddServiceWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

const STEPS = [
  { label: "Basics" },
  { label: "Infrastructure" },
  { label: "Dependencies" },
  { label: "Review" },
];

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((step, idx) => {
        const done = idx < current;
        const active = idx === current;
        return (
          <div key={idx} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div
                className={[
                  "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                  done
                    ? "bg-primary text-primary-foreground"
                    : active
                    ? "bg-primary/20 border border-primary text-primary"
                    : "bg-muted text-muted-foreground",
                ].join(" ")}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : idx + 1}
              </div>
              <span
                className={[
                  "text-[10px] font-medium",
                  active ? "text-foreground" : "text-muted-foreground",
                ].join(" ")}
              >
                {step.label}
              </span>
            </div>
            {idx < STEPS.length - 1 && (
              <div
                className={[
                  "mb-4 mx-2 h-px w-10 transition-colors",
                  done ? "bg-primary" : "bg-border",
                ].join(" ")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tag input (secrets / storage apps)
// ---------------------------------------------------------------------------

function TagInput({
  id,
  placeholder,
  tags,
  onChange,
}: {
  id: string;
  placeholder: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [inputValue, setInputValue] = useState("");

  const addTag = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed && !tags.includes(trimmed)) {
        onChange([...tags, trimmed]);
      }
      setInputValue("");
    },
    [tags, onChange]
  );

  const removeTag = useCallback(
    (tag: string) => {
      onChange(tags.filter((t) => t !== tag));
    },
    [tags, onChange]
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === "Backspace" && !inputValue && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 min-h-0">
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="font-mono text-xs gap-1 pr-1"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="ml-0.5 hover:text-destructive transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        id={id}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => addTag(inputValue)}
        placeholder={placeholder}
        className="h-9 font-mono text-sm"
      />
      <p className="text-[11px] text-muted-foreground">
        Press Enter or comma to add. Backspace to remove last.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-select chips for "Invokes"
// ---------------------------------------------------------------------------

function InvokesSelector({
  selected,
  currentName,
  onChange,
}: {
  selected: string[];
  currentName: string;
  onChange: (names: string[]) => void;
}) {
  const [search, setSearch] = useState("");

  const allNames = SERVICE_REGISTRY.map((s) => s.name).filter(
    (n) => n !== currentName
  );

  const filtered = search
    ? allNames.filter((n) => n.toLowerCase().includes(search.toLowerCase()))
    : allNames;

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((name) => (
            <Badge
              key={name}
              variant="secondary"
              className="font-mono text-xs gap-1 pr-1"
            >
              {name}
              <button
                type="button"
                onClick={() => toggle(name)}
                className="ml-0.5 hover:text-destructive transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        placeholder="Search services..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-9"
      />
      <div className="max-h-48 overflow-y-auto rounded-md border divide-y divide-border">
        {filtered.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            No services found
          </p>
        ) : (
          filtered.map((name) => {
            const checked = selected.includes(name);
            return (
              <label
                key={name}
                className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
              >
                <Checkbox
                  checked={checked}
                  onChange={() => toggle(name)}
                  className="shrink-0"
                />
                <span className="font-mono text-xs">{name}</span>
                {checked && (
                  <Check className="ml-auto h-3 w-3 text-primary shrink-0" />
                )}
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// YAML preview
// ---------------------------------------------------------------------------

function buildYaml(form: WizardForm): string {
  const lines: string[] = [];
  lines.push(`- name: ${form.name}`);
  lines.push(`  displayName: ${form.displayName}`);
  lines.push(`  appGroup: ${form.appGroup}`);
  lines.push(`  type: ${form.type}`);
  lines.push(`  lang: ${form.lang}`);
  lines.push(`  repo: tesserix/${form.name}`);
  lines.push(`  buildWorkflow: ci.yml`);
  lines.push(`  releaseWorkflow: release.yml`);
  lines.push(`  hasDb: ${form.hasDb}`);
  if (form.hasDb) {
    lines.push(`  migration: ${form.migration}`);
  }
  lines.push(`  usesGoShared: ${form.usesGoShared}`);
  lines.push(`  sidecar: ${form.sidecar}`);
  lines.push(`  publishesEvents: ${form.publishesEvents}`);
  if (form.publishesEvents && form.pubsubTopic) {
    lines.push(`  pubsubTopic: ${form.pubsubTopic}`);
  }
  if (form.invokes.length > 0) {
    lines.push(`  invokes:`);
    form.invokes.forEach((n) => lines.push(`    - ${n}`));
  } else {
    lines.push(`  invokes: []`);
  }
  if (form.secrets.length > 0) {
    lines.push(`  secrets:`);
    form.secrets.forEach((s) => lines.push(`    - ${s}`));
  } else {
    lines.push(`  secrets: []`);
  }
  if (form.storageApps.length > 0) {
    lines.push(`  storageApps:`);
    form.storageApps.forEach((a) => lines.push(`    - ${a}`));
  } else {
    lines.push(`  storageApps: []`);
  }
  lines.push(`  managed: true`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Review summary row helper
// ---------------------------------------------------------------------------

function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between py-2 text-sm">
      <span className="text-muted-foreground shrink-0 mr-4">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Basics
// ---------------------------------------------------------------------------

function toKebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-");
}

function Step1({
  form,
  onChange,
  nameError,
}: {
  form: WizardForm;
  onChange: (patch: Partial<WizardForm>) => void;
  nameError: string;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="displayName">Display name</Label>
        <Input
          id="displayName"
          placeholder="My New Service"
          value={form.displayName}
          onChange={(e) => {
            const displayName = e.target.value;
            onChange({
              displayName,
              name: toKebab(displayName),
            });
          }}
          className="h-9"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="name">
          Service name{" "}
          <span className="text-muted-foreground font-normal text-xs">
            (kebab-case, auto-derived)
          </span>
        </Label>
        <Input
          id="name"
          placeholder="my-new-service"
          value={form.name}
          onChange={(e) => onChange({ name: toKebab(e.target.value) })}
          className={["h-9 font-mono", nameError ? "border-destructive" : ""].join(" ")}
        />
        {nameError ? (
          <p className="text-xs text-destructive">{nameError}</p>
        ) : form.name ? (
          <p className="text-xs text-muted-foreground">
            Repo: <span className="font-mono">tesserix/{form.name}</span>
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>App group</Label>
          <Select
            value={form.appGroup}
            onValueChange={(v) => onChange({ appGroup: v as AppGroup })}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select group" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="platform">Platform</SelectItem>
              <SelectItem value="mark8ly">Marketplace (mark8ly)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select
            value={form.type}
            onValueChange={(v) => {
              const type = v as ServiceType;
              const patch: Partial<WizardForm> = { type };
              if (type === "frontend") {
                patch.lang = "nextjs";
                patch.hasDb = false;
                patch.usesGoShared = false;
              }
              onChange(patch);
            }}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="backend">Backend</SelectItem>
              <SelectItem value="frontend">Frontend</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Language</Label>
        <Select
          value={form.lang}
          onValueChange={(v) => {
            const lang = v as ServiceLang;
            const patch: Partial<WizardForm> = { lang };
            if (lang === "nextjs") {
              patch.usesGoShared = false;
            }
            onChange(patch);
          }}
        >
          <SelectTrigger className="h-9">
            <SelectValue placeholder="Select language" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="go">Go</SelectItem>
            <SelectItem value="nextjs">Next.js</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Infrastructure
// ---------------------------------------------------------------------------

function Step2({
  form,
  onChange,
}: {
  form: WizardForm;
  onChange: (patch: Partial<WizardForm>) => void;
}) {
  return (
    <div className="space-y-5">
      {/* Has DB */}
      <div className="flex items-center justify-between rounded-lg border px-4 py-3">
        <div className="space-y-0.5">
          <Label className="text-sm cursor-pointer">Has database</Label>
          <p className="text-xs text-muted-foreground">
            Provisions a Cloud SQL instance for this service
          </p>
        </div>
        <Switch
          checked={form.hasDb}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const checked = e.target.checked;
            const patch: Partial<WizardForm> = {
              hasDb: checked,
              sidecar: checked ? "cloud-sql-proxy" : "none",
            };
            if (!checked) patch.migration = "none";
            onChange(patch);
          }}
        />
      </div>

      {form.hasDb && (
        <div className="pl-4 border-l-2 border-primary/30 space-y-4">
          <div className="space-y-1.5">
            <Label>Migration strategy</Label>
            <Select
              value={form.migration}
              onValueChange={(v) =>
                onChange({ migration: v as MigrationStrategy })
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="golang-migrate">golang-migrate</SelectItem>
                <SelectItem value="gorm-auto">gorm-auto</SelectItem>
                <SelectItem value="none">none</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-md bg-muted px-3 py-2 flex items-center gap-2">
            <Database className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground">
              Database name preview:{" "}
              <span className="font-mono text-foreground">
                {form.name || "<service-name>"}_db
              </span>
            </span>
          </div>
        </div>
      )}

      <Separator />

      {/* Sidecar */}
      <div className="space-y-1.5">
        <Label>Sidecar</Label>
        <Select
          value={form.sidecar}
          onValueChange={(v) =>
            onChange({ sidecar: v as "cloud-sql-proxy" | "none" })
          }
          disabled={form.hasDb}
        >
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cloud-sql-proxy">cloud-sql-proxy</SelectItem>
            <SelectItem value="none">none</SelectItem>
          </SelectContent>
        </Select>
        {form.hasDb && (
          <p className="text-xs text-muted-foreground">
            Auto-set to cloud-sql-proxy when database is enabled.
          </p>
        )}
      </div>

      <Separator />

      {/* go-shared (only for Go) */}
      {form.lang === "go" && (
        <>
          <div className="flex items-center justify-between rounded-lg border px-4 py-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-violet-400" />
                <Label className="text-sm cursor-pointer">Uses go-shared</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Adds go-shared as a dependency and triggers auto-updates
              </p>
            </div>
            <Switch
              checked={form.usesGoShared}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ usesGoShared: e.target.checked })}
            />
          </div>
          <Separator />
        </>
      )}

      {/* Publishes events */}
      <div className="flex items-center justify-between rounded-lg border px-4 py-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-teal-400" />
            <Label className="text-sm cursor-pointer">Publishes events</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Creates a Pub/Sub topic for outbound events
          </p>
        </div>
        <Switch
          checked={form.publishesEvents}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            onChange({ publishesEvents: e.target.checked, pubsubTopic: "" });
          }}
        />
      </div>

      {form.publishesEvents && (
        <div className="pl-4 border-l-2 border-teal-500/30 space-y-1.5">
          <Label htmlFor="pubsubTopic">Pub/Sub topic name</Label>
          <Input
            id="pubsubTopic"
            placeholder="tesserix-my-service-events"
            value={form.pubsubTopic}
            onChange={(e) => onChange({ pubsubTopic: e.target.value })}
            className="h-9 font-mono text-sm"
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Dependencies
// ---------------------------------------------------------------------------

function Step3({
  form,
  onChange,
}: {
  form: WizardForm;
  onChange: (patch: Partial<WizardForm>) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-sm font-medium">Invokes</Label>
        <p className="text-xs text-muted-foreground">
          Services this service makes outbound calls to.
        </p>
        <InvokesSelector
          selected={form.invokes}
          currentName={form.name}
          onChange={(invokes) => onChange({ invokes })}
        />
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-sm font-medium">Secrets</Label>
        <p className="text-xs text-muted-foreground">
          GCP Secret Manager secrets this service needs.
        </p>
        <TagInput
          id="secrets"
          placeholder="my-service-db-password"
          tags={form.secrets}
          onChange={(secrets) => onChange({ secrets })}
        />
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-sm font-medium">Storage apps</Label>
        <p className="text-xs text-muted-foreground">
          GCS bucket app prefixes this service requires access to.
        </p>
        <TagInput
          id="storageApps"
          placeholder="platform"
          tags={form.storageApps}
          onChange={(storageApps) => onChange({ storageApps })}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Review
// ---------------------------------------------------------------------------

function Step4({
  form,
  onSubmit,
  isSubmitting,
}: {
  form: WizardForm;
  onSubmit: () => void;
  isSubmitting: boolean;
}) {
  const yaml = buildYaml(form);

  return (
    <div className="space-y-5">
      {/* Summary card */}
      <div>
        <h3 className="text-sm font-semibold mb-2">Service summary</h3>
        <Card>
          <CardContent className="p-4 divide-y divide-border">
            <SummaryRow label="Name">
              <span className="font-mono text-xs">{form.name}</span>
            </SummaryRow>
            <SummaryRow label="Display name">{form.displayName}</SummaryRow>
            <SummaryRow label="App group">
              <Badge variant="secondary" className="text-xs">
                {form.appGroup}
              </Badge>
            </SummaryRow>
            <SummaryRow label="Type / Language">
              <div className="flex items-center gap-1.5 justify-end">
                <Badge variant="outline" className="text-xs">
                  {form.type}
                </Badge>
                <Badge
                  variant="secondary"
                  className={
                    form.lang === "go"
                      ? "bg-zinc-600/20 text-zinc-300 text-xs"
                      : "bg-blue-500/15 text-blue-400 text-xs"
                  }
                >
                  {form.lang === "go" ? "Go" : "Next.js"}
                </Badge>
              </div>
            </SummaryRow>
            <SummaryRow label="Database">
              {form.hasDb ? (
                <div className="flex items-center gap-1.5">
                  <Database className="h-3.5 w-3.5 text-blue-400" />
                  <span className="text-xs">
                    Yes &mdash;{" "}
                    <span className="font-mono">{form.migration}</span>
                  </span>
                </div>
              ) : (
                <span className="text-muted-foreground text-xs">None</span>
              )}
            </SummaryRow>
            <SummaryRow label="Sidecar">
              {form.sidecar === "cloud-sql-proxy" ? (
                <div className="flex items-center gap-1.5">
                  <HardDrive className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-xs">Cloud SQL Proxy</span>
                </div>
              ) : (
                <span className="text-muted-foreground text-xs">None</span>
              )}
            </SummaryRow>
            {form.lang === "go" && (
              <SummaryRow label="go-shared">
                {form.usesGoShared ? (
                  <div className="flex items-center gap-1.5">
                    <Package className="h-3.5 w-3.5 text-violet-400" />
                    <span className="text-xs">Consumer</span>
                  </div>
                ) : (
                  <span className="text-muted-foreground text-xs">No</span>
                )}
              </SummaryRow>
            )}
            <SummaryRow label="Pub/Sub">
              {form.publishesEvents ? (
                <div className="flex items-center gap-1.5">
                  <Radio className="h-3.5 w-3.5 text-teal-400" />
                  <span className="font-mono text-xs">{form.pubsubTopic || "—"}</span>
                </div>
              ) : (
                <span className="text-muted-foreground text-xs">None</span>
              )}
            </SummaryRow>
            {form.invokes.length > 0 && (
              <SummaryRow label="Invokes">
                <div className="flex flex-wrap gap-1 justify-end max-w-[260px]">
                  {form.invokes.map((n) => (
                    <Badge key={n} variant="outline" className="font-mono text-xs">
                      {n}
                    </Badge>
                  ))}
                </div>
              </SummaryRow>
            )}
            {form.secrets.length > 0 && (
              <SummaryRow label="Secrets">
                <div className="flex flex-wrap gap-1 justify-end max-w-[260px]">
                  {form.secrets.map((s) => (
                    <Badge key={s} variant="outline" className="font-mono text-xs">
                      {s}
                    </Badge>
                  ))}
                </div>
              </SummaryRow>
            )}
            {form.storageApps.length > 0 && (
              <SummaryRow label="Storage apps">
                <div className="flex flex-wrap gap-1 justify-end">
                  {form.storageApps.map((a) => (
                    <Badge key={a} variant="secondary" className="text-xs">
                      {a}
                    </Badge>
                  ))}
                </div>
              </SummaryRow>
            )}
          </CardContent>
        </Card>
      </div>

      {/* YAML preview */}
      <div>
        <h3 className="text-sm font-semibold mb-2">YAML preview</h3>
        <div className="rounded-md border bg-muted/40 p-4 overflow-x-auto">
          <pre className="text-xs font-mono text-foreground/80 whitespace-pre leading-relaxed">
            {yaml}
          </pre>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5">
          This block will be appended to{" "}
          <span className="font-mono">tesserix-infra/services.yaml</span> in a
          new branch and PR.
        </p>
      </div>

      {/* Create PR button */}
      <Button
        className="w-full gap-2"
        onClick={onSubmit}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Creating PR...
          </>
        ) : (
          <>
            <GitPullRequest className="h-4 w-4" />
            Create PR
          </>
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

function getNameError(name: string): string {
  if (!name) return "";
  const exists = SERVICE_REGISTRY.some((s) => s.name === name);
  if (exists) return `"${name}" already exists in the service registry.`;
  return "";
}

function isStep1Valid(form: WizardForm, nameError: string): boolean {
  return (
    !!form.name &&
    !!form.displayName &&
    !!form.appGroup &&
    !!form.type &&
    !!form.lang &&
    !nameError
  );
}

function isStep2Valid(form: WizardForm): boolean {
  if (form.publishesEvents && !form.pubsubTopic.trim()) return false;
  return true;
}

export function AddServiceWizard({
  open,
  onOpenChange,
  onSuccess,
}: AddServiceWizardProps) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<WizardForm>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const nameError = getNameError(form.name);

  const handleChange = useCallback((patch: Partial<WizardForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Reset on close
      setStep(0);
      setForm(INITIAL_FORM);
      setSubmitError(null);
    }
    onOpenChange(open);
  };

  const canAdvance =
    step === 0
      ? isStep1Valid(form, nameError)
      : step === 1
      ? isStep2Valid(form)
      : true;

  const handleNext = () => {
    if (step < STEPS.length - 1 && canAdvance) {
      setStep((s) => s + 1);
    }
  };

  const handleBack = () => {
    if (step > 0) setStep((s) => s - 1);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/releases/registry/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      const data = (await res.json()) as { prUrl: string };
      handleOpenChange(false);
      onSuccess();
      // Open PR in new tab if available
      if (data.prUrl) {
        window.open(data.prUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create PR");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="w-full sm:max-w-[640px] flex flex-col overflow-hidden p-0">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b space-y-4 shrink-0">
          <SheetHeader>
            <SheetTitle>Add service</SheetTitle>
            <SheetDescription>
              Define a new service. This will open a PR in the{" "}
              <span className="font-mono">tesserix-infra</span> repo to register
              it.
            </SheetDescription>
          </SheetHeader>
          <StepIndicator current={step} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && (
            <Step1 form={form} onChange={handleChange} nameError={nameError} />
          )}
          {step === 1 && <Step2 form={form} onChange={handleChange} />}
          {step === 2 && <Step3 form={form} onChange={handleChange} />}
          {step === 3 && (
            <Step4
              form={form}
              onSubmit={handleSubmit}
              isSubmitting={isSubmitting}
            />
          )}

          {submitError && (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3">
              <p className="text-xs text-destructive">{submitError}</p>
            </div>
          )}
        </div>

        {/* Footer navigation */}
        {step < STEPS.length - 1 && (
          <div className="px-6 py-4 border-t flex items-center justify-between shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={handleBack}
              disabled={step === 0}
            >
              Back
            </Button>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                Step {step + 1} of {STEPS.length}
              </span>
              <Button
                size="sm"
                onClick={handleNext}
                disabled={!canAdvance}
                className="gap-1.5"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        {step === STEPS.length - 1 && (
          <div className="px-6 py-4 border-t flex items-center shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={handleBack}
              disabled={isSubmitting}
            >
              Back
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
