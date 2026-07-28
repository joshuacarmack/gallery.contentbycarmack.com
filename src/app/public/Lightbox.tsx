import { useCallback, useEffect, useRef } from 'react';
import type { PhotoInfo } from '../../shared/types';

interface Props {
  photos: PhotoInfo[];
  bucketUrl: string;
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
}

const isIos =
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1));

export function Lightbox({ photos, bucketUrl, index, onNavigate, onClose }: Props) {
  const photo = photos[index];
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const prev = useCallback(
    () => onNavigate(index > 0 ? index - 1 : photos.length - 1),
    [index, photos.length, onNavigate],
  );
  const next = useCallback(
    () => onNavigate(index < photos.length - 1 ? index + 1 : 0),
    [index, photos.length, onNavigate],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, onClose]);

  // Preload the adjacent image in each direction (§10).
  useEffect(() => {
    for (const i of [index - 1, index + 1]) {
      const p = photos[(i + photos.length) % photos.length];
      if (p) new Image().src = `${bucketUrl}/p/${p.id}/f.jpg`;
    }
  }, [index, photos, bucketUrl]);

  // Lock body scroll while open.
  useEffect(() => {
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
    };
  }, []);

  if (!photo) return null;

  return (
    <div
      className="lightbox"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (t) touchStart.current = { x: t.clientX, y: t.clientY };
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current;
        const t = e.changedTouches[0];
        touchStart.current = null;
        if (!start || !t) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) next();
          else prev();
        }
      }}
    >
      {/* Full-size image — a right-click save from here gets full quality (§8). */}
      <img src={`${bucketUrl}/p/${photo.id}/f.jpg`} alt={photo.filename} />

      <button className="lb-btn lb-close" onClick={onClose} aria-label="Close">
        ✕
      </button>
      {photos.length > 1 && (
        <>
          <button className="lb-btn lb-prev" onClick={prev} aria-label="Previous">
            ‹
          </button>
          <button className="lb-btn lb-next" onClick={next} aria-label="Next">
            ›
          </button>
        </>
      )}
      {isIos && <div className="lb-hint">To save to your camera roll: press and hold the photo, then “Add to Photos”.</div>}
      <a className="btn btn-primary lb-download" href={`/d/${photo.id}`}>
        Download
      </a>
    </div>
  );
}
