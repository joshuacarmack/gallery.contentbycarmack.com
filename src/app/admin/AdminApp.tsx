import { Link, Route, Routes } from 'react-router-dom';
import { GalleryList } from './GalleryList';
import { GalleryEditor } from './GalleryEditor';

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function AdminApp() {
  return (
    <div className="admin-shell">
      <div className="admin-topbar">
        <h1>
          <Link to="/admin" style={{ textDecoration: 'none' }}>
            CBC Gallery Admin
          </Link>
        </h1>
        <div className="spacer" />
      </div>
      <Routes>
        <Route index element={<GalleryList />} />
        <Route path="g/:id" element={<GalleryEditor />} />
      </Routes>
    </div>
  );
}
