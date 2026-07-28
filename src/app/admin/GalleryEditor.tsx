import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, formatBytes } from '../api';
import type { AdminGalleryDetail, AdminSubgallery, PhotoInfo } from '../../shared/types';
import { slugify } from './AdminApp';
import { UploadPanel } from './UploadPanel';
import { AdminPhotoGrid } from './AdminPhotoGrid';

export function GalleryEditor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<AdminGalleryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.adminGallery(id).then(setDetail, (e) => setError(String(e)));
  }, [id]);
  useEffect(reload, [reload]);

  if (error) return <div className="error-text">{error}</div>;
  if (!detail) return <div className="muted">Loading…</div>;

  return (
    <>
      <SettingsCard detail={detail} onSaved={reload} />
      <ShareCard detail={detail} />
      <UploadPanel galleryId={detail.id} subgalleries={detail.subgalleries} onChanged={reload} />
      <SubgalleriesCard detail={detail} onChanged={reload} />
      {detail.photos.length > 0 && (
        <div className="card">
          <h2>Photos — gallery root ({detail.photos.length})</h2>
          <p className="muted" style={{ marginTop: '-0.4rem', fontSize: '0.85rem' }}>
            Select one photo and “Set as splash image” to choose the full-screen photo shown before
            clients enter the gallery.
          </p>
          <AdminPhotoGrid
            photos={detail.photos}
            bucketUrl={detail.bucket_url}
            onDeleted={reload}
            onSetGalleryCover={(pid) =>
              void api.updateGallery(detail.id, { cover_photo_id: pid }).then(reload)
            }
          />
        </div>
      )}
      <ZipsCard detail={detail} onChanged={reload} />
      <div className="card">
        <h2>Danger zone</h2>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (window.confirm(`Move “${detail.title}” to trash? Clients will lose access until restored.`)) {
              void api.deleteGallery(detail.id).then(() => navigate('/admin'));
            }
          }}
        >
          Move gallery to trash
        </button>
      </div>
    </>
  );
}

function SettingsCard({ detail, onSaved }: { detail: AdminGalleryDetail; onSaved: () => void }) {
  const [title, setTitle] = useState(detail.title);
  const [slug, setSlug] = useState(detail.slug);
  const [description, setDescription] = useState(detail.description ?? '');
  const [shootDate, setShootDate] = useState(detail.shoot_date ?? '');
  const [password, setPassword] = useState(detail.password ?? '');
  const [includeSubs, setIncludeSubs] = useState(detail.zip_includes_subs === 1);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const includeSubsChanged = includeSubs !== (detail.zip_includes_subs === 1);
      await api.updateGallery(detail.id, {
        title,
        slug,
        description: description || null,
        shoot_date: shootDate || null,
        password: password || null,
        zip_includes_subs: includeSubs,
      });
      if (includeSubsChanged) await api.rebuildZips(detail.id);
      setMsg('Saved.');
      onSaved();
    } catch (e) {
      setMsg(String(e));
    }
    setSaving(false);
  };

  return (
    <div className="card">
      <h2>{detail.title}</h2>
      <div className="field">
        <label>Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Slug</label>
        <input className="input" value={slug} onChange={(e) => setSlug(slugify(e.target.value))} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label>Shoot date (shown on the splash page, optional)</label>
        <input
          className="input"
          type="date"
          value={shootDate}
          onChange={(e) => setShootDate(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Password (blank = anyone with the link)</label>
        <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.9rem', fontSize: '0.9rem' }}>
        <input type="checkbox" checked={includeSubs} onChange={(e) => setIncludeSubs(e.target.checked)} />
        Also build one gallery-wide ZIP spanning all sub-galleries
      </label>
      <div className="row-actions">
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && <span className="muted" style={{ fontSize: '0.85rem' }}>{msg}</span>}
      </div>
    </div>
  );
}

function ShareCard({ detail }: { detail: AdminGalleryDetail }) {
  const [copied, setCopied] = useState<string | null>(null);
  const base = `${window.location.origin}/${detail.slug}`;

  const copy = (label: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <div className="card">
      <h2>Share</h2>
      <div className="row-actions">
        <button className="btn" onClick={() => copy('link', base)}>
          {copied === 'link' ? 'Copied ✓' : 'Copy link'}
        </button>
        {detail.password ? (
          <button
            className="btn"
            onClick={() => copy('baked', `${base}?k=${encodeURIComponent(detail.password!)}`)}
          >
            {copied === 'baked' ? 'Copied ✓' : 'Copy link with password'}
          </button>
        ) : (
          <span className="muted" style={{ fontSize: '0.85rem' }}>No password set — the plain link opens directly.</span>
        )}
      </div>
      {detail.password && (
        <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
          “Copy link” sends clients to a password form (password: <code>{detail.password}</code>).
          “Copy link with password” opens without typing, but the password rides along in the URL —
          fine for team emails, avoid for anything sensitive.
        </p>
      )}
    </div>
  );
}

function SubgalleriesCard({ detail, onChanged }: { detail: AdminGalleryDetail; onChanged: () => void }) {
  const [title, setTitle] = useState('');
  const subs = detail.subgalleries;

  const move = async (i: number, dir: -1 | 1) => {
    const a = subs[i];
    const b = subs[i + dir];
    if (!a || !b) return;
    await Promise.all([
      api.updateSubgallery(a.id, { sort_order: i + dir }),
      api.updateSubgallery(b.id, { sort_order: i }),
    ]);
    onChanged();
  };

  return (
    <div className="card">
      <h2>Sub-galleries</h2>
      {subs.map((s, i) => (
        <SubRow
          key={s.id}
          sub={s}
          detail={detail}
          canUp={i > 0}
          canDown={i < subs.length - 1}
          onMoveUp={() => void move(i, -1)}
          onMoveDown={() => void move(i, 1)}
          onChanged={onChanged}
        />
      ))}
      <div className="row-actions" style={{ marginTop: '0.75rem' }}>
        <input
          className="input"
          style={{ maxWidth: '18rem' }}
          placeholder="New sub-gallery title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button
          className="btn"
          disabled={!title.trim()}
          onClick={() => {
            void api
              .createSubgallery({
                gallery_id: detail.id,
                slug: slugify(title),
                title: title.trim(),
                sort_order: subs.length,
              })
              .then(() => {
                setTitle('');
                onChanged();
              });
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function SubRow({
  sub,
  detail,
  canUp,
  canDown,
  onMoveUp,
  onMoveDown,
  onChanged,
}: {
  sub: AdminSubgallery;
  detail: AdminGalleryDetail;
  canUp: boolean;
  canDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [photos, setPhotos] = useState<PhotoInfo[] | null>(null);

  const loadPhotos = useCallback(() => {
    void api.subgalleryPhotos(sub.id).then(setPhotos);
  }, [sub.id]);

  useEffect(() => {
    if (expanded) loadPhotos();
  }, [expanded, loadPhotos]);

  const rename = () => {
    const next = window.prompt('Sub-gallery title:', sub.title);
    if (next?.trim() && next !== sub.title) {
      void api.updateSubgallery(sub.id, { title: next.trim(), slug: slugify(next) }).then(onChanged);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '0.6rem 0' }}>
      <div className="row-actions">
        <strong style={{ flex: '1 1 auto', cursor: 'pointer' }} onClick={() => setExpanded(!expanded)}>
          {expanded ? '▾' : '▸'} {sub.title}{' '}
          <span className="muted" style={{ fontWeight: 400, fontSize: '0.85rem' }}>
            /{sub.slug} · {sub.photo_count} photos
          </span>
        </strong>
        <button className="btn btn-sm" disabled={!canUp} onClick={onMoveUp} aria-label="Move up">↑</button>
        <button className="btn btn-sm" disabled={!canDown} onClick={onMoveDown} aria-label="Move down">↓</button>
        <button className="btn btn-sm" onClick={rename}>Rename</button>
        <button
          className="btn btn-sm btn-danger"
          onClick={() => {
            if (window.confirm(`Move “${sub.title}” (${sub.photo_count} photos) to trash?`)) {
              void api.deleteSubgallery(sub.id).then(onChanged);
            }
          }}
        >
          Delete
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: '0.6rem' }}>
          {photos === null ? (
            <div className="muted">Loading…</div>
          ) : (
            <AdminPhotoGrid
              photos={photos}
              bucketUrl={detail.bucket_url}
              onDeleted={() => {
                loadPhotos();
                onChanged();
              }}
              onSetGalleryCover={(pid) =>
                void api.updateGallery(detail.id, { cover_photo_id: pid }).then(onChanged)
              }
              onSetSubCover={(pid) =>
                void api.updateSubgallery(sub.id, { cover_photo_id: pid }).then(onChanged)
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function ZipsCard({ detail, onChanged }: { detail: AdminGalleryDetail; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const subTitle = (subId: string | null) =>
    subId === null
      ? 'Gallery' + (detail.zip_includes_subs ? ' (spans sub-galleries)' : ' root')
      : detail.subgalleries.find((s) => s.id === subId)?.title ?? '(deleted sub-gallery)';

  const anyPending = detail.zips.some((z) => z.status === 'stale' || z.status === 'building');
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(onChanged, 5000);
    return () => clearInterval(t);
  }, [anyPending, onChanged]);

  return (
    <div className="card">
      <h2>Downloads (ZIPs)</h2>
      {detail.zips.length === 0 ? (
        <div className="muted" style={{ marginBottom: '0.6rem' }}>
          No archives yet — they're created after uploads, or with the button below.
        </div>
      ) : (
        <table className="table" style={{ marginBottom: '0.75rem' }}>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Status</th>
              <th>Size</th>
              <th>Photos</th>
            </tr>
          </thead>
          <tbody>
            {detail.zips.map((z) => (
              <tr key={z.id}>
                <td>{subTitle(z.subgallery_id)}</td>
                <td>
                  <span className={`pill ${z.status}`}>{z.status}</span>
                  {z.error && <div className="error-text" style={{ fontSize: '0.78rem' }}>{z.error}</div>}
                </td>
                <td>{z.size_bytes !== null ? formatBytes(z.size_bytes) : '—'}</td>
                <td>{z.photo_count ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        className="btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api.rebuildZips(detail.id).then(() => {
            setBusy(false);
            onChanged();
          });
        }}
      >
        {busy ? 'Queuing…' : 'Rebuild Downloads'}
      </button>
    </div>
  );
}
