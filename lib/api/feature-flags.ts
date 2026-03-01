"use client";

import { useApi, apiFetch } from './use-api';

export interface FeatureFlag {
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
  default_value: boolean;
  overrides?: FeatureOverride[];
  created_at?: string;
  updated_at?: string;
}

export interface FeatureOverride {
  key: string;
  value: boolean;
  context?: Record<string, string>;
  created_at?: string;
}

export interface FeatureEvaluation {
  key: string;
  enabled: boolean;
  reason: string;
}

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'completed';

export interface Experiment {
  id: string;
  name: string;
  description?: string;
  feature_key: string;
  status: ExperimentStatus;
  variants: ExperimentVariant[];
  start_date?: string;
  end_date?: string;
  metrics?: ExperimentMetrics;
  created_at?: string;
  updated_at?: string;
}

export interface ExperimentVariant {
  name: string;
  weight: number;
  value: unknown;
}

export interface ExperimentMetrics {
  total_participants: number;
  variant_results: Record<string, {
    participants: number;
    conversions: number;
    conversion_rate: number;
  }>;
}

// Hooks

export function useFeatureFlags() {
  return useApi<FeatureFlag[]>('/api/feature-flags');
}

export function useExperiments() {
  return useApi<Experiment[]>('/api/feature-flags/experiments');
}

export function useExperiment(id: string | null) {
  return useApi<Experiment>(id ? `/api/feature-flags/experiments/${id}` : null);
}

// Mutations

export async function setOverride(key: string, value: boolean, context?: Record<string, string>) {
  return apiFetch('/api/feature-flags/override', {
    method: 'POST',
    body: JSON.stringify({ key, value, context }),
  });
}

export async function clearOverride(key: string) {
  return apiFetch(`/api/feature-flags/override/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}

export async function evaluateFeature(key: string, context?: Record<string, string>) {
  return apiFetch<FeatureEvaluation>('/api/feature-flags/evaluate', {
    method: 'POST',
    body: JSON.stringify({ key, context }),
  });
}
