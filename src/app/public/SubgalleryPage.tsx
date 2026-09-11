import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { PublicSubgallery } from '../../shared/types';
import { useProtectedGallery } from './useProtectedGallery';
import { Loading, NotFound, PasswordGate } from './PasswordGate';
import { JustifiedGrid } from './JustifiedGrid';
import { Lightbox } from './Lightbox';
import { ZipButton } from './ZipButton';
import { Footer } from './Footer';

export function SubgalleryPage() {
  const { gallery: slug = '', sub = '' } = useParams();
  const fetcher = useCallback(() => api.subgallery(slug, sub), [slug, sub]);
  const { state, reload, submitPassword } = useProtectedGallery<PublicSubgallery>(slug, fetcher);
  const [lightbox, setLightbox] = useState<number | null>(null);

  if (state.kind === 'loading') return <Loading />;
  if (state.kind === 'notfound') return <NotFound />;
  if (state.kind === 'locked') return <PasswordGate title={state.title} onSubmit={submitPassword} />;

  const s = state.data;
  return (
    <div className="page">
      <header className="gallery-header">
        <Link className="back" to={`/${s.gallery_slug}`}>
          ← {s.gallery_title}
        </Link>
        <h1>{s.title}</h1>
        <ZipButton zip={s.zip} onPoll={() => void reload()} />
      </header>

      {s.photos.length > 0 ? (
        <JustifiedGrid photos={s.photos} bucketUrl={s.bucket_url} onOpen={setLightbox} />
      ) : (
        <p className="muted">No photos here yet — check back soon.</p>
      )}

      {lightbox !== null && (
        <Lightbox
          photos={s.photos}
          bucketUrl={s.bucket_url}
          index={lightbox}
          onNavigate={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
      <Footer />
    </div>
  );
}
