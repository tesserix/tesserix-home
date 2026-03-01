import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, apiError } from '@/lib/api/admin-fetch';

// Maps a notification-service template (camelCase) to the frontend EmailTemplate (snake_case)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTemplate(t: any) {
  return {
    id: t.id,
    name: t.name,
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const response = await adminFetch('notification', `/templates/${id}`);

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }
    if (response.status === 404) {
      return apiError('Template not found', 404);
    }

    const json = await response.json().catch(() => null);
    if (!response.ok || !json) {
      const msg = json?.error || `Failed to fetch template (${response.status})`;
      return apiError(msg, response.status);
    }

    // notification-service returns { success, data }
    const template = json.data || json;
    return NextResponse.json(mapTemplate(template));
  } catch (error) {
    console.error('[Email Template Detail API] Error:', error);
    return apiError('Failed to fetch email template');
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const response = await adminFetch('notification', `/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(toBackendPayload(body)),
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    const json = await response.json().catch(() => null);
    if (!response.ok || !json) {
      const msg = json?.error || `Failed to update template (${response.status})`;
      return apiError(msg, response.status);
    }

    const template = json.data || json;
    return NextResponse.json(mapTemplate(template));
  } catch (error) {
    console.error('[Email Template Update API] Error:', error);
    return apiError('Failed to update email template');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const response = await adminFetch('notification', `/templates/${id}`, {
      method: 'DELETE',
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const msg = json?.error || `Failed to delete template (${response.status})`;
      return apiError(msg, response.status);
    }

    return NextResponse.json({ success: true, message: 'Template deleted' });
  } catch (error) {
    console.error('[Email Template Delete API] Error:', error);
    return apiError('Failed to delete email template');
  }
}
