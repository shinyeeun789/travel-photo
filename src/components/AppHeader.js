import React from 'react';
import logo from '../assets/logo.png';
import { DottedPath, Plane } from './Doodles';
import './AppHeader.css';

function AppHeader({ onLogoClick }) {
  return (
    <header className="app-header">
      <button type="button" className="app-logo" onClick={onLogoClick}>
        <img className="app-logo-icon" src={logo} alt="" aria-hidden="true" />
        <span className="app-logo-word">
          <span className="tori-stroke tori-stroke--honey">트립루트</span>
        </span>
        <span className="app-logo-trail" aria-hidden="true">
          <DottedPath size={46} />
          <Plane size={16} />
        </span>
      </button>
      <div className="app-privacy-badge">
        <span className="app-privacy-badge-icon" aria-hidden="true">
          🔒
        </span>
        사진은 서버에 저장되지 않고 기기 안에서 안전하게 처리돼요
      </div>
    </header>
  );
}

export default AppHeader;
