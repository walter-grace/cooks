'use client';

import { useEffect, useRef } from 'react';

/** Plays the footer's entrance once when it scrolls into view, and again on Replay. */
export function FooterReveal() {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const f = document.getElementById('footer');
    if (!f) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const play = () => {
      if (reduce) return;
      f.classList.remove('in');
      void f.offsetWidth;
      f.classList.add('in');
    };
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { play(); io.disconnect(); }
    }, { threshold: 0.28 });
    io.observe(f);
    const btn = ref.current;
    btn?.addEventListener('click', play);
    return () => { io.disconnect(); btn?.removeEventListener('click', play); };
  }, []);
  return <button ref={ref} className="replay" type="button">Replay reveal</button>;
}
