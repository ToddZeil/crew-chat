import { createContext, useEffect, useState } from 'react';
import type { DocResult } from '../shared/types.ts';
import { isImagePath } from './blocks.ts';
import { Markdown } from './markdown.tsx';

// Lets a file path or pasted image anywhere in a message open the preview.
export const DocContext = createContext<((path: string) => void) | null>(null);

export function DocViewer({ path, thread, onClose }: { path: string; thread: string | null; onClose: () => void }) {
  const [doc, setDoc] = useState<DocResult | null>(null);
  const [copied, setCopied] = useState(false);
  const image = isImagePath(path);

  useEffect(() => {
    setDoc(null);
    if (isImagePath(path)) return;
    const q = new URLSearchParams({ path });
    if (thread) q.set('thread', thread);
    let live = true;
    void fetch(`/api/doc?${q}`, { cache: 'no-store' })
      .then((r) => r.json() as Promise<DocResult>)
      .then(
        (d) => live && setDoc(d),
        (err: Error) => live && setDoc({ ok: false, error: `Cannot reach crew-chat: ${err.message}` }),
      );
    return () => {
      live = false;
    };
  }, [path, thread]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = path.split('/').pop() ?? path;
  return (
    <aside className="doc-viewer" role="dialog" aria-label={`Preview of ${name}`} data-testid="doc-viewer">
      <header className="doc-head">
        <div className="doc-title">
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <path d="M5 2.5h6.5L15 6v11.5H5z M11.5 2.5V6H15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <strong>{name}</strong>
          <span className="doc-path" title={doc?.path ?? path}>
            {doc?.path ?? path}
          </span>
        </div>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            void navigator.clipboard?.writeText(doc?.path ?? path).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy path'}
        </button>
        <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close preview">
          ×
        </button>
      </header>
      <div className="doc-body">
        {!image && doc === null && <p className="hint">Loading...</p>}
        {doc && !doc.ok && <p className="doc-error">{doc.error}</p>}
        {doc?.ok && doc.text !== undefined && <Markdown text={doc.text} className="md doc-md" />}
      </div>
    </aside>
  );
}

// Images open in a lightbox over the page; click outside or press Escape to close.
export function ImageViewer({ path, thread, onClose }: { path: string; thread: string | null; onClose: () => void }) {
  const q = new URLSearchParams({ path });
  if (thread) q.set('thread', thread);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const name = path.split('/').pop() ?? path;
  return (
    <div className="lightbox" role="dialog" aria-label={`Image ${name}`} data-testid="image-viewer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lightbox-bar">
        <span className="lightbox-name" title={path}>
          {name}
        </span>
        <a className="btn ghost small" href={`/api/image?${q}`} target="_blank" rel="noreferrer noopener">
          Open original
        </a>
        <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close image">
          ×
        </button>
      </div>
      <img className="lightbox-img" src={`/api/image?${q}`} alt={name} />
    </div>
  );
}
