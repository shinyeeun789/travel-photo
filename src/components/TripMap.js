import React, { useCallback, useEffect, useRef } from 'react';
import {
  Map as MapLibreMap,
  Marker,
  AttributionControl,
  LngLatBounds,
  addProtocol,
  removeProtocol,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { haversineDistanceKm } from '../utils/geo';
import walkerFrame1 from '../assets/walker1.png';
import walkerFrame2 from '../assets/walker2.png';
import 'maplibre-gl/dist/maplibre-gl.css';
import './TripMap.css';

const KOREA_PMTILES_URL =
  'https://pub-9cbe2fd5ac2b4727b4eecfdc279847b3.r2.dev/korea.pmtiles';
const JAPAN_PMTILES_URL =
  'https://pub-9cbe2fd5ac2b4727b4eecfdc279847b3.r2.dev/japan.pmtiles';

const MAP_ATTRIBUTION = '© OpenMapTiles © OpenStreetMap contributors';

// Matches the poi-label layer's minzoom below, so the very first view always
// shows place names instead of just a bare overview.
const MIN_LABEL_ZOOM = 13;

const SHORT_TRIP_ZOOM_BOOST = 1.2;
const ZOOM_BOOST_STEP = 0.1;

// Two walking poses, swapped on a timer during route playback — a simple
// 2-frame walk cycle so the mascot's legs actually alternate as it moves,
// instead of one static pose sliding along the route.
const WALK_FRAMES = [walkerFrame1, walkerFrame2];
const WALK_FRAME_INTERVAL_MS = 220;

// Symbol layers with text collision detection — MapLibre recomputes label
// placement on every camera change, which is the main cost of panning the
// map. Fine at rest, but during the 3D route's continuous pan across real
// distances it was the source of visible stutter (one frame measured at
// 316ms). During playback these get text-allow-overlap/ignore-placement
// toggled on (see the routePlaying effect) to skip that collision pass —
// labels stay on screen the whole time instead of blinking out.
// The blurred "feather" outline layers (line-blur) that soften the edges
// between landcover/park colors — line-blur is a genuinely expensive paint
// property (a GPU blur pass per layer, per frame) and repainting 8 of them
// (4 kinds × korea/japan) on every camera-eased frame during route playback
// is what caused visible lag. They're purely decorative at rest, so they're
// hidden for the duration of playback (see the routePlaying effect) and
// restored afterward, the same way LABEL_LAYER_IDS skips collision work.
const FEATHER_LAYER_IDS = ['korea', 'japan'].flatMap((source) =>
  [
    'landcover-wood-feather',
    'landcover-grass-feather',
    'landuse-green-feather',
    'park-feather',
  ].map((layer) => `${layer}-${source}`)
);

const LABEL_LAYER_IDS = ['korea', 'japan'].flatMap((source) =>
  ['road-label', 'poi-label', 'place-label', 'mountain-peak-label'].map(
    (layer) => `${layer}-${source}`
  )
);

// Bounding box roughly covering the Korean peninsula, used to cap how far
// out the user can zoom (see setMinZoom below).
const KOREA_PENINSULA_BOUNDS = [
  [124.0, 32.5],
  [131.0, 43.0],
];

// Hand-written style for the OpenMapTiles vector schema (Planetiler's default
// output). @protomaps/basemaps was tried first but targets Protomaps' own
// schema (different source-layer names), so it rendered nothing against
// these tiles.
// Fades colors out at low zoom (far away) and brings them in at high zoom
// (close up), similar to how Naver/Kakao Maps go paler when zoomed out.
const ZOOM_FADE_OPACITY = [
  'interpolate',
  ['linear'],
  ['zoom'],
  3,
  0.4,
  6,
  0.55,
  9,
  0.7,
  12,
  0.85,
  15,
  0.95,
];

function buildLayersForSource(sourceId) {
  const src = (id) => `${id}-${sourceId}`;
  return [
    {
      id: src('landcover-wood'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['wood', 'forest'], true, false],
      paint: {
        'fill-color': '#cfe4c4',
        'fill-opacity': ZOOM_FADE_OPACITY,
      },
    },
    {
      // Grassy grounds (e.g. 경주 동궁과 월지's palace/pond grounds) — queried
      // via queryRenderedFeatures() against real tile data and confirmed
      // these are tagged in the 'landcover' source-layer (not 'landuse') as
      // class 'grass', so they fell through to the generic landcover fill
      // below and read as plain beige instead of green.
      id: src('landcover-grass'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['grass'], true, false],
      paint: {
        'fill-color': '#bce0ae',
        'fill-opacity': ZOOM_FADE_OPACITY,
      },
    },
    {
      id: src('landcover'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'landcover',
      filter: [
        '!',
        ['match', ['get', 'class'], ['wood', 'forest', 'grass'], true, false],
      ],
      paint: { 'fill-color': '#f2ede3', 'fill-opacity': ZOOM_FADE_OPACITY },
    },
    {
      id: src('landuse'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'landuse',
      filter: ['in', 'class', 'residential', 'suburb', 'neighbourhood'],
      paint: { 'fill-color': '#efe9df', 'fill-opacity': ZOOM_FADE_OPACITY },
    },
    {
      // Grassy grounds (e.g. 경주 동궁과 월지's palace/pond grounds) — the
      // 'landuse' source-layer tags these as class 'grass'/'garden'/etc,
      // separate from the 'park' source-layer below (which only covers
      // leisure=park), so without this they fell through to the generic
      // landcover fill and read as plain gray/beige instead of green.
      id: src('landuse-green'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'landuse',
      filter: [
        'in',
        'class',
        'grass',
        'garden',
        'recreation_ground',
        'village_green',
      ],
      paint: { 'fill-color': '#bce0ae', 'fill-opacity': ZOOM_FADE_OPACITY },
    },
    {
      id: src('park'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'park',
      paint: { 'fill-color': '#bce0ae', 'fill-opacity': ZOOM_FADE_OPACITY },
    },
    // Soft-edge "feather" for the green areas above (wood/grass/landuse-green/
    // park) — MapLibre fill layers can't gradient-fill a polygon itself, so
    // instead a blurred line traces each polygon's outline on top of
    // everything drawn so far, bleeding the green color a little past the
    // hard edge into its neighbor. Cheap: same source-layer data already
    // decoded above, just re-drawn as a line with 'line-blur'.
    {
      id: src('landcover-wood-feather'),
      type: 'line',
      source: sourceId,
      'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['wood', 'forest'], true, false],
      paint: {
        'line-color': '#cfe4c4',
        'line-width': 14,
        'line-blur': 10,
        'line-opacity': 0.5,
      },
    },
    {
      id: src('landcover-grass-feather'),
      type: 'line',
      source: sourceId,
      'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['grass'], true, false],
      paint: {
        'line-color': '#bce0ae',
        'line-width': 14,
        'line-blur': 10,
        'line-opacity': 0.5,
      },
    },
    {
      id: src('landuse-green-feather'),
      type: 'line',
      source: sourceId,
      'source-layer': 'landuse',
      filter: [
        'in',
        'class',
        'grass',
        'garden',
        'recreation_ground',
        'village_green',
      ],
      paint: {
        'line-color': '#bce0ae',
        'line-width': 14,
        'line-blur': 10,
        'line-opacity': 0.5,
      },
    },
    {
      id: src('park-feather'),
      type: 'line',
      source: sourceId,
      'source-layer': 'park',
      paint: {
        'line-color': '#bce0ae',
        'line-width': 14,
        'line-blur': 10,
        'line-opacity': 0.5,
      },
    },
    {
      id: src('water'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'water',
      paint: { 'fill-color': '#cfe3ff', 'fill-opacity': ZOOM_FADE_OPACITY },
    },
    {
      id: src('waterway'),
      type: 'line',
      source: sourceId,
      'source-layer': 'waterway',
      paint: { 'line-color': '#cfe3ff', 'line-width': 1 },
    },
    {
      id: src('boundary'),
      type: 'line',
      source: sourceId,
      'source-layer': 'boundary',
      filter: ['<=', 'admin_level', 4],
      paint: {
        'line-color': '#c9c2d6',
        'line-width': 1,
        'line-dasharray': [2, 1.5],
      },
    },
    {
      id: src('transportation-casing'),
      type: 'line',
      source: sourceId,
      'source-layer': 'transportation',
      filter: ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#e2c483', 'line-width': 2.5 },
    },
    {
      id: src('transportation'),
      type: 'line',
      source: sourceId,
      'source-layer': 'transportation',
      filter: [
        'in',
        'class',
        'motorway',
        'trunk',
        'primary',
        'secondary',
        'tertiary',
        'minor',
      ],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#f6dfae', 'line-width': 1.3 },
    },
    {
      // Park/trail footpaths — same 'transportation' source-layer as the
      // roads above, just a different `class` value that was never in
      // those filters, so this data was already being downloaded and
      // decoded on every tile and simply never drawn. Gated to minzoom 16
      // (only relevant once zoomed into an actual park or campus) so it
      // adds zero cost at any wider view — no extra network/parsing
      // either way, this is purely "draw more of what's already there".
      id: src('path'),
      type: 'line',
      source: sourceId,
      'source-layer': 'transportation',
      minzoom: 16,
      filter: ['==', ['get', 'class'], 'path'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#c9a876',
        'line-width': 1.4,
        'line-dasharray': [2, 1.5],
        'line-opacity': 0.85,
      },
    },
    {
      id: src('building'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'building',
      minzoom: 13,
      paint: { 'fill-color': '#e9e3d8', 'fill-opacity': 0.8 },
    },
    {
      id: src('road-label'),
      type: 'symbol',
      source: sourceId,
      'source-layer': 'transportation_name',
      minzoom: 15,
      filter: [
        'in',
        'class',
        'motorway',
        'trunk',
        'primary',
        'secondary',
        'tertiary',
        'minor',
      ],
      layout: {
        'symbol-placement': 'line',
        'symbol-avoid-edges': true,
        'text-field': ['coalesce', ['get', 'name:ko'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
      },
      paint: {
        'text-color': '#6b6455',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.8,
      },
    },
    {
      id: src('poi-label'),
      type: 'symbol',
      source: sourceId,
      'source-layer': 'poi',
      minzoom: 13,
      filter: ['<=', ['get', 'rank'], 8],
      layout: {
        'symbol-avoid-edges': true,
        'text-field': ['coalesce', ['get', 'name:ko'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 0.6],
        'text-anchor': 'top',
      },
      paint: {
        'text-color': '#e8524f',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.8,
      },
    },
    {
      id: src('place-label'),
      type: 'symbol',
      source: sourceId,
      'source-layer': 'place',
      filter: ['in', 'class', 'city', 'town', 'village'],
      layout: {
        'symbol-avoid-edges': true,
        'text-field': ['coalesce', ['get', 'name:ko'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 13,
      },
      paint: {
        'text-color': '#2d3142',
        'text-halo-color': '#ffffff',
        'text-halo-width': 2,
      },
    },
    {
      id: src('mountain-peak-marker'),
      type: 'circle',
      source: sourceId,
      'source-layer': 'mountain_peak',
      minzoom: 8,
      paint: {
        'circle-radius': 4,
        'circle-color': '#5da652',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: src('mountain-peak-label'),
      type: 'symbol',
      source: sourceId,
      'source-layer': 'mountain_peak',
      minzoom: 8,
      layout: {
        'symbol-avoid-edges': true,
        'text-field': [
          'case',
          ['has', 'ele'],
          [
            'concat',
            ['coalesce', ['get', 'name:ko'], ['get', 'name']],
            ' (',
            ['to-string', ['get', 'ele']],
            'm)',
          ],
          ['coalesce', ['get', 'name:ko'], ['get', 'name']],
        ],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 0.7],
        'text-anchor': 'top',
      },
      paint: {
        'text-color': '#4d8c46',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.8,
      },
    },
  ];
}

function buildStyle() {
  return {
    version: 8,
    glyphs:
      'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources: {
      korea: {
        type: 'vector',
        url: `pmtiles://${KOREA_PMTILES_URL}`,
        attribution: MAP_ATTRIBUTION,
      },
      japan: {
        type: 'vector',
        url: `pmtiles://${JAPAN_PMTILES_URL}`,
        attribution: MAP_ATTRIBUTION,
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#fbf9f5' },
      },
      ...buildLayersForSource('korea'),
      ...buildLayersForSource('japan'),
    ],
  };
}

function allPointsVisible(map, coords) {
  const container = map.getContainer().getBoundingClientRect();
  return coords.every(([lng, lat]) => {
    const p = map.project([lng, lat]);
    return p.x >= 0 && p.x <= container.width && p.y >= 0 && p.y <= container.height;
  });
}

function zoomToFit(map, coords) {
  const bounds = new LngLatBounds();
  coords.forEach((c) => bounds.extend(c));
  const cam = map.cameraForBounds(bounds, { padding: 24, maxZoom: 17 });
  return cam && cam.zoom != null ? cam.zoom : map.getZoom();
}

// Repeatedly drops the pin farthest from the centroid of the rest, as long
// as doing so meaningfully raises the zoom fitBounds could use for what's
// left (a real outlier dragging the view out) — stops as soon as a drop
// wouldn't help much (the remaining pins are evenly spread, so every one of
// them matters, or MIN_LABEL_ZOOM is already reached). Keeps at least half
// the pins and never drops more than 30% of them, so a genuinely spread-out
// trip (e.g. several stops around an island) is left untouched.
function trimOutliers(map, coords) {
  const MIN_KEEP_RATIO = 0.5;
  const MAX_DROP_RATIO = 0.3;
  const MIN_ZOOM_GAIN = 0.5;

  let current = coords;
  const minKeep = Math.max(2, Math.ceil(coords.length * MIN_KEEP_RATIO));
  const maxDrop = Math.max(1, Math.floor(coords.length * MAX_DROP_RATIO));
  let dropped = 0;

  while (
    current.length > minKeep &&
    dropped < maxDrop &&
    zoomToFit(map, current) < MIN_LABEL_ZOOM
  ) {
    const cLng = current.reduce((sum, p) => sum + p[0], 0) / current.length;
    const cLat = current.reduce((sum, p) => sum + p[1], 0) / current.length;
    let farthestIndex = 0;
    let farthestDist = -1;
    current.forEach((p, i) => {
      const d = haversineDistanceKm(cLat, cLng, p[1], p[0]);
      if (d > farthestDist) {
        farthestDist = d;
        farthestIndex = i;
      }
    });

    const without = current.filter((_, i) => i !== farthestIndex);
    if (zoomToFit(map, without) - zoomToFit(map, current) >= MIN_ZOOM_GAIN) {
      current = without;
      dropped++;
    } else {
      break;
    }
  }

  return current;
}

const ROUTE_SOURCE_ID = 'trip-route';
const ROUTE_LAYER_ID = 'trip-route-line';
const ROUTE_SAMPLES_PER_SEGMENT = 24;

function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    0.5 *
    (2 * p1[0] +
      (-p0[0] + p2[0]) * t +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
  const y =
    0.5 *
    (2 * p1[1] +
      (-p0[1] + p2[1]) * t +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
  return [x, y];
}

// Smooth curve through the stops (Catmull-Rom spline) instead of straight
// point-to-point segments — matches the "부드럽게 잇는 곡선" the user asked
// for, computed purely client-side from the photos' own GPS coordinates
// (no routing service, no cost, doesn't follow real roads).
//
// Sampled at equal *arc-length* (real distance) intervals rather than
// equal curve-parameter steps. Catmull-Rom curves don't move at constant
// speed with respect to their parameter — near a bend, equal parameter
// steps can cover very different real distances. Since the route-play
// animation maps elapsed time linearly onto sample index, parameter-even
// sampling made the marker visibly speed up and slow down along the way;
// distance-even sampling keeps its screen speed constant instead.
function catmullRomSpline(points, samplesPerSegment) {
  if (points.length < 2) return points.slice();
  const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  const FINE_STEPS_PER_SAMPLE = 20;
  const result = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);

    // Densely sample this segment first, purely to measure real distance
    // along the curve — this is what lets us find equal-distance points
    // afterward, which the curve's own math can't give us directly.
    const fineCount = samplesPerSegment * FINE_STEPS_PER_SAMPLE;
    const finePoints = [];
    const cumulativeDist = [0];
    for (let s = 0; s <= fineCount; s++) {
      const pt = catmullRomPoint(p0, p1, p2, p3, s / fineCount);
      finePoints.push(pt);
      if (s > 0) {
        const prev = finePoints[s - 1];
        cumulativeDist.push(
          cumulativeDist[s - 1] +
            haversineDistanceKm(prev[1], prev[0], pt[1], pt[0])
        );
      }
    }
    const totalDist = cumulativeDist[cumulativeDist.length - 1];

    for (let k = 0; k < samplesPerSegment; k++) {
      const targetDist = totalDist * (k / samplesPerSegment);
      let fineIndex = 0;
      while (
        fineIndex < cumulativeDist.length - 2 &&
        cumulativeDist[fineIndex + 1] < targetDist
      ) {
        fineIndex++;
      }
      const distHere = cumulativeDist[fineIndex];
      const distNext = cumulativeDist[fineIndex + 1];
      const localT =
        distNext > distHere
          ? (targetDist - distHere) / (distNext - distHere)
          : 0;
      const a = finePoints[fineIndex];
      const b = finePoints[fineIndex + 1];
      result.push([a[0] + (b[0] - a[0]) * localT, a[1] + (b[1] - a[1]) * localT]);
    }
  }

  result.push(points[points.length - 1]);
  return result;
}

function TripMap({
  photos,
  selectedPhotoId,
  onSelectPhoto,
  routePlaying,
  onRoutePlayEnd,
  isPlacingLocation,
  onPickLocation,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({});
  const skipNextFlyRef = useRef(true);
  const overviewZoomRef = useRef(null);
  const routeSplineRef = useRef([]);
  const routeStopsRef = useRef({ photoIds: [], coords: [] });
  const stampMarkersRef = useRef({});
  const stampUrlsRef = useRef({});

  // Removes every photo "stamp" placed by the route-play animation and
  // revokes the object URLs it created for them — shared by the unmount
  // cleanup and by the pin-rebuild effect (a fresh set of photos/positions
  // makes any previous stamps stale).
  const clearStamps = useCallback(() => {
    Object.values(stampMarkersRef.current).forEach((m) => m.remove());
    stampMarkersRef.current = {};
    Object.values(stampUrlsRef.current).forEach((url) =>
      URL.revokeObjectURL(url)
    );
    stampUrlsRef.current = {};
  }, []);

  useEffect(() => {
    const protocol = new Protocol();
    addProtocol('pmtiles', protocol.tile);

    const map = new MapLibreMap({
      container: containerRef.current,
      style: buildStyle(),
      center: [130, 35.5],
      zoom: 4,
      attributionControl: false,
    });
    map.addControl(
      new AttributionControl({
        customAttribution: MAP_ATTRIBUTION,
        compact: true,
      })
    );
    mapRef.current = map;

    const capMinZoom = () => {
      const cam = map.cameraForBounds(KOREA_PENINSULA_BOUNDS, {
        padding: 20,
      });
      if (cam && cam.zoom != null) {
        map.setMinZoom(cam.zoom);
      }
    };
    if (map.loaded()) capMinZoom();
    else map.once('load', capMinZoom);

    return () => {
      Object.values(markersRef.current).forEach((m) => m.remove());
      markersRef.current = {};
      clearStamps();
      map.remove();
      mapRef.current = null;
      removeProtocol('pmtiles');
    };
  }, [clearStamps]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    const build = () => {
      Object.values(markersRef.current).forEach((m) => m.remove());
      markersRef.current = {};
      // A fresh photo list invalidates any stamps from a previous route-play
      // run — their coordinates/photo set may no longer match.
      clearStamps();
      const bounds = new LngLatBounds();
      const coords = [];
      const photoIds = [];

      photos.forEach((photo) => {
        if (photo.latitude == null || photo.longitude == null) return;
        const stopNumber = coords.length + 1;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'trip-map-pin';
        el.setAttribute(
          'aria-label',
          `${stopNumber}. ${photo.fileName || '사진 위치'}`
        );
        el.addEventListener('click', (event) => {
          // Without this, the click also reaches the map's own click
          // listener (the marker sits inside the same container MapLibre
          // listens on) — harmless normally, but during location-picking
          // mode (see the placingLocation effect below) that would both
          // select this pin AND place the pending photo at this spot.
          event.stopPropagation();
          onSelectPhoto?.(photo.id);
        });
        const shape = document.createElement('span');
        shape.className = 'trip-map-pin-shape';
        el.appendChild(shape);

        const marker = new Marker({ element: el, anchor: 'center' })
          .setLngLat([photo.longitude, photo.latitude])
          .addTo(map);
        markersRef.current[photo.id] = marker;
        bounds.extend([photo.longitude, photo.latitude]);
        coords.push([photo.longitude, photo.latitude]);
        photoIds.push(photo.id);
      });

      // Smooth line connecting the stops in order, purely as a client-side
      // visual (a spline through the GPS points) — not a real routed road.
      const spline =
        coords.length >= 2
          ? catmullRomSpline(coords, ROUTE_SAMPLES_PER_SEGMENT)
          : [];
      routeSplineRef.current = spline;
      routeStopsRef.current = { photoIds, coords };
      const routeGeoJson = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: spline },
      };
      const routeSource = map.getSource(ROUTE_SOURCE_ID);
      if (routeSource) {
        routeSource.setData(routeGeoJson);
      } else {
        map.addSource(ROUTE_SOURCE_ID, {
          type: 'geojson',
          data: routeGeoJson,
        });
        map.addLayer({
          id: ROUTE_LAYER_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          // Dotted, not dashed — matches the home screen's journey-preview
          // illustration (round line-cap + a zero-length dash draws just
          // the round cap as an evenly-spaced dot).
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#4d96ff',
            'line-width': 3,
            'line-dasharray': [0, 2],
            'line-opacity': 0.75,
          },
        });
      }

      if (coords.length === 0) return;

      if (coords.length === 1) {
        map.fitBounds(bounds, { padding: 24, maxZoom: 17, duration: 0 });
        if (map.getZoom() < MIN_LABEL_ZOOM) {
          map.setZoom(MIN_LABEL_ZOOM);
        }
        overviewZoomRef.current = map.getZoom();
        return;
      }

      // Fit to the largest cluster of nearby pins rather than every pin —
      // a handful of stray far-off stops shouldn't force the initial view
      // to zoom out to fit them (see trimOutliers above). Pins outside the
      // main cluster are still placed on the map, just outside the initial
      // frame until the user pans or zooms out.
      const mainCluster = trimOutliers(map, coords);
      const fitBoundsTarget = new LngLatBounds();
      mainCluster.forEach((c) => fitBoundsTarget.extend(c));

      map.fitBounds(fitBoundsTarget, {
        padding: 24,
        maxZoom: 17,
        duration: 0,
      });

      // fitBounds' own fit can still leave dead space when the cluster's
      // bounding box is a different shape than the map container (its zoom
      // is capped by whichever axis hits the container edge first, which
      // may not be the pins' actual spread). Nudge in a bit further,
      // backing off step by step if that would push a cluster pin outside
      // the viewport.
      const baseZoom = map.getZoom();
      let candidate = Math.min(baseZoom + SHORT_TRIP_ZOOM_BOOST, 17);
      map.setZoom(candidate);
      while (candidate > baseZoom && !allPointsVisible(map, mainCluster)) {
        candidate = Math.max(baseZoom, candidate - ZOOM_BOOST_STEP);
        map.setZoom(candidate);
      }
      overviewZoomRef.current = map.getZoom();
    };

    if (map.loaded()) build();
    else map.once('load', build);
  }, [photos, onSelectPhoto, clearStamps]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    Object.entries(markersRef.current).forEach(([id, marker]) => {
      marker
        .getElement()
        .classList.toggle('trip-map-pin--active', id === selectedPhotoId);
    });

    const photo = photos.find((p) => p.id === selectedPhotoId);
    if (!photo || photo.latitude == null || photo.longitude == null) {
      return undefined;
    }

    // While the 3D route is playing, its own animation effect below drives
    // the camera every frame — this effect reacting to the same selection
    // changes (which that animation triggers, to keep the timeline strip in
    // sync) would fight it for control of the camera.
    if (routePlaying) return undefined;

    // The initial selection (on mount) is already framed by fitBounds above —
    // animating a second camera move right on top of that is what caused the
    // stutter (fitBounds' tiles get thrown away mid-load as flyTo requests a
    // whole new zoom level). Only animate for moves the user actually asked
    // for after that.
    if (skipNextFlyRef.current) {
      skipNextFlyRef.current = false;
      return undefined;
    }

    const fly = () => {
      // If the selected pin is already on screen, don't move the camera at
      // all — the overview was deliberately framed to fit the main cluster
      // together, and re-centering on any one pin in that tight a fit
      // necessarily pushes its neighbors out (it was already at the edge
      // of the frame). Moving only when the pin is actually out of view
      // means: no needless camera motion (no stutter) for the common case,
      // and the rest of the trip stays visible unless the selected pin
      // genuinely wasn't shown before.
      // Small margin, not the fitBounds padding (24px) — pins the overview
      // fit exactly to that padding otherwise land right on this boundary
      // and register as "off screen" by a fraction of a pixel.
      const container = map.getContainer().getBoundingClientRect();
      const margin = 4;
      const screenPos = map.project([photo.longitude, photo.latitude]);
      const alreadyVisible =
        screenPos.x >= margin &&
        screenPos.x <= container.width - margin &&
        screenPos.y >= margin &&
        screenPos.y <= container.height - margin;
      if (alreadyVisible) return;

      // The pin wasn't on screen (e.g. it was left out of the initial
      // cluster fit as a stray outlier) — ease to it, re-using the
      // overview's zoom rather than the map's current zoom or a fixed
      // level, so this doesn't also introduce a jarring zoom change.
      const targetZoom = overviewZoomRef.current ?? map.getZoom();
      map.easeTo({
        center: [photo.longitude, photo.latitude],
        zoom: targetZoom,
        duration: 600,
        essential: true,
      });
    };

    if (map.loaded()) fly();
    else map.once('load', fly);

    return undefined;
  }, [selectedPhotoId, photos, routePlaying]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !routePlaying) return undefined;

    const spline = routeSplineRef.current;
    const stops = routeStopsRef.current;
    if (spline.length < 2 || stops.photoIds.length < 2) {
      onRoutePlayEnd?.();
      return undefined;
    }

    // The expensive part on every camera change isn't drawing these labels,
    // it's resolving collisions between them (deciding which overlapping
    // ones to hide). Letting them overlap freely during the flythrough
    // skips that step — labels may crowd each other briefly while the
    // camera's mid-pan, which barely reads at speed — without the labels
    // vanishing outright the way hiding the layers did.
    LABEL_LAYER_IDS.forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'text-allow-overlap', true);
        map.setLayoutProperty(id, 'text-ignore-placement', true);
        map.setLayoutProperty(id, 'icon-allow-overlap', true);
      }
    });

    FEATHER_LAYER_IDS.forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', 'none');
      }
    });

    // Keep the user from panning/zooming away mid-flythrough — the camera
    // is already driving itself via easeTo below, and a manual drag/scroll
    // while that's happening fights it (the next easeTo call just yanks the
    // view back), which reads as broken rather than just "can't move".
    const interactionHandlers = [
      map.dragPan,
      map.scrollZoom,
      map.doubleClickZoom,
      map.touchZoomRotate,
      map.boxZoom,
      map.keyboard,
      map.dragRotate,
      map.touchPitch,
    ].filter(Boolean);
    interactionHandlers.forEach((handler) => handler.disable());

    // Reset from any earlier play-through so a replay starts with a clean
    // passport rather than piling stamps on top of the previous run's.
    clearStamps();

    // Warm up every stop photo's object URL + image decode ahead of when
    // each stamp actually needs it, instead of paying for both the first
    // time it's dropped mid-animation. JPEG decode is real main-thread
    // work — but doing this *synchronously* right here, in the same tick
    // that also toggles ~30+ layer properties above and is about to kick
    // off the camera's first easeTo, was itself piling extra work onto the
    // very first frame (measured: a 666ms spike in the opening seconds,
    // well before any stop was even reached). Deferred via setTimeout so it
    // runs as its own task after that critical startup frame has had a
    // chance to render, not competing with it.
    setTimeout(() => {
      stops.photoIds.forEach((photoId) => {
        if (!photoId || stampUrlsRef.current[photoId]) return;
        const photo = photos.find((p) => p.id === photoId);
        if (!photo?.file) return;
        const url = URL.createObjectURL(photo.file);
        stampUrlsRef.current[photoId] = url;
        const warmImg = new Image();
        warmImg.src = url;
        warmImg.decode?.().catch(() => {});
      });
    }, 0);

    // Drops a passport-style photo stamp at a stop the traveler marker has
    // just reached — a visual "checked in here" mark that stays on the map
    // for the rest of this playback (cleared on the next run or whenever
    // the photo set changes, via clearStamps above).
    const stampStop = (legIndex) => {
      const photoId = stops.photoIds[legIndex];
      if (!photoId || stampMarkersRef.current[photoId]) return;
      const photo = photos.find((p) => p.id === photoId);
      if (!photo) return;

      const el = document.createElement('div');
      el.className = 'trip-map-stamp';
      // Alternating tilt (deterministic, not random) so consecutive stamps
      // don't all lean the same way, without needing extra state.
      const tilt = (4 + (legIndex % 3) * 3) * (legIndex % 2 === 0 ? -1 : 1);
      el.style.setProperty('--stamp-tilt', `${tilt}deg`);
      const inner = document.createElement('div');
      inner.className = 'trip-map-stamp-shape';
      if (photo.file) {
        // Preloaded above, before playback started — falls back to creating
        // one on the spot only if this stop was somehow missed there.
        const url =
          stampUrlsRef.current[photoId] || URL.createObjectURL(photo.file);
        stampUrlsRef.current[photoId] = url;
        const img = document.createElement('img');
        img.className = 'trip-map-stamp-img';
        img.src = url;
        img.alt = '';
        inner.appendChild(img);
      } else {
        inner.classList.add('trip-map-stamp-shape--placeholder');
        inner.textContent = photo.placeholderEmoji || '📷';
      }
      el.appendChild(inner);

      const marker = new Marker({ element: el, anchor: 'center' })
        .setLngLat(stops.coords[legIndex])
        .addTo(map);
      stampMarkersRef.current[photoId] = marker;

      // Added post-mount so the "stamp-in" animation (defined on
      // .trip-map-stamp--landed) actually transitions in, instead of
      // starting in its end state if the class were present from creation.
      requestAnimationFrame(() => el.classList.add('trip-map-stamp--landed'));
    };

    const travelEl = document.createElement('div');
    travelEl.className = 'trip-map-travel-marker';
    // Separate element for the left/right flip (see the direction check in
    // step() below) — the walking bob animation already owns `transform`
    // on the img itself (a CSS animation replaces the whole property, so
    // it can't share it with a plain toggled style), and this one can't
    // carry it either since MapLibre writes the position transform
    // directly onto travelEl every frame.
    const travelFlip = document.createElement('div');
    travelFlip.className = 'trip-map-travel-marker-flip';
    const travelShape = document.createElement('img');
    travelShape.className = 'trip-map-travel-marker-shape';
    travelShape.src = WALK_FRAMES[0];
    travelShape.alt = '';
    travelFlip.appendChild(travelShape);
    travelEl.appendChild(travelFlip);
    let lastWalkFrame = 0;
    let facingRight = false;
    const travelMarker = new Marker({ element: travelEl, anchor: 'bottom' })
      .setLngLat(spline[0])
      .addTo(map);

    // The marker starts exactly at stop 1's coordinates, but the camera is
    // still wherever the overview left it (typically the framed cluster's
    // centroid, not stop 1) — without snapping it here first, the first leg's
    // easeTo below starts from that mismatched position, so the marker
    // visibly jumps relative to the view for the first ~second while the
    // camera catches up. Measured up to ~400px of drift at launch before
    // this fix. Also pins the zoom back to the initial overview level —
    // without this the flythrough starts from whatever zoom the map
    // happened to be at (e.g. still zoomed into whichever photo the user
    // had selected before hitting play), instead of the same framing the
    // trip was first shown at.
    const playbackZoom = overviewZoomRef.current ?? map.getZoom();
    map.jumpTo({ center: spline[0], zoom: playbackZoom });

    // Every leg drives off the same constant real-world speed, so the
    // marker's pace never visibly changes from one leg to the next. (An
    // earlier version derived each leg's duration from a fixed overall
    // total, then floored short legs up to a minimum duration so they
    // wouldn't flash by instantly — but that floor made short legs slower
    // than the others instead, which is exactly the "느려졌다 빨라졌다"
    // speed change that was the problem. Deriving duration directly from
    // distance ÷ speed has no such floor to break uniformity: a short leg
    // is simply quick to cross, at the same speed as everything else.)
    // Tuned slower than earlier passes per feedback that it still felt
    // too fast overall.
    const SPEED_KM_PER_MS = 0.00018;
    const MIN_LEG_DURATION_MS = 200;
    const numLegs = stops.coords.length - 1;
    const legDistancesKm = [];
    for (let i = 0; i < numLegs; i++) {
      const [lngA, latA] = stops.coords[i];
      const [lngB, latB] = stops.coords[i + 1];
      legDistancesKm.push(haversineDistanceKm(latA, lngA, latB, lngB));
    }
    // The fixed speed above is tuned to feel right for a typical trip's
    // scale (photos a walk/drive apart). A trip that spans a whole island
    // (e.g. the Jeju sample route) covers far more real-world distance, so
    // at the same constant speed it would take minutes to play out instead
    // of the few seconds it should — effectively looking "stuck". Capping
    // the total playback time and deriving an effective speed from that cap
    // (only when the trip is big enough to need it — smaller trips keep the
    // tuned base speed untouched) keeps the flythrough feeling brisk
    // regardless of the trip's real-world scale.
    const MAX_TOTAL_DURATION_MS = 16000;
    const totalDistanceKm = legDistancesKm.reduce((a, b) => a + b, 0);
    const effectiveSpeedKmPerMs = Math.max(
      SPEED_KM_PER_MS,
      totalDistanceKm / MAX_TOTAL_DURATION_MS
    );
    const legDurationsMs = legDistancesKm.map((d) =>
      Math.max(MIN_LEG_DURATION_MS, d / effectiveSpeedKmPerMs)
    );
    const legStartMs = [0];
    for (let i = 0; i < numLegs; i++) {
      legStartMs.push(legStartMs[i] + legDurationsMs[i]);
    }
    const totalDurationMs = legStartMs[numLegs];

    let startTime = performance.now();
    let lastFrameNow = startTime;
    let rafId;
    let currentLeg = 0;
    onSelectPhoto?.(stops.photoIds[0]);
    stampStop(0);

    // Tried driving the camera by hand every frame (map.jumpTo tracking the
    // same interpolated point as the marker) instead of chaining easeTo per
    // leg, hoping to remove the restart cost at leg boundaries now that
    // label collision + feather blur are already off during playback.
    // Measured worse, not better (25 hitches >30ms vs 19, worst spike 466ms
    // vs 350ms) — jumpTo forces MapLibre to reproject and repaint every
    // remaining active layer synchronously on every single call, and at 60
    // calls/sec that cost is bigger than the per-leg restart cost it was
    // meant to avoid.
    //
    // What actually measured as the hitch source was clusters of *short*
    // legs firing a new easeTo every few hundred ms (stops close together
    // in real distance) — each call interrupts and restarts MapLibre's
    // transition state. So instead of one easeTo per leg, consecutive short
    // legs are merged into a single easeTo that glides straight through all
    // of them at once — one continuous camera motion instead of several
    // rapid restarts. A long leg on its own still gets its own easeTo; only
    // legs *below* the merge threshold get bundled with their neighbors.
    const CAMERA_MERGE_THRESHOLD_MS = 900;
    const cameraSegments = [];
    {
      let segDurationMs = 0;
      for (let i = 0; i < numLegs; i++) {
        const legDur = legDurationsMs[i];
        // A leg that's already long on its own must never get folded into
        // whatever short legs came before it (that would merge a huge
        // real-world jump into one continuous glide, forcing a burst of
        // fresh tile loads mid-pan) — flush the accumulated short-leg
        // group as its own segment first, *then* start counting this leg.
        if (legDur >= CAMERA_MERGE_THRESHOLD_MS && segDurationMs > 0) {
          cameraSegments.push({ toLeg: i - 1, durationMs: segDurationMs });
          segDurationMs = 0;
        }
        segDurationMs += legDur;
        const isLastLeg = i === numLegs - 1;
        if (segDurationMs >= CAMERA_MERGE_THRESHOLD_MS || isLastLeg) {
          cameraSegments.push({ toLeg: i, durationMs: segDurationMs });
          segDurationMs = 0;
        }
      }
    }
    // Which leg starts each segment, so the leg-boundary loop below knows
    // when to actually kick off a new easeTo vs. let an in-flight one keep
    // gliding through a merged stop.
    const segmentByStartLeg = new Map();
    {
      let legCursor = 0;
      cameraSegments.forEach((seg) => {
        segmentByStartLeg.set(legCursor, seg);
        legCursor = seg.toLeg + 1;
      });
    }
    const advanceCameraLeg = (legIndex) => {
      const seg = segmentByStartLeg.get(legIndex);
      if (!seg) return;
      map.easeTo({
        center: stops.coords[seg.toLeg + 1],
        zoom: playbackZoom,
        duration: seg.durationMs,
        easing: (x) => x,
      });
    };
    advanceCameraLeg(0);

    const step = (now) => {
      // If the browser stalled between frames for a while — tab backgrounded,
      // GPU busy with a big camera paint, iOS Safari throttling rAF, etc. —
      // that gap must not count as playback progress. Without this, the
      // very next frame's `elapsed` jumps so far ahead that `t` below
      // clamps straight to 1, and the marker/camera warp instantly to the
      // final stop instead of continuing to play through the rest of the
      // route (observed on iOS Safari: playback froze partway, then jumped
      // straight to the last coordinate). Pushing `startTime` forward by
      // the stall's length makes playback simply resume where it left off.
      const frameGap = now - lastFrameNow;
      if (frameGap > 250) {
        startTime += frameGap;
      }
      lastFrameNow = now;

      // Clamp to >= 0: the rAF callback's timestamp can land a fraction of
      // a millisecond before the `startTime` captured just above (a known
      // rAF timing quirk), which without this floors to index -1 and hands
      // `spline[-1]` (undefined) to setLngLat.
      const elapsed = Math.max(0, now - startTime);
      const t = Math.min(elapsed / totalDurationMs, 1);

      while (
        currentLeg < numLegs - 1 &&
        elapsed >= legStartMs[currentLeg + 1]
      ) {
        currentLeg++;
        const legToStamp = currentLeg;
        // onSelectPhoto triggers a React re-render up in MapTimelineScreen
        // (route-strip + timeline active-item highlighting), and stampStop
        // builds a DOM node (photo <img>, decode included) and inserts a
        // whole new MapLibre Marker — both real layout/paint cost. Doing
        // either in the same frame the boundary is crossed piled expensive
        // work onto that frame, which is what read as a "드드득" hitch right
        // as each stop's photo popped in. Pushing both to the very next
        // frame keeps this frame to just the cheap position update below.
        requestAnimationFrame(() => {
          onSelectPhoto?.(stops.photoIds[legToStamp]);
          stampStop(legToStamp);
        });
        advanceCameraLeg(currentLeg);
      }

      const legElapsed = elapsed - legStartMs[currentLeg];
      const legT = Math.max(
        0,
        Math.min(1, legElapsed / legDurationsMs[currentLeg])
      );
      // Only ROUTE_SAMPLES_PER_SEGMENT samples per leg, but a leg plays
      // over dozens of frames — snapping to the nearest sample left the
      // marker sitting still for several frames before jumping to the
      // next one, which read as a juddery "드드드득" stepping motion.
      // Interpolating between the two samples straddling the current
      // moment moves it continuously every single frame instead.
      const scaledLocal = legT * ROUTE_SAMPLES_PER_SEGMENT;
      const localIndex = Math.min(
        ROUTE_SAMPLES_PER_SEGMENT - 1,
        Math.floor(scaledLocal)
      );
      const frac = scaledLocal - localIndex;
      const base = currentLeg * ROUTE_SAMPLES_PER_SEGMENT;
      const p0 = spline[Math.min(spline.length - 1, base + localIndex)];
      const p1 = spline[Math.min(spline.length - 1, base + localIndex + 1)];
      const pos = [
        p0[0] + (p1[0] - p0[0]) * frac,
        p0[1] + (p1[1] - p0[1]) * frac,
      ];
      travelMarker.setLngLat(pos);

      // The art faces left by default — flip it for the stretch of the
      // route currently heading east (increasing longitude = rightward on
      // screen, since the map is always shown north-up). Uses the same
      // p0→p1 segment already computed above rather than tracking a
      // separate previous-position, so it needs no extra state and is
      // never wrong on the very first frame.
      const movingRight = p1[0] - p0[0] > 0;
      if (movingRight !== facingRight) {
        facingRight = movingRight;
        travelFlip.style.transform = facingRight ? 'scaleX(-1)' : '';
      }

      const walkFrame =
        Math.floor(elapsed / WALK_FRAME_INTERVAL_MS) % WALK_FRAMES.length;
      if (walkFrame !== lastWalkFrame) {
        lastWalkFrame = walkFrame;
        travelShape.src = WALK_FRAMES[walkFrame];
      }

      if (t >= 1 && currentLeg === numLegs - 1) {
        onSelectPhoto?.(stops.photoIds[numLegs]);
        stampStop(numLegs);
      }

      if (t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        onRoutePlayEnd?.();
      }
    };
    rafId = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(rafId);
      travelMarker.remove();
      LABEL_LAYER_IDS.forEach((id) => {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'text-allow-overlap', false);
          map.setLayoutProperty(id, 'text-ignore-placement', false);
          map.setLayoutProperty(id, 'icon-allow-overlap', false);
        }
      });
      FEATHER_LAYER_IDS.forEach((id) => {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', 'visible');
        }
      });
      interactionHandlers.forEach((handler) => handler.enable());
    };
  }, [routePlaying, onSelectPhoto, onRoutePlayEnd, clearStamps, photos]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isPlacingLocation) return undefined;

    const handleClick = (e) => {
      onPickLocation?.({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
    };

    const setCursor = () => {
      map.getCanvas().style.cursor = 'crosshair';
    };
    if (map.loaded()) setCursor();
    else map.once('load', setCursor);

    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
      map.getCanvas().style.cursor = '';
    };
  }, [isPlacingLocation, onPickLocation]);

  return <div ref={containerRef} className="trip-map" />;
}

export default TripMap;
