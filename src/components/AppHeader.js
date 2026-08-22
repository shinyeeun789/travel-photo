import React from 'react';
import './AppHeader.css';

function AppHeader({ onLogoClick }) {
  return (
    <header className="app-header">
      <button type="button" className="app-logo" onClick={onLogoClick}>
        <span className="app-logo-icon" aria-hidden="true">
          ✈️
        </span>
        <span className="app-logo-trip">트립</span>
        <span className="app-logo-rooty">루티</span>
      </button>
      <div className="app-privacy-badge">
        <span className="app-privacy-badge-icon" aria-hidden="true">
          🔒
        </span>
        사진은 서버에 저장되지 않고 기기 내에서 안전하게 처리돼요
      </div>
    </header>
  );
}

export default AppHeader;
