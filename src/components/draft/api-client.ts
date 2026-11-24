import { request, post } from '../../api/client';
export const getJson = (url: string) => request<Record<string, unknown>>(url);
export const postJson = (url: string, body?: unknown) => post<Record<string, unknown>>(url, body);
export const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
