import { useState } from 'react';
import { api } from '../api';
import type { PhotoInfo } from '../../shared/types';

interface Props {
  photos: PhotoInfo[];
  bucketUrl: string;
  onDeleted: () => void;
  onSetGalleryCover: (photoId: string) => void;
  onSetSubCover?: (photoId: string) => void; // present when rendering a sub-gallery grid
  galleryCoverPhotoId?: string | null; // highlights the gallery's splash photo, if present in this grid
  subCoverPhotoId?: string | null; // highlights the sub-gallery's cover photo, if present in this grid
}

export function AdminPhotoGrid({
  photos,
  bucketUrl,
  onDeleted,
  onSetGalleryCover,
  onSetSubCover,
  galleryCoverPhotoId,
  subCoverPhotoId,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteSelected = async () => {
    if (!window.confirm(`Delete ${selected.size} photo${selected.size === 1 ? '' : 's'}?`)) return;
    setBusy(true);
    for (const id of selected) {
      try {
        await api.deletePhoto(id);
      } catch {
        // keep going; refresh will show what's left
      }
    }
    setSelected(new Set());
    setBusy(false);
    onDeleted();
  };

  const single = selected.size === 1 ? [...selected][0] : null;

  if (photos.length === 0) return <div className="muted">No photos.</div>;

  return (
    <>
      {selected.size > 0 && (
        <div className="row-actions" style={{ marginBottom: '0.6rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {selected.size} selected
          </span>
          {single && (
            <button className="btn btn-sm" onClick={() => onSetGalleryCover(single)}>
              Set as splash image
            </button>
          )}
          {single && onSetSubCover && (
            <button className="btn btn-sm" onClick={() => onSetSubCover(single)}>
              Set as sub-gallery cover
            </button>
          )}
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void deleteSelected()}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
          <button className="btn btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      <div className="admin-photo-grid">
        {photos.map((p) => {
          const isGalleryCover = p.id === galleryCoverPhotoId;
          const isSubCover = p.id === subCoverPhotoId;
          const badges = [
            isGalleryCover ? 'Splash' : null,
            isSubCover ? 'Cover' : null,
          ].filter(Boolean) as string[];
          return (
            <div
              key={p.id}
              className={`admin-photo${selected.has(p.id) ? ' selected' : ''}${badges.length ? ' is-cover' : ''}`}
              title={p.filename}
              onClick={() => toggle(p.id)}
            >
              <img src={`${bucketUrl}/p/${p.id}/t.jpg`} alt={p.filename} loading="lazy" />
              {badges.length > 0 && (
                <div className="cover-badges">
                  {badges.map((b) => (
                    <span key={b} className="cover-badge">★ {b}</span>
                  ))}
                </div>
              )}
              {selected.has(p.id) && <div className="check">✓</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}
