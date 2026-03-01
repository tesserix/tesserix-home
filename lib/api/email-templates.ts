"use client";

import { useMemo } from 'react';
import { useApi, apiFetch } from './use-api';
import { type TemplateScope, getCategoryValues } from './email-template-categories';

export type TemplateStatus = 'active' | 'inactive' | 'draft';
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'bounced';

export interface EmailTemplate {
  id: string;
  name: string;
  slug: string;
  type: string;
  category?: string;
  subject: string;
  description?: string;
  html_body: string;
  text_body?: string;
  variables?: string[];
  status: TemplateStatus;
  is_system?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Notification {
  id: string;
  recipient: string;
  subject: string;
  template_id?: string;
  template_name?: string;
  status: NotificationStatus;
  sent_at?: string;
  delivered_at?: string;
  failed_at?: string;
  error_message?: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationStatusDetail {
  id: string;
  status: NotificationStatus;
  events: NotificationEvent[];
}

export interface NotificationEvent {
  type: string;
  timestamp: string;
  details?: string;
}

export interface TestSendPayload {
  recipient: string;
  variables?: Record<string, string>;
}

// Hooks

export function useEmailTemplates() {
  return useApi<EmailTemplate[]>('/api/email-templates');
}

export function useEmailTemplatesByScope(scope: TemplateScope) {
  const scopeCategories = useMemo(() => getCategoryValues(scope), [scope]);
  const result = useApi<EmailTemplate[]>('/api/email-templates');

  // Client-side filter: only show templates whose category belongs to this scope.
  // Templates without a category are shown in both scopes (uncategorized bucket).
  const filtered = useMemo(() => {
    if (!result.data) return null;
    return result.data.filter(
      (t) => !t.category || scopeCategories.includes(t.category)
    );
  }, [result.data, scopeCategories]);

  return { ...result, data: filtered };
}

export function useEmailTemplate(id: string | null) {
  return useApi<EmailTemplate>(id ? `/api/email-templates/${id}` : null);
}

export function useNotifications() {
  return useApi<Notification[]>('/api/email-templates/notifications');
}

export function useNotification(id: string | null) {
  return useApi<Notification>(id ? `/api/email-templates/notifications/${id}` : null);
}

// Mutations

export async function createTemplate(data: Partial<EmailTemplate>) {
  return apiFetch<EmailTemplate>('/api/email-templates', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateTemplate(id: string, data: Partial<EmailTemplate>) {
  return apiFetch<EmailTemplate>(`/api/email-templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteTemplate(id: string) {
  return apiFetch(`/api/email-templates/${id}`, {
    method: 'DELETE',
  });
}

export async function duplicateTemplate(id: string) {
  return apiFetch<EmailTemplate>(`/api/email-templates/${id}/duplicate`, {
    method: 'POST',
  });
}

export async function testSendTemplate(id: string, payload: TestSendPayload) {
  return apiFetch(`/api/email-templates/${id}/test`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
