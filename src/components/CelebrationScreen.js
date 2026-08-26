import React, { useEffect } from 'react';
import mascotCelebration from '../assets/mascot-celebration.png';
import { Sparkle, Paw } from './Doodles';
import './CelebrationScreen.css';

const DISPLAY_DURATION_MS = 1600;

const CONFETTI = [
  { node: <Sparkle size={26} />, className: 'confetti confetti--1', tint: 'var(--honey)' },
  { node: <Paw size={22} />, className: 'confetti confetti--2', tint: 'var(--denim)' },
  { node: <Sparkle size={18} />, className: 'confetti confetti--3', tint: 'var(--sage)' },
  { node: <Paw size={18} />, className: 'confetti confetti--4', tint: 'var(--honey-deep)' },
  { node: <Sparkle size={20} />, className: 'confetti confetti--5', tint: 'var(--denim)' },
  { node: <Paw size={16} />, className: 'confetti confetti--6', tint: 'var(--blush)' },
];

function CelebrationScreen({ onDone }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDone?.();
    }, DISPLAY_DURATION_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="celebration-screen">
      <div className="celebration-stage">
        <span className="celebration-glow" aria-hidden="true" />
        {CONFETTI.map((c) => (
          <span
            key={c.className}
            className={c.className}
            style={{ color: c.tint }}
            aria-hidden="true"
          >
            {c.node}
          </span>
        ))}
        <img
          className="celebration-mascot"
          src={mascotCelebration}
          alt="사진 분석을 마친 강아지 토리"
        />
      </div>
      <p className="celebration-title">사진 분석 완료!</p>
      <p className="celebration-sub">토리가 여행 동선을 지도로 그려볼게요</p>
      <div className="celebration-loader" aria-hidden="true">
        <span className="celebration-loader-dot" />
        <span className="celebration-loader-dot" />
        <span className="celebration-loader-dot" />
      </div>
    </div>
  );
}

export default CelebrationScreen;
