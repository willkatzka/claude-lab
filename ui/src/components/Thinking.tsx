import { useEffect, useRef, useState } from 'react';

// The Benchtop "agent thinking" animation, ported from the design source. Each
// vessel forms from three dots, holds, then shatters back into three dots — looping
// through five vessels. Inline, text-sized, no chrome, no labels — just the tubes
// + a trailing "…". Color follows currentColor so it tracks the app palette.

const VESSELS = [
  { path: 'M50,34 L50,82 a10,10 0 0 0 20,0 L70,34', rim: [44, 34, 76, 34], cx: 60, cy: 58 }, // test tube
  { path: 'M54,34 L54,54 L40,90 L80,90 L66,54 L66,34', rim: [49, 34, 71, 34], cx: 60, cy: 64 }, // erlenmeyer
  { path: 'M55,32 L55,51 A16,16 0 1 0 65,51 L65,32', rim: [50, 32, 70, 32], cx: 60, cy: 60 }, // round-bottom
  { path: 'M42,48 L42,88 a4,4 0 0 0 4,4 L74,92 a4,4 0 0 0 4,-4 L78,48', rim: [40, 48, 80, 48], cx: 60, cy: 70 }, // beaker
  { path: 'M53,32 L53,88 L49,94 L71,94 L67,88 L67,32', rim: [49, 32, 71, 32], cx: 60, cy: 62 }, // graduated cylinder
];

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutBack = (x: number) => {
  const c1 = 1.70158,
    c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const easeOutBounce = (x: number) => {
  const n1 = 7.5625,
    d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

function VesselScene({ t, speed = 0.7 }: { t: number; speed?: number }) {
  const dotsBase: [number, number][] = [[44, 92], [60, 92], [76, 92]];
  const F = 560,
    H = 360,
    S = 580,
    beat = F + H + S,
    total = beat * VESSELS.length;
  const tt = (((t * speed) % total) + total) % total;
  const idx = Math.floor(tt / beat);
  const local = tt - idx * beat;
  const V = VESSELS[idx];

  let vOpacity: number, dashoffset: number, vScale: number;
  const dots: { x: number; y: number; sc: number; op: number }[] = [];

  if (local < F) {
    const p = local / F; // form
    vOpacity = clamp(p * 1.9 - 0.1);
    dashoffset = 100 * (1 - easeInOut(clamp(p * 1.05)));
    vScale = 0.82 + 0.18 * easeOutBack(clamp(p));
    for (let i = 0; i < 3; i++) {
      const [bx, by] = dotsBase[i];
      const tx = V.cx + (i - 1) * 4,
        ty = V.cy;
      const de = easeInOut(clamp(p * 1.15 - i * 0.04));
      dots.push({ x: bx + (tx - bx) * de, y: by + (ty - by) * de, sc: 1 - clamp(p * 1.35), op: 1 - clamp(p * 1.55) });
    }
  } else if (local < F + H) {
    const p = (local - F) / H; // hold
    vOpacity = 1;
    dashoffset = 0;
    vScale = 1 + 0.02 * Math.sin(p * Math.PI * 2);
  } else {
    const p = (local - F - H) / S; // shatter
    vOpacity = 1 - clamp(p * 3.2);
    dashoffset = 0;
    vScale = 1 + 0.14 * clamp(p * 3.2);
    for (let i = 0; i < 3; i++) {
      const [bx, by] = dotsBase[i];
      const start = i * 0.16;
      const pp = clamp((p - start) / (1 - start));
      const fe = easeOutBounce(pp);
      const sx = V.cx + (i - 1) * 5,
        sy = V.cy;
      dots.push({ x: sx + (bx - sx) * fe, y: sy + (by - sy) * fe, sc: clamp(pp * 1.7), op: clamp(pp * 3.2) });
    }
  }

  const xf = `translate(${V.cx} ${V.cy}) scale(${vScale}) translate(${-V.cx} ${-V.cy})`;
  return (
    <svg viewBox="0 0 120 120" className="vessel-svg" style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
      <g transform={xf} opacity={vOpacity}>
        <path
          d={V.path}
          fill="none"
          stroke="currentColor"
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={dashoffset}
        />
        <line x1={V.rim[0]} y1={V.rim[1]} x2={V.rim[2]} y2={V.rim[3]} stroke="currentColor" strokeWidth={5} strokeLinecap="round" opacity={clamp((100 - dashoffset) / 30)} />
      </g>
      {dots.map((d, i) => (d.op > 0.02 && d.sc > 0.02 ? <circle key={i} cx={d.x} cy={d.y} r={6 * d.sc} fill="currentColor" opacity={d.op} /> : null))}
    </svg>
  );
}

export function Thinking() {
  const [t, setT] = useState(0);
  const t0 = useRef(0);
  useEffect(() => {
    t0.current = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      setT(now - t0.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span className="thinking">
      <span className="thinking-icon">
        <VesselScene t={t} />
      </span>
    </span>
  );
}
