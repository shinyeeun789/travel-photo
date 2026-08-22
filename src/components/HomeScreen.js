import React, { useCallback, useRef, useState } from 'react';
import exifr from 'exifr';
import AppHeader from './AppHeader';
import './HomeScreen.css';

const MIN_PHOTOS = 5;
const MAX_PHOTOS = 30;

function HomeScreen({ onPhotosParsed, onSampleTrip, onGoHome }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);
  const dragCounter = useRef(0);

  const handleFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList).filter((f) =>
        f.type.startsWith('image/')
      );

      if (files.length === 0) {
        setError('이미지 파일을 선택해주세요.');
        return;
      }
      if (files.length < MIN_PHOTOS) {
        setError(`사진을 최소 ${MIN_PHOTOS}장 이상 선택해주세요.`);
        return;
      }
      if (files.length > MAX_PHOTOS) {
        setError(`사진은 최대 ${MAX_PHOTOS}장까지 업로드할 수 있습니다.`);
        return;
      }

      setError('');
      setIsParsing(true);
      setProgress({ done: 0, total: files.length });

      const results = [];
      for (const file of files) {
        let meta = null;
        try {
          meta = await exifr.parse(file, { gps: true, pick: ['DateTimeOriginal', 'GPSLatitude', 'GPSLongitude'] });
        } catch (e) {
          meta = null;
        }
        results.push({
          file,
          fileName: file.name,
          takenAt: meta?.DateTimeOriginal ?? null,
          latitude: meta?.latitude ?? meta?.GPSLatitude ?? null,
          longitude: meta?.longitude ?? meta?.GPSLongitude ?? null,
        });
        setProgress((prev) => ({ ...prev, done: prev.done + 1 }));
      }

      setIsParsing(false);
      onPhotosParsed?.(results);
    },
    [onPhotosParsed]
  );

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragging(false);
      if (e.dataTransfer.files?.length) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
  }, []);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    dragCounter.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      setIsDragging(false);
    }
  }, []);

  const handleFileInputChange = useCallback(
    (e) => {
      if (e.target.files?.length) {
        handleFiles(e.target.files);
      }
      e.target.value = '';
    },
    [handleFiles]
  );

  const openFilePicker = () => fileInputRef.current?.click();

  return (
    <div className="home-screen">
      <AppHeader onLogoClick={onGoHome} />

      <main className="hero-section">
        <div className="hero-decor" aria-hidden="true">
          <span className="hero-decor-item hero-decor-item--1">📍</span>
          <span className="hero-decor-item hero-decor-item--2">🧭</span>
          <span className="hero-decor-item hero-decor-item--3">🌴</span>
          <span className="hero-decor-item hero-decor-item--4">🎞️</span>
        </div>

        <div className="hero-heading">
          <span className="hero-heading-eyebrow">
            ✨ 업로드만 하면 자동으로 완성돼요
          </span>
          <h1 className="hero-heading-title">
            사진 몇 장으로 완성하는 나만의 여행 지도
          </h1>
        </div>

        <div className="ticket-wrapper">
          <span className="washi-tape washi-tape--left" aria-hidden="true" />
          <span className="washi-tape washi-tape--right" aria-hidden="true" />
          <span className="ticket-wrapper-notch ticket-wrapper-notch--left" aria-hidden="true" />
          <span className="ticket-wrapper-notch ticket-wrapper-notch--right" aria-hidden="true" />
          <div
            className={`drop-zone${isDragging ? ' drop-zone--dragging' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
          >
            {isParsing ? (
              <div className="parsing-status">
                <div className="icon-badge icon-badge--pulse" aria-hidden="true">
                  <span className="icon-badge-glyph">📷</span>
                </div>
                <div className="progress-bar-track">
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: `${
                        progress.total
                          ? (progress.done / progress.total) * 100
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <p className="parsing-text">
                  사진 {progress.total}장의 위치와 시간을 분석하고 있어요...
                  ({progress.done}/{progress.total})
                </p>
              </div>
            ) : (
              <>
                <div className="icon-badge" aria-hidden="true">
                  <span className="icon-badge-glyph">📷</span>
                </div>
                <p className="drop-zone-guide">
                  지난 여행 사진 {MIN_PHOTOS}~{MAX_PHOTOS}장을
                  <br className="drop-zone-guide-break" />
                  <span className="drop-zone-guide-break-space">{' '}</span>
                  업로드해주세요
                </p>
                <span className="drop-zone-sub" aria-hidden="true">
                  🐾&nbsp; 아래 버튼으로 사진을 선택해주세요 &nbsp;🐾
                </span>
                <button
                  type="button"
                  className="select-photos-button"
                  onClick={openFilePicker}
                >
                  사진 선택하기
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={handleFileInputChange}
                />
                {error && <p className="drop-zone-error">{error}</p>}
                <div className="ticket-divider" aria-hidden="true" />
                <p className="ticket-footnote">JPG · PNG · HEIC 지원</p>
              </>
            )}
          </div>
        </div>

        {!isParsing && (
          <div className="outcome-preview">
            <p className="outcome-heading">✨ 나만의 여행 추억을 만들 수 있어요! ✨</p>
            <div className="outcome-preview-row">
              <div className="journey-preview">
                <div className="journey-preview-card">
                  <svg
                    className="journey-preview-svg"
                    viewBox="0 0 380 84"
                    aria-hidden="true"
                  >
                    <path
                      d="M 24 60 Q 90 10, 140 40 T 240 24 T 356 52"
                      className="journey-preview-path"
                      fill="none"
                    />
                    <g className="journey-preview-pin">
                      <circle cx="24" cy="60" r="9" />
                      <circle
                        cx="24"
                        cy="60"
                        r="3.2"
                        className="journey-preview-pin-core"
                      />
                    </g>
                    <g className="journey-preview-pin">
                      <circle cx="140" cy="40" r="9" />
                      <circle
                        cx="140"
                        cy="40"
                        r="3.2"
                        className="journey-preview-pin-core"
                      />
                    </g>
                    <g className="journey-preview-pin">
                      <circle cx="240" cy="24" r="9" />
                      <circle
                        cx="240"
                        cy="24"
                        r="3.2"
                        className="journey-preview-pin-core"
                      />
                    </g>
                    <g className="journey-preview-pin journey-preview-pin--final">
                      <circle cx="356" cy="52" r="13" />
                      <text x="356" y="57" textAnchor="middle" fontSize="13">
                        📸
                      </text>
                    </g>
                  </svg>
                </div>
                <p className="preview-caption">여행 동선 지도</p>
              </div>

              <div className="ticket-preview">
                <div className="ticket-preview-card">
                  <div className="ticket-preview-stub">
                    <span
                      className="ticket-preview-stub-icon"
                      aria-hidden="true"
                    >
                      🎫
                    </span>
                    <span className="ticket-preview-stub-label">
                      TRIP
                      <br />
                      TICKET
                    </span>
                  </div>
                  <span
                    className="ticket-preview-notch ticket-preview-notch--top"
                    aria-hidden="true"
                  />
                  <span
                    className="ticket-preview-notch ticket-preview-notch--bottom"
                    aria-hidden="true"
                  />
                  <div className="ticket-preview-main">
                    <div className="ticket-preview-main-top">
                      <div
                        className="ticket-preview-photo"
                        aria-hidden="true"
                      >
                        🏖️
                      </div>
                      <div className="ticket-preview-info">
                        <span className="ticket-preview-title">
                          제주도 여행
                        </span>
                        <span className="ticket-preview-date">
                          2024.11.01 – 11.04
                        </span>
                      </div>
                    </div>
                    <div
                      className="ticket-preview-barcode"
                      aria-hidden="true"
                    />
                  </div>
                </div>
                <p className="preview-caption">나만의 포토 티켓</p>
              </div>
            </div>

            <div className="feature-strip">
              <span className="feature-chip">📍 GPS 자동 인식</span>
              <span className="feature-chip">👣 발자취 재생</span>
              <span className="feature-chip">🎫 포토 티켓 생성</span>
            </div>
          </div>
        )}

        {/*{!isParsing && (*/}
        {/*  <button*/}
        {/*    type="button"*/}
        {/*    className="sample-trip-link"*/}
        {/*    onClick={onSampleTrip}*/}
        {/*  >*/}
        {/*    ✨ 사진이 없나요? 샘플 여행(제주도 3박 4일) 지도로 둘러보기 ✨*/}
        {/*  </button>*/}
        {/*)}*/}
      </main>

      <footer className="home-footer">
        <div className="home-footer-brand">
          <span className="home-footer-logo" aria-hidden="true">
            ✈️
          </span>
          <span>트립루티</span>
        </div>
        <p className="home-footer-tagline">
          <span aria-hidden="true">🔒</span> 사진은 서버에 저장되지 않고,
          기기 안에서만 안전하게 처리돼요
        </p>
        <p className="home-footer-copyright">
          © {new Date().getFullYear()} 트립루티. All rights reserved.
        </p>
      </footer>
    </div>
  );
}

export default HomeScreen;
