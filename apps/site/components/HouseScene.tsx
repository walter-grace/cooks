'use client';

import { useEffect, useRef } from 'react';

/**
 * Scroll camera for the house. The stage sticks to the viewport while the stops scroll over it;
 * scroll progress picks a camera keyframe per stop and the SVG is translated and scaled to frame
 * that room. The camera eases toward its target every frame, so a fast scroll still feels like
 * one continuous move. Without script, or with reduced motion, the whole building is shown and
 * only the room highlight follows the scroll.
 */

export interface Stop { id: string; cx: number; cy: number; w: number; h: number }

export const STOPS: Stop[] = [
  { id: 'all', cx: 790, cy: 560, w: 1560, h: 900 },
  { id: 'dialer', cx: 500, cy: 528, w: 620, h: 300 },
  { id: 'sequencing', cx: 580, cy: 702, w: 740, h: 300 },
  { id: 'signals', cx: 1170, cy: 330, w: 460, h: 400 },
  { id: 'coaching', cx: 1030, cy: 540, w: 620, h: 300 },
  { id: 'assistant', cx: 1105, cy: 700, w: 520, h: 300 },
  { id: 'selfhost', cx: 790, cy: 840, w: 1100, h: 260 },
];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** Hold at each stop for the first and last quarter of a segment, glide in between. */
const ease = (t: number) => {
  const u = clamp((t - 0.22) / 0.56, 0, 1);
  return u * u * (3 - 2 * u);
};

export function HouseScene({ scene, children }: { scene: React.ReactNode; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const stage = root.querySelector<HTMLElement>('.stage');
    const svg = root.querySelector<SVGSVGElement>('svg.house-svg');
    const stops = Array.from(root.querySelectorAll<HTMLElement>('.stop'));
    if (!stage || !svg) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const N = STOPS.length;
    let cur = { ...STOPS[0] };
    let target = { ...STOPS[0] };
    let raf = 0;
    let active = -1;

    const fit = (k: Stop) => {
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      const cs = getComputedStyle(stage);
      const fx = parseFloat(cs.getPropertyValue('--fx')) || 0.5;
      const fy = parseFloat(cs.getPropertyValue('--fy')) || 0.5;
      const pad = parseFloat(cs.getPropertyValue('--pad')) || 0.9;
      const s = Math.min((W * pad) / k.w, (H * pad) / k.h);
      return { s, tx: W * fx - k.cx * s, ty: H * fy - k.cy * s };
    };
    const apply = (k: Stop) => {
      const f = fit(k);
      svg.style.transform = `translate(${f.tx.toFixed(2)}px, ${f.ty.toFixed(2)}px) scale(${f.s.toFixed(4)})`;
    };
    const tick = () => {
      const a = reduce ? 1 : 0.14;
      cur = { id: target.id, cx: cur.cx + (target.cx - cur.cx) * a, cy: cur.cy + (target.cy - cur.cy) * a, w: cur.w + (target.w - cur.w) * a, h: cur.h + (target.h - cur.h) * a };
      apply(cur);
      const d = Math.abs(cur.cx - target.cx) + Math.abs(cur.cy - target.cy) + Math.abs(cur.w - target.w);
      if (d > 0.4) raf = requestAnimationFrame(tick);
      else {
        apply(target);
        raf = 0;
      }
    };
    const onScroll = () => {
      const r = root.getBoundingClientRect();
      const vh = window.innerHeight;
      const total = Math.max(1, r.height - vh);
      const p = clamp(-r.top / total, 0, 1) * (N - 1);
      const i = Math.min(N - 2, Math.floor(p));
      const t = ease(p - i);
      const A = STOPS[i];
      const B = STOPS[i + 1];
      target = reduce ? STOPS[0] : { id: B.id, cx: A.cx + (B.cx - A.cx) * t, cy: A.cy + (B.cy - A.cy) * t, w: A.w + (B.w - A.w) * t, h: A.h + (B.h - A.h) * t };
      const near = Math.round(p);
      if (near !== active) {
        active = near;
        svg.dataset.room = STOPS[near].id;
        stops.forEach((el, j) => el.classList.toggle('on', j === near));
      }
      if (!raf) raf = requestAnimationFrame(tick);
    };
    svg.classList.add('live');
    apply(cur);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
      svg.classList.remove('live');
      svg.style.transform = '';
    };
  }, []);

  return (
    <section className="house" id="house" ref={ref}>
      <div className="stage" aria-hidden="true">{scene}</div>
      <ol className="stops">{children}</ol>
    </section>
  );
}
