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

// Every land-detail fill (forest/park green, farmland, built-up areas) is a
// discrete OSM polygon, so zoomed way out they speckle the country with
// hard-edged blobs rather than reading as terrain. Gate all of them — plus
// the feather outlines and the mountain-peak markers/labels — to this zoom
// so the national/regional overview is one clean flat land colour; the
// detail fades in only once you're zoomed into an actual trip area.
const LAND_DETAIL_MIN_ZOOM = 10;

const SHORT_TRIP_ZOOM_BOOST = 1.2;
const ZOOM_BOOST_STEP = 0.1;

// Route playback stamps a trail of paw prints along the path instead of
// moving 토리 along it. Prints are dropped at a fixed on-screen spacing as
// the traveled distance advances; PAW_SPACING_PX is that spacing, MAX_PAWS
// caps the DOM node count on very long routes (spacing widens to fit). The
// whole trail is cleared when playback ends (see the effect cleanup).
// Spacing is deliberately wide — each print should sit on its own with a
// clear gap, so the paw shape actually reads instead of blurring into a
// dotted line.
const PAW_SPACING_PX = 52;
const MAX_PAWS = 70;

// Same 3-bean paw as the <Paw> doodle on the home screen (Doodles.js) —
// kept in sync by hand so the route trail and the home-screen decorations
// read as one mark. Toes point "up" (−y); dropPaw rotates the whole thing
// to the route's local heading. Fill follows `currentColor` (the deep
// caramel set on .trip-map-paw-shape in TripMap.css).
const PAW_SVG = `<svg viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">
<ellipse cx="15" cy="20" rx="7.5" ry="6"/>
<ellipse cx="6.5" cy="12.5" rx="3.2" ry="4"/>
<ellipse cx="15" cy="9" rx="3.4" ry="4.2"/>
<ellipse cx="23.5" cy="12.5" rx="3.2" ry="4"/>
</svg>`;

// The blurred "feather" outline layers (line-blur) soften the edges of the
// forest/park greens so mountain ranges read as soft masses rather than
// hard-edged blobs. line-blur is an expensive paint property (a GPU blur
// pass per layer, per frame), so all 8 (4 kinds × korea/japan) are hidden
// for the duration of route playback and restored afterward.
const FEATHER_LAYER_IDS = ['korea', 'japan'].flatMap((source) =>
  [
    'landcover-wood-feather',
    'landcover-grass-feather',
    'landuse-green-feather',
    'park-feather',
  ].map((layer) => `${layer}-${source}`)
);

// Route-play "stamp" photos render at just 46px on screen (see
// .trip-map-stamp in TripMap.css), but a real phone photo is several MB and
// 3000px+ on a side, so decoding one just to show a 46px circle is real
// main-thread work. createImageBitmap's resize option decodes at a much
// smaller internal resolution and the tiny JPEG it re-encodes to is then
// trivially cheap to paint.
//
// The catch measured in Chrome: one such decode is ~250ms, but firing all
// of a trip's stops at once (Promise.all-style) put them in contention and
// each ballooned to 1.5–2.5s, freezing playback. So (a) every call is
// serialized through this module-level chain — one decode at a time — and
// (b) they're kicked off when the route is built (see the pin-build
// effect), well before the user can press play, so playback itself does
// zero image work.
const STAMP_THUMB_MAX_SIZE = 128;

let thumbnailChain = Promise.resolve();

async function decodeStampThumbnail(file) {
  try {
    const bitmap = await createImageBitmap(file, {
      resizeWidth: STAMP_THUMB_MAX_SIZE,
      resizeQuality: 'low',
    });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.75)
    );
    if (blob) return URL.createObjectURL(blob);
  } catch {
    // createImageBitmap/canvas unsupported or failed — fall through.
  }
  return URL.createObjectURL(file);
}

function createStampThumbnailUrl(file) {
  const run = () => decodeStampThumbnail(file);
  const result = thumbnailChain.then(run, run);
  // Keep the chain alive even if this one rejects, and don't let it retain
  // the resolved URL.
  thumbnailChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

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
// Clean, neutral "big map app" look — pale grey-green land, soft blue
// water, muted forest green, thin light roads. Only a very slight fade at
// far zoom so the tone stays consistent (unlike the old warm Naver/Kakao
// treatment that went noticeably paler when zoomed out).
const ZOOM_FADE_OPACITY = [
  'interpolate',
  ['linear'],
  ['zoom'],
  3,
  0.82,
  7,
  0.9,
  11,
  0.97,
  14,
  1,
];

function buildLayersForSource(sourceId) {
  const src = (id) => `${id}-${sourceId}`;
  return [
    {
      id: src('landcover-wood'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'landcover',
      minzoom: LAND_DETAIL_MIN_ZOOM,
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
      // below and read as plain grey instead of green.
      id: src('landcover-grass'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'landcover',
      minzoom: LAND_DETAIL_MIN_ZOOM,
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
      minzoom: LAND_DETAIL_MIN_ZOOM,
      filter: [
        '!',
        ['match', ['get', 'class'], ['wood', 'forest', 'grass'], true, false],
      ],
      paint: { 'fill-color': '#e9ece3', 'fill-opacity': ZOOM_FADE_OPACITY },
    },
    {
      id: src('landuse'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'landuse',
      minzoom: LAND_DETAIL_MIN_ZOOM,
      filter: ['in', 'class', 'residential', 'suburb', 'neighbourhood'],
      paint: { 'fill-color': '#e4e6df', 'fill-opacity': ZOOM_FADE_OPACITY },
    },
    {
      // Grassy grounds (e.g. 경주 동궁과 월지's palace/pond grounds) — the
      // 'landuse' source-layer tags these as class 'grass'/'garden'/etc,
      // separate from the 'park' source-layer below (which only covers
      // leisure=park), so without this they fell through to the generic
      // landcover fill and read as plain grey instead of green.
      id: src('landuse-green'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'landuse',
      minzoom: LAND_DETAIL_MIN_ZOOM,
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
      minzoom: LAND_DETAIL_MIN_ZOOM,
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
      minzoom: LAND_DETAIL_MIN_ZOOM,
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
      minzoom: LAND_DETAIL_MIN_ZOOM,
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
      minzoom: LAND_DETAIL_MIN_ZOOM,
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
      minzoom: LAND_DETAIL_MIN_ZOOM,
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
      paint: { 'fill-color': '#a9cfe3', 'fill-opacity': ZOOM_FADE_OPACITY },
    },
    {
      id: src('waterway'),
      type: 'line',
      source: sourceId,
      'source-layer': 'waterway',
      paint: { 'line-color': '#a3c6da', 'line-width': 1 },
    },
    {
      id: src('boundary'),
      type: 'line',
      source: sourceId,
      'source-layer': 'boundary',
      filter: ['<=', 'admin_level', 4],
      paint: {
        'line-color': '#c1c4ca',
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
      paint: { 'line-color': '#dcdcd8', 'line-width': 2.4 },
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
      paint: { 'line-color': '#ffffff', 'line-width': 1.5 },
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
        'line-color': '#d0d0cb',
        'line-width': 1.3,
        'line-dasharray': [2, 1.5],
        'line-opacity': 0.9,
      },
    },
    {
      id: src('building'),
      type: 'fill',
      source: sourceId,
      'source-layer': 'building',
      minzoom: 13,
      paint: { 'fill-color': '#e6e6e0', 'fill-opacity': 0.6 },
    },
  ];
}

// Label + marker layers, kept separate from the fill/line base above so
// buildStyle can stack ALL labels (both sources) on top of ALL fills.
// When korea's and japan's full layer sets were simply concatenated,
// japan's translucent water/landcover fills were painted *over* korea's
// place labels near the coast — "부산광역시" and friends came out
// washed-grey while japan's own labels (drawn last) stayed crisp.
function buildLabelLayersForSource(sourceId) {
  const src = (id) => `${id}-${sourceId}`;
  return [
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
        'text-padding': 8,
      },
      paint: {
        'text-color': '#83878d',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.6,
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
        // OSM stores many places as both a point and an area, so the tiles
        // carry the same name twice at slightly different spots. A generous
        // collision box around each POI label makes those near-duplicates
        // knock each other out — only one survives.
        'text-padding': 16,
      },
      paint: {
        'text-color': '#8b8f95',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    },
    {
      id: src('place-label'),
      type: 'symbol',
      source: sourceId,
      'source-layer': 'place',
      filter: ['in', 'class', 'country', 'state', 'city', 'town', 'village'],
      layout: {
        'symbol-avoid-edges': true,
        'text-field': ['coalesce', ['get', 'name:ko'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': [
          'match',
          ['get', 'class'],
          'country',
          15,
          'state',
          12,
          13,
        ],
        'text-padding': 18,
      },
      paint: {
        'text-color': [
          'match',
          ['get', 'class'],
          'country',
          '#9a9a9a',
          '#4b4b4b',
        ],
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.6,
      },
    },
    {
      id: src('mountain-peak-marker'),
      type: 'circle',
      source: sourceId,
      'source-layer': 'mountain_peak',
      minzoom: LAND_DETAIL_MIN_ZOOM,
      paint: {
        'circle-radius': 3.5,
        'circle-color': '#8aa47b',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: src('mountain-peak-label'),
      type: 'symbol',
      source: sourceId,
      'source-layer': 'mountain_peak',
      minzoom: LAND_DETAIL_MIN_ZOOM,
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
        'text-padding': 12,
      },
      paint: {
        'text-color': '#728a63',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.6,
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
        paint: { 'background-color': '#eef0ea' },
      },
      // All fills/lines from both sources first, then all labels from both
      // sources — so no source's translucent water/land fill can paint
      // over another source's labels (see buildLabelLayersForSource).
      ...buildLayersForSource('korea'),
      ...buildLayersForSource('japan'),
      ...buildLabelLayersForSource('korea'),
      ...buildLabelLayersForSource('japan'),
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

// Each leg of the route gets a gentle arch (see catmullRomSpline) so the
// whole path reads as a flowing curved journey line even when the photos'
// GPS points fall in a near-straight line — the raw spline through such
// points is visually straight, worst of all on the first/last leg. Arch
// height is CURVE_ARCH_RATIO of the leg's own length, capped at
// CURVE_ARCH_MAX_KM so a cross-island leg doesn't balloon, and it
// alternates side leg-to-leg for a hand-drawn "dotted trail" look.
const CURVE_ARCH_RATIO = 0.13;
const CURVE_ARCH_MAX_KM = 1.6;
const KM_PER_DEG_LAT = 110.574;

// One point on a centripetal Catmull-Rom segment p1→p2 (u in [0,1]).
// Centripetal (α=0.5) parametrization rather than uniform: uniform
// Catmull-Rom overshoots — loops out past the stops — when the stops are
// unevenly spaced (visible kink on the Jeju sample). Centripetal knot
// spacing removes that. Barry–Goldman pyramidal form; knot deltas are
// floored so coincident points can't divide by zero.
function centripetalPoint(p0, p1, p2, p3, u) {
  const knot = (t, a, b) =>
    t + Math.pow(Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-6), 0.5);
  const t0 = 0;
  const t1 = knot(t0, p0, p1);
  const t2 = knot(t1, p1, p2);
  const t3 = knot(t2, p2, p3);
  const t = t1 + (t2 - t1) * u;
  const lerp = (a, b, ta, tb) => {
    const w = (tb - t) / (tb - ta);
    return [a[0] * w + b[0] * (1 - w), a[1] * w + b[1] * (1 - w)];
  };
  const A1 = lerp(p0, p1, t0, t1);
  const A2 = lerp(p1, p2, t1, t2);
  const A3 = lerp(p2, p3, t2, t3);
  const B1 = lerp(A1, A2, t0, t2);
  const B2 = lerp(A2, A3, t1, t3);
  return lerp(B1, B2, t1, t2);
}

// Smooth curve through the stops (centripetal Catmull-Rom + a per-leg
// arch) instead of straight point-to-point segments — matches the
// "부드럽게 잇는 곡선" / "둥그렇게" the user asked for, computed purely
// client-side from the photos' own GPS coordinates (no routing service, no
// cost, doesn't follow real roads).
//
// Sampled at equal *arc-length* (real distance) intervals rather than
// equal curve-parameter steps. The curve doesn't move at constant speed
// with respect to its parameter — near a bend, equal parameter steps can
// cover very different real distances. Since the route-play animation maps
// elapsed time linearly onto sample index, parameter-even sampling made
// playback visibly speed up and slow down along the way; distance-even
// sampling keeps its on-screen speed constant instead.
function catmullRomSpline(points, samplesPerSegment) {
  if (points.length < 2) return points.slice();
  // Reflected phantom points past each end (rather than clamping to the
  // endpoint) so the first and last legs get a real tangent and can arch
  // like the middle ones, and so the centripetal knot spacing never sees a
  // zero-length end gap.
  const at = (i) => {
    if (i < 0) {
      return [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]];
    }
    if (i >= points.length) {
      const n = points.length;
      return [
        2 * points[n - 1][0] - points[n - 2][0],
        2 * points[n - 1][1] - points[n - 2][1],
      ];
    }
    return points[i];
  };
  const FINE_STEPS_PER_SAMPLE = 20;
  const result = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);

    // Perpendicular to this leg's chord, in a locally-equal-aspect planar
    // space (longitude scaled by cos(lat)) so the arch looks symmetric on
    // screen rather than skewed by the lng/lat aspect ratio at this
    // latitude. The arch itself is a cosine bump: zero at both stops with
    // zero slope there, so it adds bulge to the middle of the leg without
    // disturbing where the curve meets each stop.
    const latMid = (p1[1] + p2[1]) / 2;
    const cosLat = Math.cos((latMid * Math.PI) / 180) || 1e-6;
    const chordPlanar = Math.hypot(
      (p2[0] - p1[0]) * cosLat,
      p2[1] - p1[1]
    );
    let perpX = 0;
    let perpY = 0;
    if (chordPlanar > 1e-9) {
      perpX = -(p2[1] - p1[1]) / chordPlanar;
      perpY = ((p2[0] - p1[0]) * cosLat) / chordPlanar;
    }
    const chordKm = haversineDistanceKm(p1[1], p1[0], p2[1], p2[0]);
    const archDeg =
      Math.min(chordKm * CURVE_ARCH_RATIO, CURVE_ARCH_MAX_KM) / KM_PER_DEG_LAT;
    const archSide = i % 2 === 0 ? 1 : -1;

    // Densely sample this segment first, purely to measure real distance
    // along the curve — this is what lets us find equal-distance points
    // afterward, which the curve's own math can't give us directly.
    const fineCount = samplesPerSegment * FINE_STEPS_PER_SAMPLE;
    const finePoints = [];
    const cumulativeDist = [0];
    for (let s = 0; s <= fineCount; s++) {
      const u = s / fineCount;
      const base = centripetalPoint(p0, p1, p2, p3, u);
      const bump = (1 - Math.cos(2 * Math.PI * u)) / 2;
      const off = archDeg * bump * archSide;
      const pt = [base[0] + (perpX * off) / cosLat, base[1] + perpY * off];
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
  const pawMarkersRef = useRef([]);

  // Removes the placed stamp + paw-print markers (a replay starts from a
  // clean passport) but keeps the decoded stamp thumbnails around — they're
  // keyed by photo id and stay valid until the photo set changes.
  const clearStampMarks = useCallback(() => {
    Object.values(stampMarkersRef.current).forEach((m) => m.remove());
    stampMarkersRef.current = {};
    pawMarkersRef.current.forEach((m) => m.remove());
    pawMarkersRef.current = [];
  }, []);

  // The above, plus revoking the thumbnail object URLs — for the unmount
  // cleanup and the pin-rebuild effect, where a fresh photo set makes the
  // old thumbnails stale.
  const clearStamps = useCallback(() => {
    clearStampMarks();
    Object.values(stampUrlsRef.current).forEach((url) =>
      URL.revokeObjectURL(url)
    );
    stampUrlsRef.current = {};
  }, [clearStampMarks]);

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

      // Pre-decode every stop's stamp thumbnail now, serialized (see
      // createStampThumbnailUrl) — the user always spends a few seconds on
      // this screen before hitting play, which is plenty of time for
      // ~250ms-each decodes to finish, so playback does no image work.
      photoIds.forEach((photoId) => {
        const photo = photos.find((p) => p.id === photoId);
        if (!photo?.file || stampUrlsRef.current[photoId]) return;
        createStampThumbnailUrl(photo.file).then((url) => {
          if (stampUrlsRef.current[photoId]) {
            URL.revokeObjectURL(url);
            return;
          }
          stampUrlsRef.current[photoId] = url;
          // If the stamp was already built (fast replay), fill its photo in.
          const img = stampMarkersRef.current[photoId]
            ?.getElement()
            .querySelector('img.trip-map-stamp-img');
          if (img && !img.getAttribute('src')) img.src = url;
        });
      });
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
            // Soft warm taupe — a "trail on the ground" read that sits
            // quietly under the pink paw prints during playback, rather
            // than the harder denim blue.
            'line-color': '#c7ac83',
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

    let torndown = false;

    // line-blur is a per-frame GPU pass, so hide the feather layers while
    // the camera is easing. Deferred a task — the 8 setLayoutProperty calls
    // each make MapLibre re-validate a layer, which doesn't need to share
    // the frame that also kicks off the first easeTo. Restored in cleanup.
    //
    // (An earlier version also toggled `text-allow-overlap` on every label
    // layer here to skip the per-camera collision pass. Profiling in Chrome
    // showed that burst — ~24 more setLayoutProperty calls — cost more than
    // the collision work it saved now that legs are short and spaced by the
    // stop dwell, so it's gone.)
    // Spread across separate frames so no one task is heavy: hide the
    // feathers, then (next frame) build the stamp markers.
    setTimeout(() => {
      if (torndown) return;
      FEATHER_LAYER_IDS.forEach((id) => {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', 'none');
        }
      });
      requestAnimationFrame(() => {
        if (torndown) return;
        for (let i = 0; i < stops.photoIds.length; i++) buildStamp(i);
        stampStop(0); // land the stamp at the starting stop
      });
    }, 0);

    // The dotted route line stays visible through playback — it reads as
    // the faint "trail on the ground" that the paw prints are stamped
    // along, then it's all that's left once the prints clear at the end.

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
    // passport — but keep the decoded thumbnails (clearStampMarks, not
    // clearStamps) so a replay does no image work either.
    clearStampMarks();

    // Stamp markers are built up front (see the deferred block above) so a
    // stop being reached is just a class flip, not a Marker insertion —
    // that was a hitch when stops sat close together. Thumbnails were
    // pre-decoded when the route was built (see the pin-build effect), so
    // no image work happens here or during playback.

    // Builds a passport-style photo stamp's DOM + Marker and adds it to the
    // map, invisible (the .trip-map-stamp-shape base style is opacity 0 /
    // scale 0.3 until the --landed class lands it). Split out from stampStop
    // so every stamp for a run can be created up front (see the warm-up
    // above), keeping the per-arrival work down to one class toggle.
    const buildStamp = (legIndex) => {
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
        const img = document.createElement('img');
        img.className = 'trip-map-stamp-img';
        img.alt = '';
        // src is filled in when the downscaled thumbnail resolves (warm-up
        // above), or lazily in stampStop if that hasn't happened yet.
        if (stampUrlsRef.current[photoId]) {
          img.src = stampUrlsRef.current[photoId];
        }
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
    };

    // "Lands" the stamp at a stop the traveler has just reached — the marker
    // already exists (buildStamp), so this is just one class flip to run the
    // CSS pop-in. Cheap enough to fire back-to-back for a cluster of stops.
    const stampStop = (legIndex) => {
      const photoId = stops.photoIds[legIndex];
      if (!photoId) return;
      if (!stampMarkersRef.current[photoId]) buildStamp(legIndex);
      const marker = stampMarkersRef.current[photoId];
      if (!marker) return;
      const el = marker.getElement();
      if (el.classList.contains('trip-map-stamp--landed')) return;
      // If the thumbnail is ready by now, use it — but never fall back to
      // decoding the full-res file here (that was the freeze). If it isn't
      // ready the stamp pops in photo-less for a beat; the pin-build
      // effect's serialized decode fills it in a moment later.
      const img = el.querySelector('img.trip-map-stamp-img');
      if (img && !img.getAttribute('src') && stampUrlsRef.current[photoId]) {
        img.src = stampUrlsRef.current[photoId];
      }
      requestAnimationFrame(() => el.classList.add('trip-map-stamp--landed'));
    };

    // A single, stable playback zoom (changing zoom mid-playback made
    // MapLibre thrash tiles across zoom levels and left the map blank).
    // Start from the zoom that fits the WHOLE arched spline — so a leg's
    // arch or a lone far-flung stop never leaves the trail off-screen while
    // the camera slides across empty map — then nudge in ~1.5 levels so a
    // tight cluster's stamps read as separate photos rather than one blob.
    // Capped by the overview zoom and 16.
    const routeBounds = new LngLatBounds();
    spline.forEach((c) => routeBounds.extend(c));
    const fitCam = map.cameraForBounds(routeBounds, { padding: 56 });
    const routeFitZoom =
      fitCam && fitCam.zoom != null
        ? fitCam.zoom
        : overviewZoomRef.current ?? map.getZoom();
    const playbackZoom = Math.min(
      routeFitZoom + 1.5,
      overviewZoomRef.current ?? 16,
      16
    );

    // Snap to stop 1 first — the overview left the camera at the framed
    // cluster's centroid (not stop 1) and maybe a different zoom, and
    // starting the first easeTo from that mismatch made the route visibly
    // slide under the view for the first ~second.
    map.jumpTo({ center: spline[0], zoom: playbackZoom });

    // --- Paw-print trail -------------------------------------------------
    // Cumulative real distance to each spline vertex, so the animation can
    // map "time elapsed" (via the leg model below) onto "distance traveled"
    // and drop a print every fixed interval of that distance.
    const splineCumKm = [0];
    for (let i = 1; i < spline.length; i++) {
      const [ax, ay] = spline[i - 1];
      const [bx, by] = spline[i];
      splineCumKm.push(
        splineCumKm[i - 1] + haversineDistanceKm(ay, ax, by, bx)
      );
    }
    const routeLengthKm = splineCumKm[splineCumKm.length - 1];

    // Target on-screen spacing → a real-world distance at the (fixed)
    // playback zoom, widened if MAX_PAWS prints couldn't otherwise span the
    // whole route.
    const centerPx = map.project(map.getCenter());
    const spanA = map.unproject([centerPx.x, centerPx.y]);
    const spanB = map.unproject([centerPx.x + PAW_SPACING_PX, centerPx.y]);
    const pawSpacingKm = Math.max(
      haversineDistanceKm(spanA.lat, spanA.lng, spanB.lat, spanB.lng),
      routeLengthKm / MAX_PAWS
    );
    let nextPawKm = pawSpacingKm * 0.5;

    // Stamps one paw print at `distKm` along the spline — rotated to the
    // route's local heading, and nudged to alternating sides of the
    // centerline for a left/right walking-trail read. The trail lives only
    // for the duration of playback (cleared in the effect cleanup).
    const dropPaw = (distKm) => {
      let lo = 0;
      let hi = splineCumKm.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (splineCumKm[mid] < distKm) lo = mid + 1;
        else hi = mid;
      }
      const i1 = Math.max(1, lo);
      const i0 = i1 - 1;
      const segKm = splineCumKm[i1] - splineCumKm[i0] || 1e-9;
      const f = Math.min(1, Math.max(0, (distKm - splineCumKm[i0]) / segKm));
      const a = spline[i0];
      const b = spline[i1];
      const lng = a[0] + (b[0] - a[0]) * f;
      const lat = a[1] + (b[1] - a[1]) * f;
      // Screen-space heading of the a→b segment (map is north-up). The paw
      // art points "up", so this angle aims its toes down the route.
      const latRad = (lat * Math.PI) / 180;
      const angleDeg =
        (Math.atan2((b[0] - a[0]) * Math.cos(latRad), b[1] - a[1]) * 180) /
        Math.PI;
      const index = pawMarkersRef.current.length;
      const el = document.createElement('div');
      el.className = 'trip-map-paw';
      el.style.setProperty('--paw-angle', `${angleDeg}deg`);
      el.style.setProperty('--paw-off', index % 2 === 0 ? '4px' : '-4px');
      const rot = document.createElement('div');
      rot.className = 'trip-map-paw-rot';
      const shape = document.createElement('div');
      shape.className = 'trip-map-paw-shape';
      shape.innerHTML = PAW_SVG;
      rot.appendChild(shape);
      el.appendChild(rot);
      const marker = new Marker({ element: el, anchor: 'center' })
        .setLngLat([lng, lat])
        .addTo(map);
      pawMarkersRef.current.push(marker);
      // Post-mount so the press-in transition actually runs (see
      // .trip-map-paw--landed) instead of starting in its end state.
      requestAnimationFrame(() => el.classList.add('trip-map-paw--landed'));
    };
    // -------------------------------------------------------------------

    // Every leg drives off the same constant real-world speed, so the
    // trail's pace never visibly changes from one leg to the next. (An
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
    // A short pause at each stop between arriving (photo stamp pops in) and
    // setting off again — playback reads as "travel → check in at the photo
    // → travel" instead of racing continuously, and a cluster of nearby
    // stops can no longer fire arrivals back-to-back. Per-stop, but the
    // total is capped so a photo-heavy trip compresses the pause rather
    // than running for a minute.
    const STOP_DWELL_MS = 900;
    const MAX_TOTAL_DWELL_MS = 6000;
    const dwellMs = Math.min(STOP_DWELL_MS, MAX_TOTAL_DWELL_MS / numLegs);

    // legMoveStart[k] = elapsed at which leg k starts *moving*. Leg k moves
    // for legDurationsMs[k], arrives at stop k+1, dwells, then leg k+1
    // starts. legMoveStart[numLegs] is the end of playback — the last
    // move's end plus one final dwell held on the last photo.
    const legMoveStart = [0];
    for (let i = 0; i < numLegs; i++) {
      legMoveStart.push(legMoveStart[i] + legDurationsMs[i] + dwellMs);
    }
    const totalDurationMs = legMoveStart[numLegs];
    // End of leg i's motion == arrival at stop i+1.
    const legMoveEnd = (i) => legMoveStart[i] + legDurationsMs[i];

    let startTime = performance.now();
    let lastFrameNow = startTime;
    let rafId;
    let currentLeg = 0;
    let arrivedStop = 0;

    // Route-strip / timeline highlight is NOT touched during playback: each
    // onSelectPhoto re-renders MapTimelineScreen (its big timeline cards
    // repaint), which profiling put at ~400-500ms — the single biggest
    // source of playback stutter. The highlight just holds wherever it was,
    // and snaps to the final photo when playback ends.

    // One easeTo per leg, fired when that leg starts moving. The stop dwell
    // spaces these out (never back-to-back), so the old short-leg merging —
    // which existed only to avoid rapid easeTo restarts for stops close
    // together in real distance — isn't needed any more.
    //
    // (Tried driving the camera by hand every frame via map.jumpTo instead
    // of easeTo: measured worse — jumpTo reprojects and repaints every
    // active layer synchronously on every call, costlier at 60/sec than the
    // per-leg easeTo restart.)
    const advanceCameraLeg = (legIndex) => {
      if (legIndex >= numLegs) return;
      map.easeTo({
        center: stops.coords[legIndex + 1],
        zoom: playbackZoom,
        duration: legDurationsMs[legIndex],
        easing: (x) => x,
      });
    };
    let cameraLeg = 0;
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

      // Arrivals: stamp each stop the instant the leg into it finishes
      // moving (before its dwell). Cheap now — buildStamp already made the
      // marker, so this is a class flip, deferred one frame off step().
      while (arrivedStop < numLegs && elapsed >= legMoveEnd(arrivedStop)) {
        arrivedStop++;
        const s = arrivedStop;
        requestAnimationFrame(() => stampStop(s));
      }

      // Camera: start the next leg's easeTo when its move window opens
      // (i.e. after the dwell at the stop it departs from).
      while (
        cameraLeg < numLegs - 1 &&
        elapsed >= legMoveStart[cameraLeg + 1]
      ) {
        cameraLeg++;
        advanceCameraLeg(cameraLeg);
      }

      // Which leg's window (its move, or the dwell right after) contains now.
      while (
        currentLeg < numLegs - 1 &&
        elapsed >= legMoveStart[currentLeg + 1]
      ) {
        currentLeg++;
      }
      const legMove = elapsed - legMoveStart[currentLeg];
      const legT = Math.max(
        0,
        Math.min(1, legMove / legDurationsMs[currentLeg])
      );

      // Paw trail: distance traveled so far → one print per spacing interval
      // crossed. legT sits at 1 through the dwell, so nothing drops while
      // paused. Sub-sample interpolation keeps the drop points smooth even
      // though a leg only has ROUTE_SAMPLES_PER_SEGMENT samples.
      const scaledLocal = legT * ROUTE_SAMPLES_PER_SEGMENT;
      const base = currentLeg * ROUTE_SAMPLES_PER_SEGMENT;
      const globalFloat = Math.min(spline.length - 1, base + scaledLocal);
      const gi0 = Math.floor(globalFloat);
      const gi1 = Math.min(spline.length - 1, gi0 + 1);
      const traveledKm =
        splineCumKm[gi0] +
        (splineCumKm[gi1] - splineCumKm[gi0]) * (globalFloat - gi0);
      while (
        nextPawKm <= traveledKm &&
        pawMarkersRef.current.length < MAX_PAWS
      ) {
        dropPaw(nextPawKm);
        nextPawKm += pawSpacingKm;
      }

      if (t >= 1) {
        onSelectPhoto?.(stops.photoIds[numLegs]);
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
      // The paw trail exists only while playback is running — clear it when
      // playback ends (or unmounts). The dotted route line was never hidden.
      torndown = true;
      pawMarkersRef.current.forEach((m) => m.remove());
      pawMarkersRef.current = [];
      FEATHER_LAYER_IDS.forEach((id) => {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', 'visible');
        }
      });
      interactionHandlers.forEach((handler) => handler.enable());
    };
  }, [routePlaying, onSelectPhoto, onRoutePlayEnd, clearStampMarks, photos]);

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
