import { getLaunchReleases } from "./launch-config";
import { OG_CONTENT_TYPE, OG_SIZE, renderLaunchOg } from "./launch-og";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Tesserix launch day announcement";

export default function Image() {
  const releases = getLaunchReleases();
  const names = releases.map((release) => release.name);
  const title =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`
      : names[0];

  return renderLaunchOg({
    title,
    subtitle:
      releases.length > 1
        ? `${["Two", "Three", "Four", "Five"][releases.length - 2] ?? releases.length} products. One launch day.`
        : releases[0].tagline,
    displayDate: releases[0].displayDate,
    releases,
  });
}
