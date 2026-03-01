"use client";

import { use } from "react";
import { TemplateListPage } from "@/components/admin/email-templates/template-list-page";

const APP_NAMES: Record<string, string> = {
  mark8ly: "Mark8ly",
};

export default function AppEmailTemplatesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const appName = APP_NAMES[slug] || slug;

  return (
    <TemplateListPage
      scope="mark8ly"
      basePath={`/admin/apps/${slug}/email-templates`}
      title="Email Templates"
      description={`Manage email templates and notification logs for ${appName}`}
      breadcrumb={{ label: appName, href: `/admin/apps/${slug}` }}
    />
  );
}
