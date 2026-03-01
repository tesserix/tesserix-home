import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, getSessionContext, apiError } from '@/lib/api/admin-fetch';
import { normalizeTicket } from './normalize';

/**
 * GET /api/tickets
 *
 * For platform admins: aggregates tickets across all tenants.
 * First fetches tenant list, then fetches tickets from each tenant in parallel.
 *
 * For tenant users: fetches tickets for their own tenant only.
 *
 * Query params: page, limit, status, priority, search, tenantId (optional filter)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = searchParams.get('page') || '1';
    const limit = searchParams.get('limit') || '20';
    const status = searchParams.get('status');
    const priority = searchParams.get('priority');
    const search = searchParams.get('search');
    const tenantIdFilter = searchParams.get('tenantId');

    const session = await getSessionContext();
    if (!session) {
      return apiError('Unauthorized', 401);
    }

    // If a specific tenant is requested, fetch tickets for that tenant only
    if (tenantIdFilter) {
      return fetchTicketsForTenant(tenantIdFilter, { page, limit, status, priority, search });
    }

    // If user has a tenant context (tenant admin), use that
    if (session.tenantId) {
      return fetchTicketsForTenant(session.tenantId, { page, limit, status, priority, search });
    }

    // Platform admin — aggregate tickets across all tenants
    // First, get all tenant IDs
    const tenantsResponse = await adminFetch('tenant', '/api/v1/users/me/tenants?limit=100');
    if (!tenantsResponse.ok) {
      return apiError('Failed to fetch tenants', tenantsResponse.status);
    }

    const tenantsBody = await tenantsResponse.json();
    // Tenant-service returns { data: { count, tenants: [...] } } — extract the array
    const tenantsNested = tenantsBody?.data;
    const tenants = Array.isArray(tenantsNested?.tenants)
      ? tenantsNested.tenants
      : Array.isArray(tenantsNested) ? tenantsNested : [];
    if (tenants.length === 0) {
      return NextResponse.json({ data: [], total: 0, page: 1, pageSize: 20 });
    }

    // Fetch tickets from each tenant in parallel
    const ticketPromises = tenants.map(async (tenant: { tenant_id?: string; id?: string; name?: string; slug?: string }) => {
      const tid = tenant.tenant_id || tenant.id || '';
      try {
        const params = new URLSearchParams({ page: '1', limit: '100' });
        if (status && status !== 'all') params.set('status', status.toUpperCase());
        if (priority && priority !== 'all') params.set('priority', priority.toUpperCase());

        const response = await adminFetch('tickets', `/tickets?${params}`, {
          tenantId: tid,
        });

        if (!response.ok) return [];

        const data = await response.json();
        const tickets = Array.isArray(data.data) ? data.data : [];
        // Normalize camelCase → snake_case and attach tenant info
        return tickets.map((t: Record<string, unknown>) => ({
          ...normalizeTicket(t),
          tenant_name: tenant.name || tenant.slug || tid,
          tenant_id: tid,
        }));
      } catch {
        return [];
      }
    });

    const allTicketArrays = await Promise.all(ticketPromises);
    let allTickets = allTicketArrays.flat();

    // Apply search filter on aggregated results (backend search is per-tenant)
    if (search) {
      const searchLower = search.toLowerCase();
      allTickets = allTickets.filter((t: Record<string, unknown>) =>
        (t.title as string)?.toLowerCase().includes(searchLower) ||
        (t.ticket_number as string)?.toLowerCase().includes(searchLower) ||
        (t.tenant_name as string)?.toLowerCase().includes(searchLower)
      );
    }

    // Sort by updated_at descending
    allTickets.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const dateA = new Date(a.updated_at as string || a.created_at as string || 0).getTime();
      const dateB = new Date(b.updated_at as string || b.created_at as string || 0).getTime();
      return dateB - dateA;
    });

    // Paginate
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const start = (pageNum - 1) * limitNum;
    const paginatedTickets = allTickets.slice(start, start + limitNum);

    return NextResponse.json({
      data: paginatedTickets,
      total: allTickets.length,
      page: pageNum,
      pageSize: limitNum,
      totalPages: Math.ceil(allTickets.length / limitNum),
    });
  } catch (error) {
    console.error('[Tickets API] Error:', error);
    return apiError('Failed to fetch tickets');
  }
}

async function fetchTicketsForTenant(
  tenantId: string,
  filters: { page: string; limit: string; status: string | null; priority: string | null; search: string | null }
) {
  const params = new URLSearchParams({ page: filters.page, limit: filters.limit });
  if (filters.status && filters.status !== 'all') params.set('status', filters.status.toUpperCase());
  if (filters.priority && filters.priority !== 'all') params.set('priority', filters.priority.toUpperCase());
  if (filters.search) params.set('search', filters.search);

  const response = await adminFetch('tickets', `/tickets?${params}`, {
    tenantId,
  });

  if (response.status === 401) {
    return apiError('Unauthorized', 401);
  }

  // Unwrap Go response { success, data: [...], pagination: {...} } and normalize
  const body = await response.json();
  const tickets = Array.isArray(body.data) ? body.data : [];
  const pagination = body.pagination || {};

  return NextResponse.json({
    data: tickets.map((t: Record<string, unknown>) => normalizeTicket(t)),
    total: pagination.total || tickets.length,
    page: pagination.page || parseInt(filters.page),
    pageSize: pagination.limit || parseInt(filters.limit),
    totalPages: pagination.totalPages || Math.ceil((pagination.total || tickets.length) / parseInt(filters.limit)),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.title) {
      return NextResponse.json(
        { error: 'Title is required' },
        { status: 400 }
      );
    }

    // tenantId is required for creating tickets
    const tenantId = body.tenantId;
    if (!tenantId) {
      return NextResponse.json(
        { error: 'tenantId is required' },
        { status: 400 }
      );
    }

    const response = await adminFetch('tickets', '/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: body.title,
        description: body.description || '',
        type: body.type || 'SUPPORT',
        priority: (body.priority || 'MEDIUM').toUpperCase(),
        tags: body.tags || [],
      }),
      tenantId,
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    const resBody = await response.json();
    const ticket = resBody?.data || resBody;
    return NextResponse.json(normalizeTicket(ticket), { status: response.status });
  } catch (error) {
    console.error('[Tickets API] Error:', error);
    return apiError('Failed to create ticket');
  }
}
