"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddressLookup } from "./address-lookup";
import { questionnaireClientId } from "./client-id";
import { type Country } from "@tesserix/questionnaires/locations";
import { QuestionnaireBrand } from "./brand";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  forms,
  label,
  submissionSchema,
  type FormId,
} from "@tesserix/questionnaires";

type Props = { form: FormId; countries: Country[] };
export function Survey(props: Props) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <SurveyForm {...props} />
    </QueryClientProvider>
  );
}
function SurveyForm({ form, countries }: Props) {
  const definition = forms[form];
  const sections = [...new Set(definition.fields.map((f) => f.section))];
  const [step, setStep] = useState(0);
  const [receipt, setReceipt] = useState("");
  const [failure, setFailure] = useState("");
  const requestKey = useRef("");
  const clientKey = useRef("");
  const {
    register,
    control,
    handleSubmit,
    trigger,
    setError,
    setFocus,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Record<string, unknown>>({
    resolver: zodResolver(submissionSchema(form)) as Resolver<
      Record<string, unknown>
    >,
    defaultValues: {
      version: 1,
      website: "",
      consent: false,
      ...Object.fromEntries(
        definition.fields
          .filter((f) => f.type === "multi")
          .map((f) => [f.key, []]),
      ),
    },
  });
  useEffect(() => {
    const campaign = new URL(window.location.href).searchParams.get("campaign");
    if (campaign && campaign.length <= 200) setValue("campaign", campaign);
  }, [setValue]);
  async function submit(values: Record<string, unknown>) {
    setFailure("");
    requestKey.current ||= crypto.randomUUID();
    clientKey.current ||= questionnaireClientId();
    try {
      const response = await fetch(`/api/questionnaires/${form}`, {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey.current,
          "X-Questionnaire-Client": clientKey.current,
        },
        body: JSON.stringify(values),
      });
      const data = await response.json();
      if (!response.ok) {
        for (const [key, messages] of Object.entries(data.fields ?? {}))
          setError(key, { message: (messages as string[])[0] });
        setFailure(
          data.error?.message ??
            "Your response could not be confirmed. Please retry.",
        );
        return;
      }
      setReceipt(data.receipt);
    } catch {
      setFailure(
        "Your response could not be confirmed. Keep this page open and retry with the same answers.",
      );
    }
  }
  const country = String(useWatch({ control, name: "country" }) ?? "");
  if (receipt)
    return (
      <SurveyShell>
        <div role="status" className="space-y-6 py-12">
          <span className="text-sm font-semibold uppercase tracking-widest text-emerald-800">
            Response received
          </span>
          <h1 className="text-4xl font-semibold">
            Thank you for shaping what comes next.
          </h1>
          <p>
            Your response has been saved.{" "}
            {form === "vending-business"
              ? "We may contact you to discuss your venue. This is not a rental agreement or commitment to install."
              : "Your preferences will help us choose what to test. This survey does not place an order."}
          </p>
          <p className="break-all text-sm text-stone-600">
            Reference: {receipt}
          </p>
          <a
            href="https://tesserix.app"
            className="inline-block rounded-full bg-emerald-900 px-6 py-3 text-white"
          >
            Visit Tesserix
          </a>
        </div>
      </SurveyShell>
    );
  const fields = definition.fields.filter((f) => f.section === sections[step]);
  return (
    <SurveyShell>
      <div className="mb-10 space-y-4">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-800">
          {definition.audience}
        </p>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          {definition.title}
        </h1>
        <p className="max-w-xl text-lg text-stone-600">{definition.subtitle}</p>
        <p className="text-sm text-stone-600">
          {form === "vending-customers"
            ? "No name, email or account needed. Please avoid personal or medical details."
            : "Estimates and “unknown” are welcome. Final suitability, costs and approvals require a site assessment."}
        </p>
      </div>
      <div className="mb-8">
        <div className="mb-3 flex justify-between text-sm">
          <span>{sections[step]}</span>
          <span>
            Step {step + 1} of {sections.length}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Survey progress"
          aria-valuemin={1}
          aria-valuemax={sections.length}
          aria-valuenow={step + 1}
          className="h-1.5 rounded-full bg-stone-200"
        >
          <div
            className="h-full rounded-full bg-emerald-800"
            style={{ width: `${((step + 1) / sections.length) * 100}%` }}
          />
        </div>
      </div>
      <form
        noValidate
        onSubmit={(event) => {
          void handleSubmit(submit, (invalid) => {
            const first = definition.fields.find((f) => invalid[f.key]);
            if (first) {
              setStep(sections.indexOf(first.section));
              setTimeout(() => setFocus(first.key), 0);
            }
          })(event);
        }}
        className="space-y-7"
      >
        <input
          type="hidden"
          {...register("version", { valueAsNumber: true })}
          value={1}
        />
        <div aria-hidden="true" className="hidden">
          <label>
            Website
            <input tabIndex={-1} autoComplete="off" {...register("website")} />
          </label>
        </div>
        {fields.map((f) => (
          <fieldset key={f.key} className="space-y-2">
            <legend className="mb-2 font-medium">
              {f.label}
              {f.required && (
                <span className="ml-1 text-emerald-800" aria-label="required">
                  *
                </span>
              )}
            </legend>
            {f.hint && (
              <p id={`${f.key}-hint`} className="text-sm text-stone-500">
                {f.hint}
              </p>
            )}
            {f.key === "country" ? (
              <select
                aria-label={f.label}
                aria-invalid={!!errors.country}
                aria-describedby={
                  errors.country ? "country-error" : "country-hint"
                }
                {...register("country", {
                  onChange: (event) => {
                    const selected = countries.find(
                      (c) => c.code === event.target.value,
                    );
                    if (selected)
                      setValue("currency", selected.currency, {
                        shouldValidate: true,
                      });
                    for (const key of [
                      "addressLine1",
                      "region",
                      "city",
                      "postcode",
                    ])
                      setValue(key, "");
                  },
                })}
                className="w-full rounded-xl border border-stone-300 bg-white p-3.5"
              >
                <option value="">Choose a country</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : f.type === "multi" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {f.options?.map((option) => (
                  <label
                    key={option}
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-stone-200 bg-white p-3.5 text-sm has-checked:border-emerald-700 has-checked:bg-emerald-50"
                  >
                    <input
                      type="checkbox"
                      value={option}
                      {...register(f.key)}
                      className="h-4 w-4 accent-emerald-800"
                    />
                    {label(option)}
                  </label>
                ))}
              </div>
            ) : f.type === "select" ? (
              <select
                aria-label={f.label}
                aria-invalid={!!errors[f.key]}
                aria-describedby={
                  errors[f.key] ? `${f.key}-error` : `${f.key}-hint`
                }
                {...register(f.key)}
                className="w-full rounded-xl border border-stone-300 bg-white p-3.5"
              >
                <option value="">
                  Choose an answer{!f.required ? " (optional)" : ""}
                </option>
                {f.options?.map((o) => (
                  <option key={o} value={o}>
                    {label(o)}
                  </option>
                ))}
              </select>
            ) : f.type === "textarea" ? (
              <textarea
                aria-label={f.label}
                aria-invalid={!!errors[f.key]}
                aria-describedby={
                  errors[f.key] ? `${f.key}-error` : `${f.key}-hint`
                }
                rows={3}
                maxLength={1500}
                {...register(f.key)}
                className="w-full rounded-xl border border-stone-300 bg-white p-3.5"
              />
            ) : (
              <input
                aria-label={f.label}
                aria-invalid={!!errors[f.key]}
                aria-describedby={
                  errors[f.key] ? `${f.key}-error` : `${f.key}-hint`
                }
                type={f.type}
                min={f.type === "number" ? 0 : undefined}
                max={f.max}
                step={f.type === "number" ? "0.01" : undefined}
                maxLength={200}
                {...register(
                  f.key,
                  f.type === "number"
                    ? { setValueAs: (v) => (v === "" ? undefined : Number(v)) }
                    : f.key === "country"
                      ? { setValueAs: (v) => String(v).toUpperCase() }
                      : {},
                )}
                className="w-full rounded-xl border border-stone-300 bg-white p-3.5"
              />
            )}
            {f.key === "country" && (
              <AddressLookup
                key={country}
                country={country}
                onSelect={(address) => {
                  const selected = countries.find(
                    (c) => c.code === address.country,
                  );
                  if (!selected) return;
                  for (const [key, value] of Object.entries({
                    country: address.country,
                    currency: selected.currency,
                    addressLine1: address.line1,
                    region: address.region,
                    city: address.city,
                    postcode: address.postal,
                  }))
                    setValue(key, value, {
                      shouldValidate: true,
                      shouldDirty: true,
                    });
                }}
              />
            )}
            {errors[f.key] && (
              <p
                id={`${f.key}-error`}
                role="alert"
                className="text-sm text-red-700"
              >
                {String(errors[f.key]?.message)}
              </p>
            )}
          </fieldset>
        ))}
        {step === sections.length - 1 && (
          <div className="space-y-3 rounded-2xl bg-emerald-50 p-5">
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                {...register("consent")}
                className="mt-1 h-4 w-4 accent-emerald-800"
              />
              <span>
                I agree to Tesserix using my responses for vending research
                {form === "vending-business"
                  ? " and contacting me about this venue if I have expressed interest"
                  : ""}
                . This does not sign me up for marketing.{" "}
                <a
                  href="/questionnaire/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Read the collection notice
                </a>
                .
              </span>
            </label>
            {errors.consent && (
              <p role="alert" className="text-sm text-red-700">
                Please acknowledge how your response will be used.
              </p>
            )}
          </div>
        )}
        {failure && (
          <p
            role="alert"
            className="rounded-xl bg-red-50 p-4 text-sm text-red-800"
          >
            {failure}
          </p>
        )}
        <div className="flex items-center justify-between border-t border-stone-200 pt-6">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="rounded-full border border-stone-300 px-6 py-3"
            >
              Back
            </button>
          ) : (
            <span className="text-xs text-stone-500">* Required</span>
          )}
          {step < sections.length - 1 ? (
            <button
              type="button"
              onClick={async () => {
                if (await trigger(fields.map((f) => f.key))) setStep(step + 1);
              }}
              className="rounded-full bg-emerald-900 px-7 py-3 font-medium text-white"
            >
              Continue →
            </button>
          ) : (
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-full bg-emerald-900 px-7 py-3 font-medium text-white disabled:opacity-50"
            >
              {isSubmitting ? "Saving…" : "Submit response"}
            </button>
          )}
        </div>
      </form>
    </SurveyShell>
  );
}
function SurveyShell({ children }: { children: React.ReactNode }) {
  return (
    <main
      id="main-content"
      className="min-h-screen bg-[#f6f5ef] px-5 py-8 text-stone-900 sm:py-12"
    >
      <div className="mx-auto max-w-3xl">
        <div className="mb-10">
          <QuestionnaireBrand />
        </div>
        <div className="rounded-3xl border border-white bg-white/80 p-6 shadow-sm sm:p-10">
          {children}
        </div>
        <footer className="mt-8 flex flex-wrap justify-between gap-4 text-xs text-stone-500">
          <span>Independent research for a vending pilot.</span>
          <a href="/questionnaire/privacy" className="underline">
            Privacy & collection notice
          </a>
        </footer>
      </div>
    </main>
  );
}
