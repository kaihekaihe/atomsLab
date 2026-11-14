import { client } from '@/lib/api';
import type { ProjectDetail, ProjectSummary, RecordData, RunView, ShareView } from './types';

const BASE = '/api/v1/atomlab';

export function errorMessage(e: any, fallback = '请求失败'): string {
  const detail = e?.data?.detail ?? e?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length) return detail.map((d: any) => d?.msg ?? String(d)).join('；');
  return e?.message || fallback;
}

async function call<T>(url: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET', data?: unknown): Promise<T> {
  try {
    const response = await client.apiCall.invoke({ url: `${BASE}${url}`, method, data: data ?? {} });
    return response.data as T;
  } catch (e) {
    throw new Error(errorMessage(e));
  }
}

export const atomlab = {
  listProjects: () => call<{ projects: ProjectSummary[] }>('/projects'),
  createProject: (name: string) => call<{ project: { id: number; name: string } }>('/projects', 'POST', { name }),
  renameProject: (id: number, name: string) => call(`/projects/${id}`, 'PATCH', { name }),
  deleteProject: (id: number) => call(`/projects/${id}`, 'DELETE'),
  getProject: (id: number) => call<ProjectDetail>(`/projects/${id}`),
  generate: (id: number, prompt: string) => call<{ runId: number }>(`/projects/${id}/generate`, 'POST', { prompt }),
  getRun: (runId: number) => call<RunView>(`/runs/${runId}`),
  createRecord: (id: number, values: Record<string, unknown>) =>
    call<{ record: RecordData }>(`/projects/${id}/records`, 'POST', { data: values }),
  updateRecord: (id: number, rid: number, values: Record<string, unknown>) =>
    call<{ record: RecordData }>(`/projects/${id}/records/${rid}`, 'PUT', { data: values }),
  deleteRecord: (id: number, rid: number) => call(`/projects/${id}/records/${rid}`, 'DELETE'),
  restoreVersion: (id: number, vid: number) => call<{ version: number }>(`/projects/${id}/versions/${vid}/restore`, 'POST'),
  publish: (id: number) => call<{ token: string }>(`/projects/${id}/publish`, 'POST'),
  unpublish: (id: number) => call(`/projects/${id}/publish`, 'DELETE'),
  exportCsv: (id: number) => call<{ filename: string; csv: string; count: number }>(`/projects/${id}/export`),
  readShare: (token: string) => call<ShareView>(`/share/${encodeURIComponent(token)}`),
};

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
