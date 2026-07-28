// Types shared between the Worker API and the React frontend.

export type ZipStatus = 'stale' | 'building' | 'ready' | 'failed';

export interface PhotoInfo {
  id: string;
  filename: string;
  width: number;
  height: number;
  size_bytes: number;
}

export interface ZipInfo {
  id: string;
  status: ZipStatus;
  size_bytes: number | null;
  photo_count: number | null;
}

export interface SubgalleryCard {
  id: string;
  slug: string;
  title: string;
  sort_order: number;
  cover_photo_id: string | null;
  photo_count: number;
}

/** GET /api/gallery/:slug */
export interface PublicGallery {
  slug: string;
  title: string;
  description: string | null;
  shoot_date: string | null;
  cover_photo_id: string | null;
  bucket_url: string;
  subgalleries: SubgalleryCard[];
  photos: PhotoInfo[]; // root-level photos
  zip: ZipInfo | null; // gallery-level zip
}

/** GET /api/gallery/:slug/:sub */
export interface PublicSubgallery {
  gallery_slug: string;
  gallery_title: string;
  slug: string;
  title: string;
  bucket_url: string;
  photos: PhotoInfo[];
  zip: ZipInfo | null;
}

/** GET /api/gallery/:slug when locked */
export interface GalleryLocked {
  locked: true;
  title: string;
}

// ---- Admin ----

export interface AdminGallerySummary {
  id: string;
  slug: string;
  title: string;
  password: string | null;
  photo_count: number;
  size_bytes: number;
  deleted_at: number | null;
  created_at: number;
}

export interface AdminSubgallery {
  id: string;
  gallery_id: string;
  slug: string;
  title: string;
  sort_order: number;
  cover_photo_id: string | null;
  photo_count: number;
  deleted_at: number | null;
}

export interface AdminGalleryDetail {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  shoot_date: string | null;
  password: string | null;
  cover_photo_id: string | null;
  zip_includes_subs: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  bucket_url: string;
  subgalleries: AdminSubgallery[];
  photos: PhotoInfo[]; // root-level
  zips: AdminZip[];
}

export interface AdminZip extends ZipInfo {
  gallery_id: string;
  subgallery_id: string | null;
  error: string | null;
  built_at: number | null;
}

export interface AdminStats {
  gallery_count: number;
  photo_count: number;
  photo_bytes: number;
  zip_bytes: number;
  total_bytes: number;
  estimated_monthly_cost_usd: number;
}

export interface UploadResult {
  id?: string;
  skipped?: boolean; // duplicate (filename + size already in target scope)
  error?: string;
}
