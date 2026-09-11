import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './styles.css';
import { GalleryPage } from './public/GalleryPage';
import { SubgalleryPage } from './public/SubgalleryPage';
import { AdminApp } from './admin/AdminApp';
import { Footer } from './public/Footer';

function Home() {
  return (
    <div className="center-screen">
      <div className="brand-mark">Content by Carmack</div>
      <p className="muted">Client galleries. Follow the link you were sent to view your photos.</p>
      <Footer />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="/:gallery" element={<GalleryPage />} />
        <Route path="/:gallery/:sub" element={<SubgalleryPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
