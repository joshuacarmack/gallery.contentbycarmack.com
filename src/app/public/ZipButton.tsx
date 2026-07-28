import { useEffect } from 'react';
import type { ZipInfo } from '../../shared/types';
import { formatBytes } from '../api';

interface Props {
  zip: ZipInfo | null;
  onPoll: () => void; // re-fetch gallery JSON while the zip is being prepared
}

export function ZipButton({ zip, onPoll }: Props) {
  const pending = zip !== null && (zip.status === 'stale' || zip.status === 'building');

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(onPoll, 5000);
    return () => clearInterval(t);
  }, [pending, onPoll]);

  if (!zip || zip.status === 'failed') return null; // individual downloads still work (§7)

  if (pending) {
    return (
      <button className="btn" disabled>
        Preparing download…
      </button>
    );
  }
  return (
    <a className="btn" href={`/z/${zip.id}`}>
      Download All ({formatBytes(zip.size_bytes)})
    </a>
  );
}
