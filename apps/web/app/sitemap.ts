import type { MetadataRoute } from "next";
import { getLaunchReleases } from "./(marketing)/launch/launch-config";
import { productSlugs } from "./(marketing)/products/[slug]/products-data";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://tesserix.app";

  const productEntries: MetadataRoute.Sitemap = productSlugs.map((slug) => ({
    url: `${baseUrl}/products/${slug}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.9,
  }));

  const launchEntries: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/launch`,
      lastModified: new Date(),
      changeFrequency: "daily" as const,
      priority: 0.9,
    },
    ...getLaunchReleases().map((release) => ({
      url: `${baseUrl}/launch/${release.slug}`,
      lastModified: new Date(),
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
  ];

  return [
    ...launchEntries,
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${baseUrl}/products`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.9,
    },
    ...productEntries,
    {
      url: `${baseUrl}/about`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/contact`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
