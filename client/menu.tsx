import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuEntry =
  | { kind: 'item'; label: string; onSelect: () => void; disabled?: boolean; hint?: string; danger?: boolean; shortcut?: string }
  | { kind: 'separator' }
  | { kind: 'heading'; label: string };

// A right-click menu at the pointer, kept inside the window. Arrow keys move,
// Enter picks, Escape or a click elsewhere closes it.
export function ContextMenu({ x, y, entries, label, onClose }: { x: number; y: number; entries: MenuEntry[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - r.width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - r.height - pad)),
    });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    window.addEventListener('mousedown', away, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  const move = (step: number) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + step + items.length) % items.length].focus();
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          move(e.shiftKey ? -1 : 1);
        }
      }}
    >
      {entries.map((entry, i) =>
        entry.kind === 'separator' ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : entry.kind === 'heading' ? (
          <div key={i} className="ctx-heading">
            {entry.label}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={entry.danger ? 'ctx-item danger' : 'ctx-item'}
            disabled={entry.disabled}
            title={entry.hint}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            <span>{entry.label}</span>
            {entry.shortcut && <span className="ctx-hint">{entry.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
