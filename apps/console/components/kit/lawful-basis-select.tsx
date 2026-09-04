"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";
import { SELECTABLE_LAWFUL_BASES } from "@/lib/crm-provenance";

/**
 * The lawful-basis chooser (#248), shared by all four write surfaces: the
 * CSV import (once for the batch), the manual-create form's first contact,
 * the add-contact form on an organisation, and the contact edit form.
 *
 * One component rather than four copies for the reason `NO_PRODUCT_VALUE`
 * gives about its sentinel: the options ARE the closed set, and four
 * hand-written option lists is four places for the set to drift from
 * `SELECTABLE_LAWFUL_BASES` — three of which would still validate, because
 * the server refuses on the set and not on what the form happened to offer.
 *
 * NO PRESELECTED VALUE, on every surface. The placeholder is the point: the
 * defect this closes is a column that was never filled in, and a select that
 * arrives already answered records a decision the operator did not make. The
 * caller gates its submit button on the value being present, and the action
 * refuses again server-side.
 *
 * `not_recorded_pre_migration` is never among the options — it is not
 * rendered here at all, not even disabled. See `LEGACY_LAWFUL_BASIS`.
 */
export const KEEP_RECORDED_BASIS = "__keep__";

export function LawfulBasisSelect({
  id,
  name,
  value,
  onValueChange,
  disabled,
  /** Edit surfaces only: offers a first option that leaves the recorded
   *  basis untouched. This is what makes a migrated contact editable — its
   *  recorded value is storable but not selectable, so there is no option
   *  that could round-trip it. The caller must omit the field entirely when
   *  `KEEP_RECORDED_BASIS` is selected. */
  keepRecordedLabel,
}: {
  id: string;
  name?: string;
  value?: string;
  onValueChange?: (next: string) => void;
  disabled?: boolean;
  keepRecordedLabel?: string;
}) {
  return (
    <Select name={name} value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} size="default">
        <SelectValue placeholder="Choose a lawful basis…" />
      </SelectTrigger>
      <SelectContent>
        {keepRecordedLabel ? (
          <SelectItem value={KEEP_RECORDED_BASIS}>{keepRecordedLabel}</SelectItem>
        ) : null}
        {SELECTABLE_LAWFUL_BASES.map((basis) => (
          <SelectItem key={basis.value} value={basis.value}>
            {basis.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The chosen basis explained in one line, under the control. The choice is
 *  the compliance artefact; an operator picking from three unglossed nouns is
 *  guessing, and a guessed basis is no better than the blank one #248 found. */
export function LawfulBasisHint({ value }: { value: string | undefined }) {
  const basis = SELECTABLE_LAWFUL_BASES.find((entry) => entry.value === value);
  if (!basis) return null;
  return <p className="text-xs text-muted-foreground">{basis.description}</p>;
}
