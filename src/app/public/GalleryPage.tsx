import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { PublicGallery } from '../../shared/types';
import { useProtectedGallery } from './useProtectedGallery';
import { Loading, NotFound, PasswordGate } from './PasswordGate';
import { JustifiedGrid } from './JustifiedGrid';
import { Lightbox } from './Lightbox';
import { ZipButton } from './ZipButton';

export function GalleryPage() {
  const { gallery: slug = '' } = useParams();
  const fetcher = useCallback(() => api.gallery(slug), [slug]);
  const { state, reload, submitPassword } = useProtectedGallery<PublicGallery>(slug, fetcher);
  const [lightbox, setLightbox] = useState<number | null>(null);

  if (state.kind === 'loading') return <Loading />;
  if (state.kind === 'notfound') return <NotFound />;
  if (state.kind === 'locked') return <PasswordGate title={state.title} onSubmit={submitPassword} />;

  const g = state.data;
  return (
    <div className="page">
      <header className="gallery-header">
        <h1>{g.title}</h1>
        {g.photos.length > 0 && <ZipButton zip={g.zip} onPoll={() => void reload()} />}
      </header>
      {g.description && <p className="gallery-desc">{g.description}</p>}

      {g.subgalleries.length > 0 && (
        <div className="sub-cards">
          {g.subgalleries.map((s) => (
            <Link className="sub-card" key={s.id} to={`/${g.slug}/${s.slug}`}>
              {s.cover_photo_id ? (
                <img
                  className="cover"
                  src={`${g.bucket_url}/p/${s.cover_photo_id}/t.jpg`}
                  alt={s.title}
                  loading="lazy"
                />
              ) : (
                <div className="cover-blank">◻</div>
              )}
              <div className="meta">
                <div className="title">{s.title}</div>
                <div className="count">
                  {s.photo_count} photo{s.photo_count === 1 ? '' : 's'}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {g.photos.length > 0 && (
        <JustifiedGrid photos={g.photos} bucketUrl={g.bucket_url} onOpen={setLightbox} />
      )}

      {g.subgalleries.length === 0 && g.photos.length === 0 && (
        <p className="muted">No photos here yet — check back soon.</p>
      )}

      {lightbox !== null && (
        <Lightbox
          photos={g.photos}
          bucketUrl={g.bucket_url}
          index={lightbox}
          onNavigate={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
