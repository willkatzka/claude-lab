// Shown when no lab is selected (e.g. fresh start or all labs deleted):
// a welcome screen with the benchtop glassware faint in the background.
export function EmptyCanvas({ onNewLab }: { onNewLab: () => void }) {
  return (
    <div className="empty-canvas">
      <svg className="empty-art" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <g fill="none" stroke="#F6F1E8" strokeWidth="13" strokeLinejoin="round" strokeLinecap="round">
          <path d="M152,562 L152,690 A28,28 0 0 0 208,690 L208,562 Z" fill="#DA6A4B" stroke="none" />
          <path d="M148,360 L148,690 A32,32 0 0 0 212,690 L212,360" />
          <line x1="136" y1="360" x2="224" y2="360" />
          <path d="M289,560 L250,718 L474,718 L435,560 Z" fill="#74A98A" stroke="none" />
          <path d="M327,300 L327,430 L247,718 L477,718 L397,430 L397,300" />
          <line x1="313" y1="300" x2="411" y2="300" />
          <path d="M440,648 A96,96 0 0 0 621,648 Z" fill="#5E8AB4" stroke="none" />
          <path d="M502,290 L502,524 A96,96 0 1 0 558,524 L558,290" />
          <line x1="489" y1="290" x2="571" y2="290" />
          <ellipse cx="530" cy="710" rx="54" ry="13" strokeWidth="12" />
          <path d="M635,584 L635,706 Q635,718 647,718 L777,718 Q789,718 789,706 L789,584 Z" fill="#E0A352" stroke="none" />
          <path d="M627,470 L627,704 Q627,718 641,718 L783,718 Q797,718 797,704 L797,470" />
          <path d="M627,470 L606,458" />
          <line x1="615" y1="470" x2="797" y2="470" />
          <path d="M853,500 L853,706 L915,706 L915,500 Z" fill="#B96C92" stroke="none" />
          <path d="M849,330 L849,704 L919,704 L919,330" />
          <path d="M849,330 L831,320" />
          <line x1="837" y1="330" x2="931" y2="330" />
          <path d="M819,712 L949,712" strokeWidth="15" />
        </g>
        <rect x="58" y="722" width="908" height="74" rx="20" fill="#C96442" />
      </svg>
      <div className="empty-content">
        <h1>Claude Lab</h1>
        <p>Create a lab to orchestrate a hierarchy of Claude agents.</p>
        <button className="primary" onClick={onNewLab}>
          ＋ New Lab
        </button>
      </div>
    </div>
  );
}
