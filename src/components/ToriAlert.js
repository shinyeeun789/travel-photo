import React, { useEffect, useRef } from 'react';
import toriHuh from '../assets/tori-huh.png';
import './ToriAlert.css';

/**
 * Scrapbook-style modal alert. Matches the 토리 design system: cream paper
 * sheet, dashed frame, washi tape, honey pill button.
 */
function ToriAlert({ open, title, message, confirmLabel = '알겠어요', onClose }) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    confirmRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="tori-alert-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="tori-alert"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tori-alert-title"
        aria-describedby="tori-alert-message"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="tori-alert-tape" aria-hidden="true" />
        <div className="tori-alert-mascot">
          <img src={toriHuh} alt="" aria-hidden="true" />
        </div>
        {title && (
          <h2 className="tori-alert-title" id="tori-alert-title">
            {title}
          </h2>
        )}
        <p className="tori-alert-message" id="tori-alert-message">
          {message}
        </p>
        <button
          type="button"
          ref={confirmRef}
          className="tori-btn tori-btn--primary tori-alert-confirm"
          onClick={onClose}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

export default ToriAlert;
