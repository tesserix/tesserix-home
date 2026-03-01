"use client";

import { use } from "react";
import { TemplateEditorPage } from "@/components/admin/email-templates/template-editor-page";

export default function PlatformEmailTemplateEditorPageWrapper({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <TemplateEditorPage
      scope="platform"
      basePath="/admin/email-templates"
      templateId={id}
    />
  );
}
