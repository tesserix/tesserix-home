"use client";

import { useApi, apiFetch } from './use-api';

// Types matching marketplace-clients/admin/lib/types/settings.ts
export type ContentPageType = 'STATIC' | 'BLOG' | 'FAQ' | 'POLICY' | 'LANDING' | 'CUSTOM';
export type ContentPageStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface ContentPage {
  id: string;
  type: ContentPageType;
  status: ContentPageStatus;
  title: string;
  slug: string;
  excerpt?: string;
  content: string;
  metaTitle?: string;
  metaDescription?: string;
  featuredImage?: string;
  authorName?: string;
  publishedAt?: string;
  viewCount: number;
  showInMenu: boolean;
  showInFooter: boolean;
  isFeatured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContentPagesResponse {
  data: ContentPage[];
  tenantId: string;
}

/**
 * Hook to fetch content pages for a tenant.
 */
export function useContentPages(tenantId: string | null) {
  const url = tenantId ? `/api/content?tenantId=${tenantId}` : null;
  return useApi<ContentPagesResponse>(url);
}

/**
 * Save the full content pages array for a tenant.
 */
export async function saveContentPages(tenantId: string, contentPages: ContentPage[]) {
  return apiFetch('/api/content', {
    method: 'PATCH',
    body: JSON.stringify({ tenantId, contentPages }),
  });
}

/**
 * Create a new content page and save to backend.
 */
export function createPage(
  pages: ContentPage[],
  page: Omit<ContentPage, 'id' | 'createdAt' | 'updatedAt' | 'viewCount'>
): ContentPage[] {
  const now = new Date().toISOString();
  const newPage: ContentPage = {
    ...page,
    id: crypto.randomUUID(),
    viewCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  return [...pages, newPage];
}

/**
 * Update an existing page in the array.
 */
export function updatePage(pages: ContentPage[], id: string, updates: Partial<ContentPage>): ContentPage[] {
  return pages.map(p =>
    p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p
  );
}

/**
 * Delete a page from the array.
 */
export function deletePage(pages: ContentPage[], id: string): ContentPage[] {
  return pages.filter(p => p.id !== id);
}

/**
 * Publish a page.
 */
export function publishPage(pages: ContentPage[], id: string): ContentPage[] {
  return updatePage(pages, id, { status: 'PUBLISHED', publishedAt: new Date().toISOString() });
}

/**
 * Unpublish a page (revert to draft).
 */
export function unpublishPage(pages: ContentPage[], id: string): ContentPage[] {
  return updatePage(pages, id, { status: 'DRAFT' });
}

/**
 * Archive a page.
 */
export function archivePage(pages: ContentPage[], id: string): ContentPage[] {
  return updatePage(pages, id, { status: 'ARCHIVED' });
}

/**
 * Generate a slug from a title.
 */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
