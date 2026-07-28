import { useRef, useState } from 'react';
import { api } from '../api';
import type { AdminSubgallery } from '../../shared/types';
import { slugify } from './AdminApp';
import {
  runBatch,
  requeueFailed,
  walkDataTransfer,
  type BatchSummary,
  type UploadTask,
} from './uploader';

interface Props {
  galleryId: string;
  subgalleries: AdminSubgallery[];
  onChanged: () => void; // photos or subs changed — refresh gallery detail
}

export function UploadPanel({ galleryId, subgalleries, onChanged }: Props) {
  const [target, setTarget] = useState<string>(''); // '' = gallery root
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const tasksRef = useRef<UploadTask[]>([]);

  const pump = () => setTasks([...tasksRef.current]);

  /** Resolve dropped subfolder names to sub-gallery ids, creating them as needed. */
  const resolveSubfolders = async (
    walked: { file: File; subfolder: string | null }[],
  ): Promise<UploadTask[]> => {
    const bySlug = new Map(subgalleries.map((s) => [s.slug, s.id]));
    const created = new Map<string, string>();
    const out: UploadTask[] = [];
    for (const { file, subfolder } of walked) {
      let subId: string | null = subfolder ? null : target || null;
      if (subfolder) {
        const slug = slugify(subfolder);
        subId = bySlug.get(slug) ?? created.get(slug) ?? null;
        if (!subId) {
          const res = await api.createSubgallery({
            gallery_id: galleryId,
            slug,
            title: subfolder,
            sort_order: subgalleries.length + created.size,
          });
          created.set(slug, res.id);
          subId = res.id;
        }
      }
      out.push({ file, subfolder, subgalleryId: subId, status: 'queued', progress: 0 });
    }
    if (created.size > 0) onChanged();
    return out;
  };

  const start = async (newTasks: UploadTask[]) => {
    if (newTasks.length === 0) return;
    tasksRef.current = newTasks;
    pump();
    setSummary(null);
    setRunning(true);
    const result = await runBatch(galleryId, tasksRef.current, pump);
    setSummary(result);
    setRunning(false);
    onChanged();
    void api.rebuildZips(galleryId); // §6: rebuild trigger after each batch
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (running) return;
    const walked = await walkDataTransfer(e.dataTransfer);
    await start(await resolveSubfolders(walked.files));
  };

  const onPick = async (files: FileList | null) => {
    if (!files || running) return;
    const walked = [...files]
      .filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name) || f.type.startsWith('image/'))
      .map((file) => ({ file, subfolder: null }));
    await start(await resolveSubfolders(walked));
  };

  const total = tasks.length;
  const finished = tasks.filter((t) => t.status === 'done' || t.status === 'skipped' || t.status === 'failed').length;
  const overall =
    total === 0 ? 0 : tasks.reduce((s, t) => s + (t.status === 'done' || t.status === 'skipped' ? 1 : t.progress), 0) / total;
  const failed = tasks.filter((t) => t.status === 'failed');

  return (
    <div className="card">
      <h2>Upload</h2>
      <div className="field">
        <label>Upload target (folder drops create sub-galleries automatically)</label>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Gallery root</option>
          {subgalleries.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>

      <div
        className={`dropzone${drag ? ' drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => void onDrop(e)}
        onClick={() => fileInput.current?.click()}
      >
        Drop photos or a folder tree here — or click to select files
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void onPick(e.target.files);
          e.target.value = '';
        }}
      />

      {total > 0 && (
        <div style={{ marginTop: '0.9rem' }}>
          <div className="progress-track" style={{ marginBottom: '0.5rem' }}>
            <div className="progress-fill" style={{ width: `${Math.round(overall * 100)}%` }} />
          </div>
          <div className="muted" style={{ fontSize: '0.85rem' }}>
            {finished} / {total} files
            {running ? '…' : ' — finished'}
          </div>

          {summary && (
            <div style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
              <strong>{summary.selected}</strong> selected · <strong>{summary.uploaded}</strong> uploaded ·{' '}
              <strong>{summary.skipped}</strong> skipped (duplicates) ·{' '}
              <strong style={{ color: summary.failed > 0 ? 'var(--danger)' : undefined }}>
                {summary.failed}
              </strong>{' '}
              failed
            </div>
          )}

          {failed.length > 0 && !running && (
            <div style={{ marginTop: '0.6rem' }}>
              {failed.map((t, i) => (
                <div className="upload-item" key={i}>
                  <span className="name">{t.file.name}</span>
                  <span className="error-text">{t.error}</span>
                </div>
              ))}
              <button
                className="btn btn-sm"
                onClick={() => {
                  requeueFailed(tasksRef.current);
                  void start(tasksRef.current);
                }}
              >
                Retry failed ({failed.length})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
