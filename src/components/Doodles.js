import React from 'react';

/* Hand-drawn sticker doodles pulled from 토리's character sheet — clouds,
   dotted flight paths, paw prints, sparkles. All inherit `currentColor` so
   callers set the tint, and all are decorative (aria-hidden via the wrapper).
   Stroke-based so they stay crisp at any size. */

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export function Cloud({ size = 40, ...rest }) {
  return (
    <svg viewBox="0 0 48 30" width={size} height={(size * 30) / 48} {...rest}>
      <path
        {...base}
        d="M12 25c-6 0-9-4-9-8s3-8 8-8c1-5 6-8 11-8s10 4 11 9c5 0 12 2 12 8s-6 7-10 7Z"
      />
    </svg>
  );
}

export function Plane({ size = 30, ...rest }) {
  return (
    <svg viewBox="0 0 34 30" width={size} height={(size * 30) / 34} {...rest}>
      <path
        {...base}
        d="M4 17 30 5c1-.5 2 .5 1.6 1.6L20 30l-4-9-1-1Z"
      />
      <path {...base} d="M16 20l3-3" />
    </svg>
  );
}

export function DottedPath({ size = 70, flip = false, ...rest }) {
  return (
    <svg
      viewBox="0 0 80 34"
      width={size}
      height={(size * 34) / 80}
      style={flip ? { transform: 'scaleX(-1)' } : undefined}
      {...rest}
    >
      <path
        d="M3 30C20 30 20 6 40 6s22 20 37 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="0.1 9"
      />
    </svg>
  );
}

export function Paw({ size = 26, ...rest }) {
  return (
    <svg viewBox="0 0 30 30" width={size} height={size} {...rest}>
      <g fill="currentColor">
        <ellipse cx="15" cy="20" rx="7.5" ry="6" />
        <ellipse cx="6.5" cy="12.5" rx="3.2" ry="4" />
        <ellipse cx="15" cy="9" rx="3.4" ry="4.2" />
        <ellipse cx="23.5" cy="12.5" rx="3.2" ry="4" />
      </g>
    </svg>
  );
}

export function Sparkle({ size = 22, ...rest }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...rest}>
      <path
        d="M12 1c1 6 4 9 10 11-6 2-9 5-10 11-1-6-4-9-10-11 6-2 9-5 10-11Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function MusicNote({ size = 22, ...rest }) {
  return (
    <svg viewBox="0 0 22 26" width={size} height={(size * 26) / 22} {...rest}>
      <path {...base} d="M9 20V4l9-2v14" />
      <ellipse cx="6" cy="20.5" rx="4.5" ry="3.6" fill="currentColor" stroke="none" />
      <ellipse cx="15" cy="16.5" rx="4.5" ry="3.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Compass({ size = 30, ...rest }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} {...rest}>
      <circle {...base} cx="16" cy="16" r="13" />
      <path d="M16 8l3 8-3 8-3-8Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
