import type {
  AdminGalleryDetail,
  AdminGallerySummary,
  AdminStats,
  PhotoInfo,
  PublicGallery,
  PublicSubgallery,
} from '../shared/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

// ---- Public ----

export const api = {
  gallery: (slug: string) => req<PublicGallery>(`/api/gallery/${encodeURIComponent(slug)}`),
  subgallery: (slug: string, sub: string) =>
    req<PublicSubgallery>(`/api/gallery/${encodeURIComponent(slug)}/${encodeURIComponent(sub)}`),
  auth: (slug: string, password: string) =>
    req<{ ok: boolean }>(`/api/gallery/${encodeURIComponent(slug)}/auth`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  // ---- Admin ----
  adminGalleries: () => req<AdminGallerySummary[]>('/api/admin/galleries'),
  adminGallery: (id: string) => req<AdminGalleryDetail>(`/api/admin/galleries/${id}`),
  createGallery: (data: { slug: string; title: string; description?: string; password?: string }) =>
    req<{ id: string; slug: string }>('/api/admin/galleries', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateGallery: (id: string, data: Record<string, unknown>) =>
    req<{ ok: boolean }>(`/api/admin/galleries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteGallery: (id: string) => req<{ ok: boolean }>(`/api/admin/galleries/${id}`, { method: 'DELETE' }),
  restoreGallery: (id: string) =>
    req<{ ok: boolean }>(`/api/admin/galleries/${id}/restore`, { method: 'POST' }),
  purgeGallery: (id: string) =>
    req<{ ok: boolean }>(`/api/admin/galleries/${id}/purge`, { method: 'POST' }),

  createSubgallery: (data: { gallery_id: string; slug: string; title: string; sort_order?: number }) =>
    req<{ id: string; slug: string }>('/api/admin/subgalleries', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateSubgallery: (id: string, data: Record<string, unknown>) =>
    req<{ ok: boolean }>(`/api/admin/subgalleries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteSubgallery: (id: string) =>
    req<{ ok: boolean }>(`/api/admin/subgalleries/${id}`, { method: 'DELETE' }),

  subgalleryPhotos: (subId: string) =>
    req<PhotoInfo[]>(`/api/admin/photos?subgallery_id=${encodeURIComponent(subId)}`),
  deletePhoto: (id: string) => req<{ ok: boolean }>(`/api/admin/photos/${id}`, { method: 'DELETE' }),

  rebuildZips: (galleryId: string) =>
    req<{ enqueued: number }>(`/api/admin/galleries/${galleryId}/zips/rebuild`, { method: 'POST' }),
  stats: () => req<AdminStats>('/api/admin/stats'),
};

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
