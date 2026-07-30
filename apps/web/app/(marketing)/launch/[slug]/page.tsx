import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getLaunchRelease,
  getLaunchReleases,
  LAUNCH_PAGE_URL,
} from "../launch-config";
import { LaunchContent } from "../launch-content";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const release = getLaunchRelease(slug);

  if (!release) {
    return { title: "Launch Not Found" };
  }

  const title = `${release.name} launches ${release.displayDate}`;
  return {
    title,
    description: release.tagline,
    alternates: { canonical: `/launch/${release.slug}` },
    openGraph: {
      type: "website",
      url: `${LAUNCH_PAGE_URL}/${release.slug}`,
      siteName: "Tesserix",
      title,
      description: release.tagline,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: release.tagline,
    },
  };
}

export function generateStaticParams() {
  return getLaunchReleases().map((release) => ({ slug: release.slug }));
}

export default async function LaunchReleasePage({ params }: PageProps) {
  const { slug } = await params;
  const release = getLaunchRelease(slug);

  if (!release) {
    notFound();
  }

  return (
    <LaunchContent
      releases={[release]}
      shareUrl={`${LAUNCH_PAGE_URL}/${release.slug}`}
    />
  );
}
