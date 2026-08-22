import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { totalRouteDistanceKm } from '../utils/geo';
import AppHeader from './AppHeader';
import TripMap from './TripMap';
import './MapTimelineScreen.css';

function formatCardTime(date) {
  if (!date) return '시간 정보 없음';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const ii = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}년 ${mm}월 ${dd}일 ${hh}:${ii}:${ss}`;
}

function formatDateRange(photos) {
  const dates = photos.map((p) => p.takenAt).filter(Boolean);
  if (dates.length === 0) return '날짜 정보 없음';
  const min = new Date(Math.min(...dates));
  const max = new Date(Math.max(...dates));
  const y = min.getFullYear();
  const fmt = (d) =>
    `${String(d.getMonth() + 1).padStart(2, '0')}.${String(
      d.getDate()
    ).padStart(2, '0')}`;
  return `${y}.${fmt(min)} ~ ${fmt(max)}`;
}

function formatCoord(lat, lng) {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function PhotoThumb({ photo }) {
  const [objectUrl, setObjectUrl] = useState(null);

  useEffect(() => {
    if (!photo.file) return undefined;
    const url = URL.createObjectURL(photo.file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo.file]);

  if (objectUrl) {
    return (
      <img
        className="photo-thumb-img"
        src={objectUrl}
        alt=""
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <div className="photo-thumb-placeholder" aria-hidden="true">
      {photo.placeholderEmoji || '📷'}
    </div>
  );
}

function MapTimelineScreen({
  photos,
  onBack,
  onOpenStoryModal,
  onGoHome,
  onUpdatePhotoLocation,
}) {
  const [selectedPhotoId, setSelectedPhotoId] = useState(
    photos[0]?.id ?? null
  );
  const [noGpsModalOpen, setNoGpsModalOpen] = useState(false);
  const [routePlaying, setRoutePlaying] = useState(false);
  const [placingPhotoId, setPlacingPhotoId] = useState(null);

  const sortedPhotos = useMemo(() => {
    return [...photos].sort((a, b) => {
      if (!a.takenAt && !b.takenAt) return 0;
      if (!a.takenAt) return 1;
      if (!b.takenAt) return -1;
      return a.takenAt - b.takenAt;
    });
  }, [photos]);

  const geoTaggedPhotos = useMemo(
    () =>
      sortedPhotos.filter(
        (p) => p.latitude != null && p.longitude != null
      ),
    [sortedPhotos]
  );

  const noGpsPhotos = useMemo(
    () =>
      sortedPhotos.filter(
        (p) => p.latitude == null || p.longitude == null
      ),
    [sortedPhotos]
  );

  const totalDistanceKm = useMemo(
    () => totalRouteDistanceKm(geoTaggedPhotos),
    [geoTaggedPhotos]
  );

  const dateRangeLabel = useMemo(
    () => formatDateRange(sortedPhotos),
    [sortedPhotos]
  );

  // Stable reference: TripMap's route-playing animation depends on this in
  // a useEffect, and it also calls onSelectPhoto (below) on every stop it
  // passes — a new function here on every one of those re-renders would
  // re-trigger that effect and restart the whole animation mid-flight.
  const handleRoutePlayEnd = useCallback(() => setRoutePlaying(false), []);

  const handleStartPlacing = (photoId) => {
    setPlacingPhotoId(photoId);
    setNoGpsModalOpen(false);
  };

  const handlePickLocation = useCallback(
    ({ latitude, longitude }) => {
      setPlacingPhotoId((currentId) => {
        if (currentId) onUpdatePhotoLocation?.(currentId, { latitude, longitude });
        return null;
      });
    },
    [onUpdatePhotoLocation]
  );

  const placingPhoto = photos.find((p) => p.id === placingPhotoId) ?? null;

  return (
    <div className="map-timeline-page">
      <AppHeader onLogoClick={onGoHome} />
      <div className="map-timeline-screen">
      <section className="map-pane">
        <div className="map-pane-topbar">
          <button type="button" className="timeline-back" onClick={onBack}>
            <span className="timeline-back-arrow" aria-hidden="true">
              ←
            </span>
            <span>다시 시작</span>
          </button>
          {/*<button*/}
          {/*  type="button"*/}
          {/*  className="floating-cta-button"*/}
          {/*  onClick={onOpenStoryModal}*/}
          {/*>*/}
          {/*  인스타 스토리 카드 만들기 ➔*/}
          {/*</button>*/}
        </div>

        <TripMap
          photos={sortedPhotos}
          selectedPhotoId={selectedPhotoId}
          onSelectPhoto={setSelectedPhotoId}
          routePlaying={routePlaying}
          onRoutePlayEnd={handleRoutePlayEnd}
          isPlacingLocation={!!placingPhotoId}
          onPickLocation={handlePickLocation}
        />

        {placingPhoto && (
          <div className="location-picker-banner">
            <span>
              🗺️ <strong>{placingPhoto.fileName}</strong>의 위치를 지도에서
              클릭해 지정하세요
            </span>
            <button
              type="button"
              className="location-picker-cancel"
              onClick={() => setPlacingPhotoId(null)}
            >
              취소
            </button>
          </div>
        )}

        <div className="route-strip">
          {sortedPhotos.map((photo, index) => (
            <React.Fragment key={photo.id}>
              {index > 0 && (
                <span className="route-strip-arrow" aria-hidden="true">
                  →
                </span>
              )}
              <button
                type="button"
                className={`route-strip-pin${
                  photo.id === selectedPhotoId
                    ? ' route-strip-pin--active'
                    : ''
                }${
                  photo.latitude == null ? ' route-strip-pin--no-gps' : ''
                }`}
                onClick={() => setSelectedPhotoId(photo.id)}
                title={photo.fileName}
              >
                <PhotoThumb photo={photo} />
              </button>
            </React.Fragment>
          ))}
        </div>

        <button
          type="button"
          className="route-play-button"
          onClick={() => setRoutePlaying(true)}
          disabled={routePlaying || geoTaggedPhotos.length < 2}
        >
          {routePlaying ? (
            '재생 중...'
          ) : (
            <>
              <svg
                className="route-play-icon"
                viewBox="0 0 10 12"
                aria-hidden="true"
              >
                <polygon points="0,0 10,6 0,12" fill="currentColor" />
              </svg>
              여행 발자취 재생
            </>
          )}
        </button>
      </section>

      <section className="timeline-pane">
        <div className="timeline-header">
          <div className="trip-ticket">
            <div className="trip-ticket-stub">
              <span className="trip-ticket-stub-icon" aria-hidden="true">
                🎫
              </span>
              <span className="trip-ticket-stub-label">
                TRIP
                <br />
                TICKET
              </span>
            </div>
            <span
              className="trip-ticket-notch trip-ticket-notch--top"
              aria-hidden="true"
            />
            <span
              className="trip-ticket-notch trip-ticket-notch--bottom"
              aria-hidden="true"
            />
            <div className="trip-ticket-main">
              <div className="trip-ticket-badge">나의 여행 티켓</div>
              <div className="timeline-summary">
                <div className="summary-stat">
                  <span className="summary-stat-value">
                    {totalDistanceKm.toFixed(1)} km
                  </span>
                  <span className="summary-stat-label">총 이동 거리</span>
                </div>
                <div className="summary-stat">
                  <span className="summary-stat-value">{dateRangeLabel}</span>
                  <span className="summary-stat-label">여행 기간</span>
                </div>
                <div className="summary-stat">
                  <span className="summary-stat-value">
                    {geoTaggedPhotos.length}곳
                  </span>
                  <span className="summary-stat-label">총 스팟 수</span>
                </div>
              </div>
              <div className="trip-ticket-barcode" aria-hidden="true" />
            </div>
          </div>
        </div>

        {noGpsPhotos.length > 0 && (
          <button
            type="button"
            className="no-gps-chip"
            onClick={() => setNoGpsModalOpen(true)}
          >
            📍 위치 정보가 없는 사진 {noGpsPhotos.length}장이 있어요
            <span className="no-gps-chip-cta">보정하기</span>
          </button>
        )}

        <div className="photo-timeline">
          {sortedPhotos.length > 1 && (
            <span className="photo-timeline-rail-line" aria-hidden="true" />
          )}
          {sortedPhotos.map((photo) => (
            <div
              role="button"
              tabIndex={0}
              key={photo.id}
              className={`photo-timeline-item${
                photo.id === selectedPhotoId
                  ? ' photo-timeline-item--active'
                  : ''
              }`}
              onClick={() => setSelectedPhotoId(photo.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedPhotoId(photo.id);
                }
              }}
            >
              <span className="photo-timeline-rail" aria-hidden="true">
                <span className="photo-timeline-dot" />
              </span>
              <span className="photo-timeline-card">
                <span className="photo-timeline-photo">
                  <PhotoThumb photo={photo} />
                  {photo.latitude == null && (
                    <span className="photo-timeline-no-gps-badge">
                      📍 위치 없음
                    </span>
                  )}
                </span>
                <span className="photo-timeline-info">
                  <span className="photo-timeline-time">
                    {formatCardTime(photo.takenAt)}
                  </span>
                  <span className="photo-timeline-location-row">
                    <span className="photo-timeline-location">
                      {photo.latitude != null
                        ? formatCoord(photo.latitude, photo.longitude)
                        : '위치 정보 없음'}
                    </span>
                    {photo.latitude != null && (
                      <button
                        type="button"
                        className="photo-timeline-edit-location"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartPlacing(photo.id);
                        }}
                      >
                        ✏️ 위치 수정
                      </button>
                    )}
                  </span>
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      {noGpsModalOpen && (
        <div
          className="no-gps-modal-backdrop"
          onClick={() => setNoGpsModalOpen(false)}
        >
          <div
            className="no-gps-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3 className="no-gps-modal-title">위치 정보 보정</h3>
            <p className="no-gps-modal-desc">
              아래에서 사진을 선택한 뒤, 지도 위에서 원하는 위치를 클릭하면
              그 사진의 위치로 지정돼요.
            </p>
            <ul className="no-gps-modal-list">
              {noGpsPhotos.map((photo) => (
                <li key={photo.id}>
                  <button
                    type="button"
                    className="no-gps-modal-item"
                    onClick={() => handleStartPlacing(photo.id)}
                  >
                    <div className="no-gps-modal-thumb">
                      <PhotoThumb photo={photo} />
                    </div>
                    <div className="no-gps-modal-item-info">
                      <span>{photo.fileName}</span>
                      <span className="no-gps-modal-item-time">
                        {formatCardTime(photo.takenAt)}
                      </span>
                    </div>
                    <span
                      className="no-gps-modal-item-cta"
                      aria-hidden="true"
                    >
                      위치 지정 →
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="no-gps-modal-close"
              onClick={() => setNoGpsModalOpen(false)}
            >
              닫기
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

export default MapTimelineScreen;
