import { useLayoutEffect, useRef, useState } from 'react';
import type { PhotoInfo } from '../../shared/types';

// Justified rows computed from stored width/height so layout settles before
// images load (SPECS.md §10). No srcset — right-click save must never get a
// thumbnail (§8); the grid always shows t.jpg and the lightbox f.jpg.

interface Props {
  photos: PhotoInfo[];
  bucketUrl: string;
  onOpen: (index: number) => void;
}

const GAP = 4;

interface Row {
  items: { photo: PhotoInfo; index: number; w: number; h: number }[];
}

function layoutRows(photos: PhotoInfo[], containerWidth: number, targetH: number): Row[] {
  const rows: Row[] = [];
  let current: { photo: PhotoInfo; index: number; ar: number }[] = [];
  let arSum = 0;

  const flush = (last: boolean) => {
    if (current.length === 0) return;
    const gaps = GAP * (current.length - 1);
    let h = (containerWidth - gaps) / arSum;
    if (last && h > targetH * 1.15) h = targetH; // don't stretch a sparse last row
    rows.push({
      items: current.map((it, i) => ({
        photo: it.photo,
        index: it.index,
        w: i === current.length - 1 && !last
          ? containerWidth - gaps - current.slice(0, -1).reduce((s, x) => s + Math.round(x.ar * h), 0)
          : Math.round(it.ar * h),
        h: Math.round(h),
      })),
    });
    current = [];
    arSum = 0;
  };

  photos.forEach((p, index) => {
    const ar = p.width > 0 && p.height > 0 ? p.width / p.height : 1;
    current.push({ photo: p, index, ar });
    arSum += ar;
    if (arSum * targetH >= containerWidth - GAP * (current.length - 1)) flush(false);
  });
  flush(true);
  return rows;
}

export function JustifiedGrid({ photos, bucketUrl, onOpen }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const targetH = width < 520 ? 130 : width < 900 ? 180 : 230;
  const rows = width > 0 ? layoutRows(photos, width, targetH) : [];

  return (
    <div className="jgrid" ref={ref}>
      {rows.map((row, ri) => (
        <div className="jgrid-row" key={ri}>
          {row.items.map((it) => (
            <img
              key={it.photo.id}
              src={`${bucketUrl}/p/${it.photo.id}/t.jpg`}
              width={it.w}
              height={it.h}
              style={{ width: it.w, height: it.h }}
              alt={it.photo.filename}
              loading="lazy"
              onClick={() => onOpen(it.index)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
