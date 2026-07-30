import type { Metadata } from "next";
import { getLaunchReleases, LAUNCH_PAGE_URL } from "./launch-config";
import { LaunchContent } from "./launch-content";

const releases = getLaunchReleases();
const names = releases.map((release) => release.name).join(" & ");

export const metadata: Metadata = {
  title: `Launch Day — ${names}`,
  description: `${names} go live on ${releases[0].displayDate}. Count down with us.`,
  alternates: { canonical: "/launch" },
  openGraph: {
    type: "website",
    url: LAUNCH_PAGE_URL,
    siteName: "Tesserix",
    title: `Launch Day — ${names}`,
    description: `${names} go live on ${releases[0].displayDate}. Count down with us.`,
  },
  twitter: {
    card: "summary_large_image",
    title: `Launch Day — ${names}`,
    description: `${names} go live on ${releases[0].displayDate}.`,
  },
};

export default function LaunchPage() {
  return <LaunchContent releases={getLaunchReleases()} />;
}
