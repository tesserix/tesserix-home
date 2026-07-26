"use client";

// Who may see test-mode kitchens.
//
// Sandbox kitchens live on production alongside real ones. This allowlist is
// the only thing standing between a real customer and a fake kitchen, so it is
// an explicit list of addresses — no wildcards, no domain matching, no "all
// admins" shortcut. An empty list is a legitimate choice: it means no customer
// account can see a sandbox kitchen at all.

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Button } from "@tesserix/web";

import { hcAdmin, swrFetcher } from "@/lib/products/homechef/client";

interface TestModePolicy {
  viewerEmails: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function TestModeViewersSection() {
  const { data, isLoading, mutate } = useSWR<TestModePolicy>(["/test-mode-policy"], swrFetcher);

  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setEmails(data.viewerEmails ?? []);
  }, [data]);

  function add() {
    const e = draft.trim().toLowerCase();
    if (!e) return;
    if (!EMAIL_RE.test(e)) {
      setError("That doesn't look like an email address.");
      return;
    }
    if (emails.some((x) => x.toLowerCase() === e)) {
      setError("That address is already on the list.");
      return;
    }
    setError(null);
    setEmails([...emails, e]);
    setDraft("");
  }

  async function save() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await hcAdmin.put("/test-mode-policy", { viewerEmails: emails });
      await mutate();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the allowlist.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border p-6">
      <div>
        <h2 className="text-base font-semibold">Test-mode viewers</h2>
        <p className="text-sm text-muted-foreground">
          Only these accounts can see or order from kitchens marked as Test. Everyone else — and
          every logged-out visitor — never sees them at all.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <ul className="space-y-1">
            {emails.length === 0 ? (
              <li className="text-sm text-muted-foreground">
                No one can see test kitchens right now.
              </li>
            ) : (
              emails.map((e) => (
                <li
                  key={e}
                  className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
                >
                  <span className="font-mono text-xs">{e}</span>
                  <button
                    type="button"
                    onClick={() => setEmails(emails.filter((x) => x !== e))}
                    className="text-xs text-muted-foreground hover:text-red-600"
                  >
                    Remove
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  add();
                }
              }}
              placeholder="name@example.com"
              className="flex-1 rounded-md border px-3 py-1.5 text-sm"
            />
            <Button size="sm" variant="outline" onClick={add}>
              Add
            </Button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {saved && <p className="text-sm text-green-600">Allowlist saved.</p>}

          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save allowlist"}
          </Button>
        </>
      )}
    </section>
  );
}
