import { find, mediaUrl, opt, orFallback, type Media } from "./client";
import { fallbackBeliefs, fallbackOpenSource, fallbackPrinciples, fallbackTeam } from "./fallback/site";
import type { Belief, OpenSourceRepo, Principle, TeamMember } from "./types";

// /about, homepage and open-source content. Each read falls back to its static copy on its own.

type TeamDoc = { slug: string; name: string; title: string; bio?: string | null; linkedIn: string; github: string; photo?: Media | number | null };

export function getTeam(): Promise<TeamMember[]> {
  const read = (find("team-members") as Promise<TeamDoc[]>).then((docs) =>
    docs.map((d) => ({
      slug: d.slug,
      name: d.name,
      title: d.title,
      bio: opt(d.bio),
      linkedIn: d.linkedIn,
      github: d.github,
      photo: mediaUrl(d.photo, "profile") ?? `/team/${d.slug}.jpg`,
    })),
  );
  return orFallback(read, fallbackTeam);
}

export function getPrinciples(): Promise<Principle[]> {
  const read = (find("principles") as Promise<Principle[]>).then((docs) => docs.map(({ title, body }) => ({ title, body })));
  return orFallback(read, fallbackPrinciples);
}

export function getBeliefs(): Promise<Belief[]> {
  const read = (find("beliefs") as Promise<Belief[]>).then((docs) => docs.map(({ label, title, body }) => ({ label, title, body })));
  return orFallback(read, fallbackBeliefs);
}

export function getOpenSource(): Promise<OpenSourceRepo[]> {
  const read = (find("open-source-projects") as Promise<OpenSourceRepo[]>).then((docs) =>
    docs.map(({ name, description }) => ({ name, description })),
  );
  return orFallback(read, fallbackOpenSource);
}
