import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, formatBytes } from '../api';
import type { AdminGallerySummary, AdminStats } from '../../shared/types';
import { slugify } from './AdminApp';

export function GalleryList() {
  const [galleries, setGalleries] = useState<AdminGallerySummary[] | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api.adminGalleries().then(setGalleries, (e) => setError(String(e)));
    api.stats().then(setStats, () => {});
  }, []);
  useEffect(load, [load]);

  // New gallery form
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await api.createGallery({ slug, title, password: password || undefined });
      navigate(`/admin/g/${res.id}`);
    } catch (e) {
      setCreateError(
        e instanceof ApiError ? String((e.body as { error?: string })?.error ?? e.message) : String(e),
      );
      setCreating(false);
    }
  };

  const active = galleries?.filter((g) => g.deleted_at === null) ?? [];
  const trashed = galleries?.filter((g) => g.deleted_at !== null) ?? [];

  return (
    <>
      {stats && (
        <div className="stat-row" style={{ marginBottom: '1rem' }}>
          <div className="stat">
            <div className="v">{stats.gallery_count}</div>
            <div className="k">galleries</div>
          </div>
          <div className="stat">
            <div className="v">{stats.photo_count}</div>
            <div className="k">photos</div>
          </div>
          <div className="stat">
            <div className="v">{formatBytes(stats.total_bytes)}</div>
            <div className="k">R2 storage (photos + zips)</div>
          </div>
          <div className="stat">
            <div className="v">${stats.estimated_monthly_cost_usd.toFixed(2)}</div>
            <div className="k">est. monthly cost</div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>New gallery</h2>
        <div className="field">
          <label>Title</label>
          <input
            className="input"
            value={title}
            placeholder="2026 Soccer"
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </div>
        <div className="field">
          <label>Slug (gallery.contentbycarmack.com/…)</label>
          <input
            className="input"
            value={slug}
            placeholder="soccer2026"
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(slugify(e.target.value));
            }}
          />
        </div>
        <div className="field">
          <label>Password (leave blank for a public link)</label>
          <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {createError && <div className="error-text" style={{ marginBottom: '0.6rem' }}>{createError}</div>}
        <button className="btn btn-primary" disabled={!title || !slug || creating} onClick={() => void create()}>
          {creating ? 'Creating…' : 'Create gallery'}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card">
        <h2>Galleries</h2>
        {galleries === null ? (
          <div className="muted">Loading…</div>
        ) : active.length === 0 ? (
          <div className="muted">No galleries yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Slug</th>
                  <th>Photos</th>
                  <th>Storage</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {active.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <Link to={`/admin/g/${g.id}`}>{g.title}</Link>
                    </td>
                    <td className="muted">/{g.slug}</td>
                    <td>{g.photo_count}</td>
                    <td>{formatBytes(g.size_bytes)}</td>
                    <td className="muted">{new Date(g.created_at * 1000).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {trashed.length > 0 && (
        <div className="card">
          <h2>Trash</h2>
          <table className="table">
            <tbody>
              {trashed.map((g) => (
                <tr key={g.id}>
                  <td>{g.title}</td>
                  <td className="muted">/{g.slug}</td>
                  <td>{g.photo_count} photos</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() => void api.restoreGallery(g.id).then(load)}
                      >
                        Restore
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Permanently delete “${g.title}” and all ${g.photo_count} photos from storage? This cannot be undone.`,
                            )
                          ) {
                            void api.purgeGallery(g.id).then(load);
                          }
                        }}
                      >
                        Delete forever
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
