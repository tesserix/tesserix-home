/**
 * The bound on a void's reason.
 *
 * `voided_reason` is plain `text` with no length CHECK (migration 0049), and
 * the reason is copied a second time into the void's `crm_activities.body`,
 * which is also unbounded. So nothing below the action boundary refuses a
 * megabyte of pasted text, and two rows would hold it.
 *
 * Rejected rather than truncated. The reason exists for the next human to
 * read, and a silently clipped explanation is worse than none: it reads as
 * complete and stops mid-sentence. `truncateImportFilename` (`crm.ts`)
 * truncates because a filename is a label the operator did not author;
 * this is their own words. `MAX_LABEL_LENGTH` in
 * `tenant-pricing-override-write.ts` is the precedent followed here — cap,
 * refuse, and say the number.
 *
 * Its own module rather than a constant in `actions.ts`: that file is
 * `"use server"` and may export only async functions, and the void control
 * (T5) needs the same number for its `maxLength` so the form refuses before
 * the round trip rather than after it.
 */
export const MAX_VOID_REASON_LENGTH = 500;

/** Long enough for a paragraph explaining a mis-click; short enough that no
 *  one mistakes the field for the deal's notes. */
export function voidReasonTooLongMessage(): string {
  return `That reason is too long — keep it to ${MAX_VOID_REASON_LENGTH} characters or fewer.`;
}

/**
 * Measured against the TRIMMED reason, because trimming is what
 * `voidOpportunity` does before storing — surrounding whitespace is never
 * part of what lands in the column, so refusing a reason for it would refuse
 * text that would have fit.
 */
export function isVoidReasonTooLong(reason: string | null): boolean {
  return (reason?.trim().length ?? 0) > MAX_VOID_REASON_LENGTH;
}
