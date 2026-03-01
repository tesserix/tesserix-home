"use client";

import { useApi, apiFetch } from './use-api';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FAQ {
  id: string;
  question: string;
  answer: string;
  categoryId: string | null;
  pageContext: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  category?: { id: string; name: string; slug: string } | null;
}

export interface Feature {
  id: string;
  title: string;
  description: string;
  iconName: string | null;
  category: string | null;
  pageContext: string;
  sortOrder: number;
  active: boolean;
}

export interface Testimonial {
  id: string;
  quote: string;
  name: string;
  role: string | null;
  company: string | null;
  initials: string | null;
  rating: number;
  featured: boolean;
  pageContext: string;
  sortOrder: number;
  active: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrustBadge {
  id: string;
  label: string;
  iconName: string | null;
  description: string | null;
  sortOrder: number;
  active: boolean;
}

export interface PlanFeature {
  id: string;
  planId: string;
  feature: string;
  sortOrder: number;
  highlighted: boolean;
}

export interface PaymentPlan {
  id: string;
  name: string;
  slug: string;
  price: string;
  currency: string;
  billingCycle: string;
  trialDays: number;
  description: string | null;
  tagline: string | null;
  featured: boolean;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  features: PlanFeature[];
}

export interface Contact {
  id: string;
  type: string;
  label: string;
  email: string | null;
  phone: string | null;
  sortOrder: number;
  active: boolean;
}

export interface IntegrationFeature {
  id: string;
  integrationId: string;
  feature: string;
  sortOrder: number;
}

export interface Integration {
  id: string;
  name: string;
  category: string;
  description: string | null;
  logoUrl: string | null;
  status: string;
  sortOrder: number;
  active: boolean;
  features: IntegrationFeature[];
}

export interface GuideStep {
  id: string;
  guideId: string;
  title: string;
  description: string | null;
  content: string | null;
  duration: string | null;
  sortOrder: number;
}

export interface Guide {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  iconName: string | null;
  duration: string | null;
  featured: boolean;
  content: string | null;
  sortOrder: number;
  active: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  steps: GuideStep[];
}

export interface PresentationSlide {
  id: string;
  slideNumber: number;
  type: string;
  label: string | null;
  title: string | null;
  titleGradient: string | null;
  titleHighlight: string | null;
  subtitle: string | null;
  content: unknown;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CountryDefault {
  id: string;
  countryCode: string;
  countryName: string;
  defaultCurrency: string;
  defaultTimezone: string;
  defaultLanguage: string;
  callingCode: string | null;
  flagEmoji: string | null;
  active: boolean;
}

// ─── Content type registry ───────────────────────────────────────────────────

export type ContentType =
  | 'faqs'
  | 'features'
  | 'testimonials'
  | 'trust-badges'
  | 'payment-plans'
  | 'contacts'
  | 'integrations'
  | 'guides'
  | 'presentation-slides'
  | 'country-defaults';

export interface ContentTypeConfig {
  key: ContentType;
  label: string;
  shortLabel: string;
}

export const CONTENT_TYPES: ContentTypeConfig[] = [
  { key: 'faqs', label: 'FAQs', shortLabel: 'FAQs' },
  { key: 'features', label: 'Features', shortLabel: 'Features' },
  { key: 'testimonials', label: 'Testimonials', shortLabel: 'Testimonials' },
  { key: 'trust-badges', label: 'Trust Badges', shortLabel: 'Badges' },

  { key: 'contacts', label: 'Contacts', shortLabel: 'Contacts' },
  { key: 'integrations', label: 'Integrations', shortLabel: 'Integrations' },
  { key: 'guides', label: 'Guides', shortLabel: 'Guides' },
  { key: 'presentation-slides', label: 'Presentation Slides', shortLabel: 'Slides' },
  { key: 'country-defaults', label: 'Country Defaults', shortLabel: 'Countries' },
];

// ─── Type map for generic hooks ──────────────────────────────────────────────

export type ContentTypeMap = {
  faqs: FAQ;
  features: Feature;
  testimonials: Testimonial;
  'trust-badges': TrustBadge;
  'payment-plans': PaymentPlan;
  contacts: Contact;
  integrations: Integration;
  guides: Guide;
  'presentation-slides': PresentationSlide;
  'country-defaults': CountryDefault;
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

const BASE_PATH = '/api/onboarding-content';

/**
 * Hook to fetch all items for a given content type.
 */
export function useOnboardingContent<K extends ContentType>(type: K) {
  return useApi<{ data: ContentTypeMap[K][] }>(`${BASE_PATH}/${type}`);
}

/**
 * Hook to fetch a single item by ID.
 */
export function useOnboardingItem<K extends ContentType>(type: K, id: string | null) {
  return useApi<{ data: ContentTypeMap[K] }>(id ? `${BASE_PATH}/${type}/${id}` : null);
}

/**
 * Create a new onboarding content item.
 */
export async function createOnboardingItem<K extends ContentType>(
  type: K,
  data: Partial<ContentTypeMap[K]>
) {
  return apiFetch<{ data: ContentTypeMap[K] }>(`${BASE_PATH}/${type}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Update an existing onboarding content item.
 */
export async function updateOnboardingItem<K extends ContentType>(
  type: K,
  id: string,
  data: Partial<ContentTypeMap[K]>
) {
  return apiFetch<{ data: ContentTypeMap[K] }>(`${BASE_PATH}/${type}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/**
 * Delete an onboarding content item.
 */
export async function deleteOnboardingItem(type: ContentType, id: string) {
  return apiFetch(`${BASE_PATH}/${type}/${id}`, {
    method: 'DELETE',
  });
}

// ─── Regional pricing ───────────────────────────────────────────────────────

export interface RegionalPricing {
  id: string;
  planId: string;
  countryCode: string;
  price: string;
  currency: string;
}

export function useRegionalPricing(planId: string | null) {
  return useApi<{ data: RegionalPricing[] }>(
    planId ? `${BASE_PATH}/payment-plans/${planId}/regional-pricing` : null
  );
}

export async function createRegionalPricing(
  planId: string,
  data: { countryCode: string; price: string; currency: string }
) {
  return apiFetch<{ data: RegionalPricing }>(
    `${BASE_PATH}/payment-plans/${planId}/regional-pricing`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

export async function updateRegionalPricing(
  planId: string,
  pricingId: string,
  data: Partial<{ countryCode: string; price: string; currency: string }>
) {
  return apiFetch<{ data: RegionalPricing }>(
    `${BASE_PATH}/payment-plans/${planId}/regional-pricing/${pricingId}`,
    { method: 'PUT', body: JSON.stringify(data) }
  );
}

export async function deleteRegionalPricing(planId: string, pricingId: string) {
  return apiFetch(
    `${BASE_PATH}/payment-plans/${planId}/regional-pricing/${pricingId}`,
    { method: 'DELETE' }
  );
}

// ─── Nested resource helpers (guide steps, plan features, integration features) ──

export async function createGuideStep(guideId: string, data: Partial<GuideStep>) {
  return apiFetch<{ data: GuideStep }>(`${BASE_PATH}/guides/${guideId}/steps`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateGuideStep(guideId: string, stepId: string, data: Partial<GuideStep>) {
  return apiFetch<{ data: GuideStep }>(`${BASE_PATH}/guides/${guideId}/steps/${stepId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteGuideStep(guideId: string, stepId: string) {
  return apiFetch(`${BASE_PATH}/guides/${guideId}/steps/${stepId}`, {
    method: 'DELETE',
  });
}

// ─── Testimonial approval actions ──────────────────────────────────────────

export async function approveTestimonial(
  id: string,
  data: { pageContext?: string; reviewedBy?: string }
) {
  return apiFetch<{ data: Testimonial; message: string }>(
    `${BASE_PATH}/testimonials/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ action: 'approve', ...data }),
    }
  );
}

export async function rejectTestimonial(
  id: string,
  data: { revisionNotes?: string; reviewedBy?: string }
) {
  return apiFetch<{ data: Testimonial; message: string }>(
    `${BASE_PATH}/testimonials/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ action: 'reject', ...data }),
    }
  );
}

export async function requestTestimonialRevision(
  id: string,
  data: { revisionNotes: string; reviewedBy?: string }
) {
  return apiFetch<{ data: Testimonial; message: string }>(
    `${BASE_PATH}/testimonials/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ action: 'request_revision', ...data }),
    }
  );
}
