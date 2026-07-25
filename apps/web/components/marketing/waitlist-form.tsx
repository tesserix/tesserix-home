"use client";

// WaitlistForm — the "Get notified when we launch" capture on a coming-soon
// product page.
//
// This used to be a link to /contact, which meant the click was never recorded
// and there was no list to mail on launch day. It's now an inline form: the
// button reveals a single email field rather than navigating away, because
// sending someone to a general contact form to express one specific interest
// loses most of them.

import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Button, Input } from "@tesserix/web";

interface WaitlistFormProps {
  /** Product slug — the list this signup joins. */
  readonly slug: string;
  /** Product title, for the confirmation copy. */
  readonly title: string;
}

type Status = "idle" | "open" | "submitting" | "done";

export function WaitlistForm({ slug, title }: WaitlistFormProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmed = email.trim();
    // Cheap client-side check purely for instant feedback; the API validates
    // properly and is the actual gate.
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productSlug: slug, email: trimmed }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? "Something went wrong. Please try again.");
        setStatus("open");
        return;
      }

      setStatus("done");
    } catch {
      setError("Couldn't reach us just now. Please try again.");
      setStatus("open");
    }
  }

  if (status === "done") {
    return (
      <div
        className="flex items-center gap-2 text-sm text-foreground"
        role="status"
      >
        <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          You&apos;re on the list. We&apos;ll email you the day {title} goes
          live.
        </span>
      </div>
    );
  }

  if (status === "idle") {
    return (
      <Button size="lg" onClick={() => setStatus("open")}>
        Get notified when we launch
        <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
      </Button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex w-full max-w-md flex-col gap-2"
      noValidate
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="waitlist-email"
          name="email"
          type="email"
          autoComplete="email"
          // The field appears on click, so focusing it saves a second tap.
          autoFocus
          placeholder="you@company.com"
          aria-label={`Email address for ${title} launch notifications`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "waitlist-error" : undefined}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === "submitting"}
          className="sm:flex-1"
        />
        <Button type="submit" size="lg" disabled={status === "submitting"}>
          {status === "submitting" ? "Adding you…" : "Notify me"}
        </Button>
      </div>

      {error ? (
        <p id="waitlist-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          One email, on launch day. Nothing else.
        </p>
      )}
    </form>
  );
}
