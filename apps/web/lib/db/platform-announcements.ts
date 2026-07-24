import { tesserixQuery } from "./tesserix";

export interface AnnouncementRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly audience_filter: Record<string, unknown>;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly is_published: boolean;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export async function listAnnouncements(): Promise<AnnouncementRow[]> {
  const res = await tesserixQuery<AnnouncementRow>(
    `SELECT id, title, body, severity, audience_filter, starts_at, ends_at,
            is_published, created_by, created_at, updated_at
     FROM platform_announcements
     ORDER BY starts_at DESC LIMIT 500`,
  );
  return res.rows;
}

// Active = published, currently within window, audience matches.
export async function getActiveAnnouncementsForTenant(productId: string, tenantStatus: string): Promise<AnnouncementRow[]> {
  const res = await tesserixQuery<AnnouncementRow>(
    `SELECT id, title, body, severity, audience_filter, starts_at, ends_at,
            is_published, created_by, created_at, updated_at
     FROM platform_announcements
     WHERE is_published = true
       AND starts_at <= now()
       AND (ends_at IS NULL OR ends_at > now())
       AND (audience_filter->'products' IS NULL
            OR audience_filter->'products' @> to_jsonb($1::text))
       AND (audience_filter->'statuses' IS NULL
            OR audience_filter->'statuses' @> to_jsonb($2::text))
     ORDER BY starts_at DESC`,
    [productId, tenantStatus],
  );
  return res.rows;
}

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  severity?: string;
  audienceFilter?: Record<string, unknown>;
  startsAt?: string;
  endsAt?: string | null;
  isPublished?: boolean;
  createdBy?: string;
}

export async function createAnnouncement(input: CreateAnnouncementInput): Promise<AnnouncementRow> {
  const res = await tesserixQuery<AnnouncementRow>(
    `INSERT INTO platform_announcements
       (title, body, severity, audience_filter, starts_at, ends_at, is_published, created_by)
     VALUES ($1, $2, COALESCE($3,'info'), COALESCE($4::jsonb,'{}'::jsonb),
             COALESCE($5::timestamptz, now()), $6::timestamptz, COALESCE($7,false), $8)
     RETURNING id, title, body, severity, audience_filter, starts_at, ends_at,
               is_published, created_by, created_at, updated_at`,
    [
      input.title,
      input.body,
      input.severity ?? null,
      input.audienceFilter ? JSON.stringify(input.audienceFilter) : null,
      input.startsAt ?? null,
      input.endsAt ?? null,
      input.isPublished ?? null,
      input.createdBy ?? null,
    ],
  );
  return res.rows[0];
}

export async function updateAnnouncementPublished(id: string, isPublished: boolean): Promise<AnnouncementRow | null> {
  const res = await tesserixQuery<AnnouncementRow>(
    `UPDATE platform_announcements
       SET is_published = $2
     WHERE id = $1::uuid
     RETURNING id, title, body, severity, audience_filter, starts_at, ends_at,
               is_published, created_by, created_at, updated_at`,
    [id, isPublished],
  );
  return res.rows[0] ?? null;
}
