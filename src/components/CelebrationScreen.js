import React, { useEffect } from 'react';
import mascotCelebration from '../assets/mascot-celebration.png';
import './CelebrationScreen.css';

const DISPLAY_DURATION_MS = 1600;

const CONFETTI = [
  { emoji: '✨', className: 'confetti confetti--1' },
  { emoji: '🎉', className: 'confetti confetti--2' },
  { emoji: '💛', className: 'confetti confetti--3' },
  { emoji: '💙', className: 'confetti confetti--4' },
  { emoji: '⭐', className: 'confetti confetti--5' },
  { emoji: '🧡', className: 'confetti confetti--6' },
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
            aria-hidden="true"
          >
            {c.emoji}
          </span>
        ))}
        <img
          className="celebration-mascot"
          src={mascotCelebration}
          alt="여행 준비 완료를 축하하는 트립루티 마스코트"
        />
      </div>
      <p className="celebration-title">사진 분석 완료!</p>
      <p className="celebration-sub">여행 동선을 지도로 그려볼게요</p>
      <div className="celebration-loader" aria-hidden="true">
        <span className="celebration-loader-dot" />
        <span className="celebration-loader-dot" />
        <span className="celebration-loader-dot" />
      </div>
    </div>
  );
}

export default CelebrationScreen;
