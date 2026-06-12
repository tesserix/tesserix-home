"use client";

import { useState } from "react";
import { Mail, Loader2, CheckCircle2 } from "lucide-react";
import {
  Button,
  Input,
  Label,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  AnimateOnScroll,
} from "@tesserix/web";

const expectations = [
  "A reply from a person, usually within one business day",
  "No chatbot queue, no ticket black hole",
  "You'll talk to the people who build the products",
];

export default function ContactPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = (formData: FormData) => {
    const newErrors: Record<string, string> = {};
    const email = formData.get("email") as string;
    const firstName = formData.get("firstName") as string;
    const message = formData.get("message") as string;

    if (!firstName?.trim()) {
      newErrors.firstName = "First name is required";
    }
    if (!email?.trim()) {
      newErrors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = "Please enter a valid email address";
    }
    if (!message?.trim()) {
      newErrors.message = "Message is required";
    }

    return newErrors;
  };

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const validationErrors = validateForm(formData);

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});
    setSubmitError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: formData.get("firstName"),
          lastName: formData.get("lastName"),
          email: formData.get("email"),
          company: formData.get("company"),
          interest: formData.get("interest"),
          message: formData.get("message"),
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? "Something went wrong");
      }

      setSubmitted(true);
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Something went wrong — please try again or email us directly.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div>
      {/* Header */}
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_70%_80%_at_50%_-10%,black,transparent)]"
        />
        <div className="relative mx-auto max-w-7xl px-6 py-16 sm:py-24 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="max-w-2xl">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Contact
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-foreground sm:text-6xl">
              Talk to a human.
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
              Questions about a product, pricing, or whether something is the
              right fit — we read everything and reply ourselves.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* Form & Info */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-x-8 gap-y-16 lg:grid-cols-12">
            {/* Form */}
            <AnimateOnScroll variant="fade-up" className="lg:col-span-7">
              {submitted ? (
                <div className="rounded-2xl border bg-card px-8 py-16 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
                    <CheckCircle2
                      className="h-6 w-6 text-success"
                      aria-hidden="true"
                    />
                  </div>
                  <h2 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">
                    Thank you!
                  </h2>
                  <p className="mt-3 text-muted-foreground">
                    We&apos;ve received your message and will be in touch soon.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-6" noValidate>
                  <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="firstName">
                        First name <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="firstName"
                        name="firstName"
                        aria-required="true"
                        aria-invalid={!!errors.firstName}
                        aria-describedby={
                          errors.firstName ? "firstName-error" : undefined
                        }
                        className={errors.firstName ? "border-destructive" : ""}
                      />
                      {errors.firstName && (
                        <p
                          id="firstName-error"
                          className="text-sm text-destructive"
                        >
                          {errors.firstName}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="lastName">Last name</Label>
                      <Input id="lastName" name="lastName" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email">
                      Email <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      aria-required="true"
                      aria-invalid={!!errors.email}
                      aria-describedby={errors.email ? "email-error" : undefined}
                      className={errors.email ? "border-destructive" : ""}
                    />
                    {errors.email && (
                      <p id="email-error" className="text-sm text-destructive">
                        {errors.email}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="company">Company</Label>
                    <Input id="company" name="company" />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="interest">I&apos;m interested in</Label>
                    <Select name="interest">
                      <SelectTrigger id="interest">
                        <SelectValue placeholder="Select a product" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mark8ly">Mark8ly</SelectItem>
                        <SelectItem value="fanzone">FanZone</SelectItem>
                        <SelectItem value="medicare">MediCare</SelectItem>
                        <SelectItem value="homechef">HomeChef</SelectItem>
                        <SelectItem value="other">
                          Other / General inquiry
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="message">
                      Message <span className="text-destructive">*</span>
                    </Label>
                    <Textarea
                      id="message"
                      name="message"
                      rows={5}
                      placeholder="Tell us about your needs..."
                      aria-required="true"
                      aria-invalid={!!errors.message}
                      aria-describedby={
                        errors.message ? "message-error" : undefined
                      }
                      className={errors.message ? "border-destructive" : ""}
                    />
                    {errors.message && (
                      <p id="message-error" className="text-sm text-destructive">
                        {errors.message}
                      </p>
                    )}
                  </div>

                  {submitError && (
                    <p role="alert" className="text-sm text-destructive">
                      {submitError}
                    </p>
                  )}

                  <Button type="submit" size="lg" disabled={isSubmitting}>
                    {isSubmitting && (
                      <Loader2
                        className="mr-2 h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                    )}
                    {isSubmitting ? "Sending..." : "Send message"}
                  </Button>
                </form>
              )}
            </AnimateOnScroll>

            {/* Sidebar */}
            <AnimateOnScroll
              variant="fade-up"
              delay={0.1}
              className="lg:col-span-4 lg:col-start-9"
            >
              <div className="border-t pt-8">
                <h2 className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Prefer email?
                </h2>
                <a
                  href="mailto:sales@tesserix.app"
                  className="mt-4 inline-flex items-center gap-2 font-mono text-base text-foreground underline-offset-4 transition-colors hover:underline"
                >
                  <Mail className="h-4 w-4" aria-hidden="true" />
                  sales@tesserix.app
                </a>
              </div>

              <div className="mt-12 border-t pt-8">
                <h2 className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  What to expect
                </h2>
                <ul className="mt-5 space-y-4">
                  {expectations.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground"
                    >
                      <span
                        className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60"
                        aria-hidden="true"
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </AnimateOnScroll>
          </div>
        </div>
      </section>
    </div>
  );
}
