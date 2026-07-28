interface Props {
  title: string;
  shootDate: string | null;
  coverUrl: string | null;
  onEnter: () => void;
}

function formatShootDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function Splash({ title, shootDate, coverUrl, onEnter }: Props) {
  return (
    <div className="splash" style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : undefined}>
      <div className="splash-scrim" />
      <div className="splash-content">
        <div className="brand-mark">Content by Carmack</div>
        <h1>{title}</h1>
        {shootDate && <p className="splash-date">{formatShootDate(shootDate)}</p>}
        <button className="btn btn-primary" onClick={onEnter}>
          Enter Gallery
        </button>
      </div>
    </div>
  );
}
