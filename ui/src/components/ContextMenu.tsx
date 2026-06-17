import { useEffect } from 'react';

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

// A small right-click menu positioned at (x, y). Closes on outside click / Escape.
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('click', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  return (
    <div
      className="ctx-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((it, i) => (
        <button
          key={i}
          className={`ctx-item ${it.danger ? 'danger' : ''}`}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
