"use client";

import { use } from "react";
import { TemplateEditorPage } from "@/components/admin/email-templates/template-editor-page";

export default function AppEmailTemplateEditorPageWrapper({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = use(params);

  return (
    <TemplateEditorPage
      scope="mark8ly"
      basePath={`/admin/apps/${slug}/email-templates`}
      templateId={id}
    />
  );
}
