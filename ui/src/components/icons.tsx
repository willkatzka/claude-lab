// App icons (folder = directory root, log = audit/shared log), ported from the
// design source and recolored to the app's cool/accent palette: accent blue
// (#6ea8fe) folder, a light cool sheet with muted rules + accent timestamp dots
// for the log. The original warm clay/cream tones and the icon-background
// gradients are dropped so the glyphs read cleanly on the node panels.

const ACCENT = '#6ea8fe';
const ACCENT_DEEP = '#4f7fc7';
const SEP = '#141823'; // subtle dark separation between folder panels
const PAPER = '#dfe5ee';
const RULE = '#8b97aa';

export function FolderIcon({ size = '1.25em' }: { size?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'inline-block', verticalAlign: '-0.22em', flex: 'none' }}
      aria-hidden="true"
    >
      {/* back panel + tab */}
      <path
        d="M222,330 h156 a22,22 0 0 1 16,7 l44,48 a22,22 0 0 0 16,7 h312 a34,34 0 0 1 34,34 v300 a34,34 0 0 1 -34,34 H222 a34,34 0 0 1 -34,-34 V364 a34,34 0 0 1 34,-34 z"
        fill={ACCENT_DEEP}
        stroke={SEP}
        strokeWidth={28}
        strokeLinejoin="round"
      />
      {/* front flap (open folder) */}
      <path
        d="M170,486 h684 a28,28 0 0 1 27,35 l-58,232 a40,40 0 0 1 -39,30 H240 a40,40 0 0 1 -39,-30 l-58,-232 a28,28 0 0 1 27,-35 z"
        fill={ACCENT}
        stroke={SEP}
        strokeWidth={28}
        strokeLinejoin="round"
      />
      {/* root mark: a forward slash, the directory root */}
      <line x1="556" y1="588" x2="476" y2="700" stroke="#eaf1fb" strokeWidth={26} strokeLinecap="round" opacity={0.95} />
    </svg>
  );
}

export function TaskIcon({ size = '1.25em' }: { size?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'inline-block', verticalAlign: '-0.22em', flex: 'none' }}
      aria-hidden="true"
    >
      {/* clipboard board */}
      <rect x="236" y="250" width="552" height="600" rx="46" fill={PAPER} />
      {/* clip */}
      <rect x="430" y="188" width="164" height="118" rx="34" fill={ACCENT} />
      <rect x="466" y="150" width="92" height="78" rx="39" fill={ACCENT_DEEP} />
      {/* ruled task lines */}
      <g stroke={RULE} strokeWidth={34} strokeLinecap="round">
        <line x1="340" y1="478" x2="684" y2="478" />
        <line x1="340" y1="586" x2="684" y2="586" />
        <line x1="340" y1="694" x2="560" y2="694" />
      </g>
    </svg>
  );
}

export function LogIcon({ size = '1.25em' }: { size?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'inline-block', verticalAlign: '-0.22em', flex: 'none' }}
      aria-hidden="true"
    >
      {/* sheet with folded corner */}
      <path
        d="M346,206 H612 a20,20 0 0 1 14,6 l136,136 a20,20 0 0 1 6,14 V790 a30,30 0 0 1 -30,30 H346 a30,30 0 0 1 -30,-30 V236 a30,30 0 0 1 30,-30 z"
        fill={PAPER}
        stroke="none"
      />
      {/* folded corner */}
      <path d="M612,206 V338 a20,20 0 0 0 20,20 H762" fill="none" stroke="#aeb8c8" strokeWidth={20} strokeLinejoin="round" />
      {/* log entries: accent timestamp dot + ruled line */}
      <g strokeLinecap="round">
        <circle cx="406" cy="446" r="17" fill={ACCENT} />
        <line x1="452" y1="446" x2="700" y2="446" stroke={RULE} strokeWidth={24} />
        <circle cx="406" cy="540" r="17" fill={ACCENT} />
        <line x1="452" y1="540" x2="664" y2="540" stroke={RULE} strokeWidth={24} />
        <circle cx="406" cy="634" r="17" fill={ACCENT} />
        <line x1="452" y1="634" x2="700" y2="634" stroke={RULE} strokeWidth={24} />
        <circle cx="406" cy="728" r="17" fill={ACCENT} />
        <line x1="452" y1="728" x2="640" y2="728" stroke={RULE} strokeWidth={24} />
      </g>
    </svg>
  );
}
