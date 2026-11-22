import type { Brief, Framework } from '@open-foresight/core';

export type Config = {
  today: string; regions: string[]; exposureStyles: string[]; weightings: string[]; reviewLevels: string[]; modelProfiles: string[];
  briefLimits: { minWords: number; maxChars: number; basketSize: [number, number] };
  availableSources: string[]; sources: Record<string, string>; quantFunctions: Record<string, string>;
};
export type RunSummary = { id: string; status: string; createdAt: string; theme: string };
export type RunDetail = {
  id: string; status: string; createdAt: string; frameworkVersion: string | null;
  settings: { brief?: string; exclusions?: string[]; createdBy?: string; designError?: string[]; universe?: { status: string; note: string } };
  draft: { id: string; attempt: number; promptVersion: string; model: string; framework: Framework } | null;
  attempts: Array<{ attempt: number; valid: boolean; errors: Array<{ code: string; message: string }> }>;
  history: Array<{ status: string; at: string }>;
  decisions: Array<{ id: string; userId: string; stage: string; target: string; action: string; reason: string | null; createdAt: string }>;
  versions: Array<{ id: string; version: number; edited: boolean; approvedBy: string; createdAt: string; exclusions: string[]; framework: Framework }>;
};
export type Auth = { analyst: string; token: string };
export class ApiError extends Error {
  constructor(public status: number, public body: { error?: string; errors?: Array<{ field?: string; path?: string; code: string; message: string }> }) { super(body.error ?? `Request failed with ${status}`); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
const headers = (a: Auth) => ({ 'content-type': 'application/json', 'x-approval-token': a.token, 'x-analyst': a.analyst });
export const getConfig = () => call<Config>('/api/config');
export const listRuns = () => call<RunSummary[]>('/api/runs');
export const getRun = (id: string) => call<RunDetail>(`/api/runs/${id}`);
export const createRun = (brief: Brief | Record<string, unknown>, a: Auth) => call<{ runId: string }>('/api/runs', { method: 'POST', headers: headers(a), body: JSON.stringify(brief) });
export const approveRun = (id: string, body: { framework: Framework; exclusions: string[]; reason?: string }, a: Auth) => call<{ versionId: string; version: number; status: string }>(`/api/runs/${id}/approve`, { method: 'POST', headers: headers(a), body: JSON.stringify(body) });
