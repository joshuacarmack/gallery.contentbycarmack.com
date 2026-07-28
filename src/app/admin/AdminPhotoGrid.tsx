import { useState } from 'react';
import { api } from '../api';
import type { PhotoInfo } from '../../shared/types';

interface Props {
  photos: PhotoInfo[];
  bucketUrl: string;
  onDeleted: () => void;
  onSetGalleryCover: (photoId: string) => void;
  onSetSubCover?: (photoId: string) => void; // present when rendering a sub-gallery grid
}

export function AdminPhotoGrid({ photos, bucketUrl, onDeleted, onSetGalleryCover, onSetSubCover }: Props) {
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
        {photos.map((p) => (
          <div
            key={p.id}
            className={`admin-photo${selected.has(p.id) ? ' selected' : ''}`}
            title={p.filename}
            onClick={() => toggle(p.id)}
          >
            <img src={`${bucketUrl}/p/${p.id}/t.jpg`} alt={p.filename} loading="lazy" />
            {selected.has(p.id) && <div className="check">✓</div>}
          </div>
        ))}
      </div>
    </>
  );
}
