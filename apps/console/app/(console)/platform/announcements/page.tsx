import { fetchAnnouncements } from "@/lib/platform-api";
import { AnnouncementsView } from "./announcements-view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Announcements" };

/**
 * The platform announcement composer and log (#150).
 *
 * Replaces apps/web's `/admin/platform-announcements`, whose API had no
 * capability check at all. Reads are fetched here on the server; every write
 * goes through actions.ts, which gates on `mass-send`.
 *
 * The read is NOT gated here beyond the console's own route gate: reaching this
 * path already requires `mass-send`, because routes.ts declares the capability
 * against `platform.announcements` and the access gate resolves a request path
 * through the route table. A second check in this component would be a
 * different gate that could disagree with that one.
 */
export default async function AnnouncementsPage() {
  const announcements = await fetchAnnouncements().catch(() => null);

  if (announcements === null) {
    // The platform API is the only source — this surface never existed in
    // apps/web's console, so there is nothing to fall back to. Say so rather
    // than render an empty list, which would read as "no announcements" and
    // invite someone to write a duplicate of one already live.
    return (
      <main className="p-6">
        <h1 className="text-xl font-semibold">Announcements</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          Announcements could not be loaded. This is a connection problem, not an
          empty list — do not compose a new one until it resolves.
        </p>
      </main>
    );
  }

  return <AnnouncementsView announcements={announcements} />;
}
