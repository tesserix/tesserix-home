import { notFound } from "next/navigation";
import { getLaunchRelease, getLaunchReleases } from "../launch-config";
import { OG_CONTENT_TYPE, OG_SIZE, renderLaunchOg } from "../launch-og";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Tesserix product launch announcement";

export function generateStaticParams() {
  return getLaunchReleases().map((release) => ({ slug: release.slug }));
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const release = getLaunchRelease(slug);

  if (!release) {
    notFound();
  }

  return renderLaunchOg({
    title: release.name,
    subtitle: release.tagline,
    displayDate: release.displayDate,
    releases: [release],
  });
}
