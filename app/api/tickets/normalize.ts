/**
 * Normalize a ticket from Go camelCase to frontend snake_case.
 * The Go tickets-service returns camelCase fields (ticketNumber, createdBy, etc.)
 * but the frontend expects snake_case (ticket_number, created_by, etc.).
 */
export function normalizeTicket(t: Record<string, unknown>): Record<string, unknown> {
  if (!t) return t;
  return {
    id: t.id,
    ticket_number: t.ticketNumber || t.ticket_number,
    tenant_id: t.tenantId || t.tenant_id,
    tenant_name: t.tenant_name || t.tenantName,
    application_id: t.applicationId || t.application_id,
    title: t.title,
    description: t.description,
    type: t.type,
    status: t.status,
    priority: t.priority,
    tags: t.tags,
    created_by: t.createdBy || t.created_by,
    created_by_name: t.createdByName || t.created_by_name,
    created_by_email: t.createdByEmail || t.created_by_email,
    created_at: t.createdAt || t.created_at,
    updated_at: t.updatedAt || t.updated_at,
    updated_by: t.updatedBy || t.updated_by,
    due_date: t.dueDate || t.due_date,
    estimated_time: t.estimatedTime || t.estimated_time,
    actual_time: t.actualTime || t.actual_time,
    parent_ticket_id: t.parentTicketId || t.parent_ticket_id,
    assignees: t.assignees,
    attachments: t.attachments,
    comments: normalizeComments(t.comments),
    sla: t.sla,
    history: t.history,
    metadata: t.metadata,
  };
}

/**
 * Normalize comments array — Go may return camelCase fields.
 */
function normalizeComments(comments: unknown): unknown {
  if (!Array.isArray(comments)) return comments;
  return comments.map((c: Record<string, unknown>) => ({
    id: c.id,
    content: c.content,
    is_internal: c.isInternal ?? c.is_internal,
    author: c.author,
    created_by: c.createdBy || c.created_by,
    created_by_name: c.createdByName || c.created_by_name,
    created_by_email: c.createdByEmail || c.created_by_email,
    created_at: c.createdAt || c.created_at,
  }));
}
