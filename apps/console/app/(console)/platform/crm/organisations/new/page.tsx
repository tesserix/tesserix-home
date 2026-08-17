"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ESTATE } from "@tesserix/console-core";
import {
  Button,
  Callout,
  CalloutDescription,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { createOrganisationAction } from "./actions";

// Radix Select cannot hold an empty-string item value (see
// `components/kit/filter-bar.tsx`) — this sentinel stands in for "no
// product chosen yet" and is stripped back to `undefined` in `actions.ts`
// (which keeps its own copy of the same literal: a `"use server"` file may
// only export async functions, so it can't be imported from there).
const NO_PRODUCT_VALUE = "__none__";

const PRODUCTS = ESTATE.map((product) => ({ context: product.context, name: product.name }));

// `createOrganisationAction`'s one product-specific rejection
// (`unknownProductMessage` in `actions.ts`), matched so it can be routed to
// the product field itself rather than left in the form-level Callout where
// nothing associates it with the control that caused it.
const PRODUCT_ERROR_PATTERN = / is not a product in the estate\.$/;

/**
 * Manual create for the CRM (#213): a lead phoned in has no CSV row to
 * import through. `name` is the only required field — location, website,
 * first contact and first opportunity are all optional, matching
 * `createOrganisation`'s own contract (crm-writes.ts).
 */
export default function NewOrganisationPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (formData: FormData) => {
    if (!name.trim()) {
      setNameError("Enter an organisation name.");
      return;
    }
    setNameError(null);
    setError(null);
    startTransition(async () => {
      const result = await createOrganisationAction(formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.push("/platform/crm/organisations");
      router.refresh();
    });
  };

  const isProductError = error !== null && PRODUCT_ERROR_PATTERN.test(error);

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Add organisation"
        description="Record a lead by hand — a phone call, or a returning organisation with no CSV row to import through."
        breadcrumbs={[
          { label: "CRM", href: "/platform/crm" },
          { label: "Organisations", href: "/platform/crm/organisations" },
          { label: "Add organisation" },
        ]}
      />

      <form
        className="flex max-w-xl flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit(new FormData(event.currentTarget));
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Organisation name</Label>
          <Input
            id="name"
            name="name"
            value={name}
            disabled={pending}
            isInvalid={Boolean(nameError)}
            errorText={nameError ?? undefined}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="location">Location</Label>
          <Input id="location" name="location" disabled={pending} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="websiteUrl">Website</Label>
          <Input id="websiteUrl" name="websiteUrl" type="url" disabled={pending} placeholder="https://" />
        </div>

        <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-medium">First contact (optional)</legend>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contactName">Name</Label>
            <Input id="contactName" name="contactName" disabled={pending} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contactEmail">Email</Label>
            <Input id="contactEmail" name="contactEmail" type="email" disabled={pending} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contactInstagramHandle">Instagram handle</Label>
            <Input
              id="contactInstagramHandle"
              name="contactInstagramHandle"
              disabled={pending}
              placeholder="@bondibaker"
            />
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-medium">First opportunity (optional)</legend>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="product">Product</Label>
            {/* Radix's Select mirrors its value onto a hidden native
                <select>, keyed by `name`, so it participates in
                `FormData` the same way `Input`/`Label` do — no controlled
                state or hidden-input shim needed here. No `aria-label`: the
                `Label htmlFor="product"` above already names the control,
                and an `aria-label` here would override that computed name
                rather than add to it — a screen reader would announce
                "Product, combobox" regardless of the selected value. */}
            <Select name="product" defaultValue={NO_PRODUCT_VALUE} disabled={pending}>
              <SelectTrigger
                id="product"
                size="default"
                aria-invalid={isProductError || undefined}
                aria-describedby={isProductError ? "product-error" : undefined}
              >
                <SelectValue placeholder="Choose a product…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PRODUCT_VALUE}>No product yet</SelectItem>
                {PRODUCTS.map((product) => (
                  <SelectItem key={product.context} value={product.context}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Same accessible-error shape `Input`'s `isInvalid`/`errorText`
                give the name field above — Radix's `Select` has no such
                props, so this mirrors them by hand: `role="alert"` plus the
                `aria-describedby` wired on the trigger above. */}
            {isProductError ? (
              <p id="product-error" role="alert" className="mt-1.5 text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="owner">Owner</Label>
            <Input id="owner" name="owner" disabled={pending} />
          </div>
        </fieldset>

        {error && !isProductError ? (
          <Callout role="alert" variant="destructive">
            <CalloutDescription>{error}</CalloutDescription>
          </Callout>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Add organisation"}
          </Button>
        </div>
      </form>
    </div>
  );
}
