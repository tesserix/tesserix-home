"use client";

import { TemplateListPage } from "@/components/admin/email-templates/template-list-page";

export default function PlatformEmailTemplatesPage() {
  return (
    <TemplateListPage
      scope="platform"
      basePath="/admin/email-templates"
      title="Platform Email Templates"
      description="System health alerts, audit notifications, and security templates"
    />
  );
}
