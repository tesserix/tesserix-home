import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, apiError } from '@/lib/api/admin-fetch';

// Maps a notification-service template (camelCase) to the frontend EmailTemplate (snake_case)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTemplate(t: any) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug || '',
    type: (t.channel || 'EMAIL').toLowerCase(),
    category: t.category || '',
    subject: t.subject || '',
    description: t.description || '',
    html_body: t.htmlTemplate || '',
    text_body: t.bodyTemplate || '',
    variables: t.variables ? Object.keys(t.variables) : [],
    status: t.isActive ? 'active' : 'inactive',
    is_system: t.isSystem || false,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

// Reverse-maps frontend EmailTemplate fields to notification-service request fields
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBackendPayload(data: any) {
  return {
    name: data.name,
    description: data.description || '',
    channel: (data.type || 'email').toUpperCase(),
    category: data.category || '',
    subject: data.subject || '',
    bodyTemplate: data.text_body || '',
    htmlTemplate: data.html_body || '',
    variables: Array.isArray(data.variables)
      ? Object.fromEntries(data.variables.map((v: string) => [v, '']))
      : data.variables || {},
  };
}

export async function GET() {
  try {
    const response = await adminFetch('notification', '/templates');

    if (response.status === 401) {
      console.warn('[Email Templates API] Notification service returned 401 — returning empty list');
      return NextResponse.json([]);
    }

    const json = await response.json().catch(() => null);
    if (!json) {
      return NextResponse.json([]);
    }

    // notification-service returns { success, data, pagination }
    const templates = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
    return NextResponse.json(templates.map(mapTemplate));
  } catch (error) {
    console.error('[Email Templates API] Error:', error);
    return NextResponse.json([]);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const response = await adminFetch('notification', '/templates', {
      method: 'POST',
      body: JSON.stringify(toBackendPayload(body)),
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    const json = await response.json().catch(() => null);
    if (!response.ok || !json) {
      const msg = json?.error || `Failed to create template (${response.status})`;
      return apiError(msg, response.status);
    }

    // notification-service returns { success, data }
    const template = json.data || json;
    return NextResponse.json(mapTemplate(template), { status: 201 });
  } catch (error) {
    console.error('[Email Templates API] Error:', error);
    return apiError('Failed to create email template');
  }
}
