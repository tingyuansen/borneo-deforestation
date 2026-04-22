// Live-tile 2D map view for deep zoom into the pilot region.
// Uses Esri World Imagery (no API key, free for editorial/non-commercial use)
// rendered as a standard Web Mercator slippy-map: pan, wheel-zoom, and
// the deforestation dots overlaid in their true lon/lat positions.
//
// Public API:
//   TileView.open({ center:[lon,lat], zoom, points, visible })
//   TileView.close()
//   TileView.setVisible(fn)
//   TileView.isOpen()
//
// Depends on a <canvas id="tile-canvas"> already in the DOM.

(function () {
  const TILE_SIZE = 256;
  // Esri ArcGIS World Imagery — high-res satellite, no key needed.
  // Attribution (required): "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"
  const TILE_URL = z => x => y =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  // Reference/World_Boundaries_and_Places — free Esri transparent label
  // overlay (country names, cities, major rivers). Same tile grid.
  const LABEL_URL = z => x => y =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;

  // ── Web Mercator math ──────────────────────────────────────────────
  function lon2x(lon, z) { return ((lon + 180) / 360) * Math.pow(2, z) * TILE_SIZE; }
  function lat2y(lat, z) {
    const s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1+s)/(1-s)) / (4*Math.PI)) * Math.pow(2, z) * TILE_SIZE;
  }
  function x2lon(x, z) { return (x / (Math.pow(2, z) * TILE_SIZE)) * 360 - 180; }
  function y2lat(y, z) {
    const n = Math.PI - 2*Math.PI * y / (Math.pow(2, z) * TILE_SIZE);
    return 180/Math.PI * Math.atan(0.5*(Math.exp(n) - Math.exp(-n)));
  }

  // ── Tile cache (one global LRU) ────────────────────────────────────
  const tileCache = new Map();
  const MAX_CACHE = 200;
  function getTile(z, x, y, onReady) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) {
      const e = tileCache.get(key);
      // bump recency
      tileCache.delete(key); tileCache.set(key, e);
      return e.img;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const entry = { img, loaded: false };
    tileCache.set(key, entry);
    if (tileCache.size > MAX_CACHE) {
      const oldest = tileCache.keys().next().value;
      tileCache.delete(oldest);
    }
    img.onload = () => { entry.loaded = true; if (onReady) onReady(); };
    img.onerror = () => { entry.failed = true; };
    img.src = TILE_URL(z)(x)(y);
    return null;
  }

  // ── The view ───────────────────────────────────────────────────────
  let canvas, ctx, container, W, H, dpr;
  let center = [0, 0];   // lon, lat
  let zoom = 3;          // continuous, 3..18
  let points = [];       // hex-aggregate points [{lon, lat, color, size, bucket, ...}]
  let visibleFn = () => true;
  let opened = false;
  let dragging = false, lastX = 0, lastY = 0;
  let downX = 0, downY = 0, downT = 0;
  let hoverRaf = null, hoverEvt = null;
  let onHover = null;    // external callback for tooltip
  let onClick = null;
  let highlight = null;  // point to highlight

  // ── Per-tile pixel streaming ──────────────────────────────────────
  // Why this exists: the full 2-of-3 detection set is ~2 GB. Loading it all
  // up front would stall the page and blow mobile memory. We chunk it into
  // 0.1° × 0.1° binary tiles (see 22_chunk_tiles.py) and fetch only the
  // tiles that intersect the current viewport, above a zoom threshold where
  // per-pixel detail makes sense. Below that threshold we fall back to
  // the H3 hex aggregate (rendered from `points`).
  const TILE_BIN_DEG    = 0.1;                  // matches 22_chunk_tiles.py
  const TILE_GRID_COLS  = 65;                   // Sarawak bbox widths
  const TILE_GRID_ROWS  = 42;
  const TILE_LON_MIN    = 109.5;
  const TILE_LAT_MIN    =   0.8;
  // Zoom threshold: at zoom < this we render the hex aggregate; at ≥ this
  // we render per-pixel dots from .bin tiles. Set to 13 so any nontrivial
  // zoom-out from the fly-in (which opens at zoom 13.2) flips back to the
  // hex layer — below ~12, the viewport spans dozens of tiles × ~200K
  // points and the tab freezes.
  const LOD_ZOOM_SWITCH = 13;
  const BIN_MAX_CACHE   = 48;                   // LRU budget (~48 × ~1 MB)
  const BIN_BASE        = 'data/tiles/2of3/';
  let   binManifest     = null;                 // { tiles: { iy_ix: {...} } }
  const binCache        = new Map();            // key → { dx, dy, yr, n, lonMin, latMin }
  const binFetching     = new Set();

  function loadBinManifest() {
    if (binManifest || loadBinManifest._pending) return loadBinManifest._pending;
    loadBinManifest._pending = fetch(BIN_BASE + 'manifest.json')
      .then(r => r.ok ? r.json() : null)
      .then(m => { binManifest = m; draw(); return m; })
      .catch(e => { console.warn('[tile-bin] manifest failed', e); return null; });
    return loadBinManifest._pending;
  }

  function fetchBinTile(iy, ix) {
    const key = `iy${iy}_ix${ix}`;
    if (binCache.has(key)) {
      // LRU bump
      const e = binCache.get(key); binCache.delete(key); binCache.set(key, e);
      return e;
    }
    if (binFetching.has(key)) return null;
    if (!binManifest || !binManifest.tiles || !binManifest.tiles[key]) return null;
    binFetching.add(key);
    fetch(`${BIN_BASE}tile_${key}.bin`)
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject('http ' + r.status))
      .then(buf => {
        const dv = new DataView(buf);
        const n      = dv.getUint32(0, true);
        const lonMin = dv.getFloat32(4, true);
        const latMin = dv.getFloat32(8, true);
        // 6 bytes/pixel in segments: dx u16 | dy u16 | yr u8 | cl u8.
        // cl = HDBSCAN cluster id (0..18) or 255 for outlier (from
        // 10_chunk_labeled_tiles.py). Reserved id lets us distinguish
        // real clusters from "propagation noise" in the browser.
        const off = 12;
        const dx = new Uint16Array(buf, off,          n);
        const dy = new Uint16Array(buf, off + 2*n,    n);
        const yr = new Uint8Array (buf, off + 4*n,    n);
        const cl = new Uint8Array (buf, off + 5*n,    n);
        binCache.set(key, { n, lonMin, latMin, dx, dy, yr, cl });
        while (binCache.size > BIN_MAX_CACHE) {
          const oldest = binCache.keys().next().value;
          binCache.delete(oldest);
        }
        binFetching.delete(key);
        draw();
      })
      .catch(e => { binFetching.delete(key); console.warn('[tile-bin] fetch failed', key, e); });
    return null;
  }

  // Per-year × per-cluster count of deforest pixels in the current
  // viewport. Two paths, switched at the same zoom threshold as the
  // render:
  //   zoom ≥ PIXEL_SWITCH → iterate the in-cache .bin tiles at stride 16
  //                         (dense, accurate when the 48-tile LRU covers
  //                         the viewport — which it does at close zoom)
  //   zoom <  PIXEL_SWITCH → sum hex.deforest_n across viewport-intersecting
  //                         hexes. The .bin path undercounts badly when
  //                         zoomed out across Sarawak (2000+ tiles in
  //                         view, only 48 cached → ~2% coverage), so we
  //                         fall back to the already-loaded hex aggregate
  //                         which is exact for the total.
  const HIST_PIXEL_SWITCH = 12;   // mirror PIXEL_SWITCH in _draw()
  const HIST_HEX_FINE_SWITCH = 10;
  const HIST_HIDDEN = new Set([2, 3, 11, 12, 13, 15, 16]);
  const HIST_SUSPECT = new Set([1, 4, 8, 9, 14, 18]);
  function buildViewportYearHist() {
    const CM = window.CLUSTER_META;
    if (!CM || !CM.clusters) return null;
    const tagOf = (cid) => cid === 255 ? 'outlier'
      : (CM.clusters[cid] && CM.clusters[cid].tag) || 'mixed';
    const hist = {};
    for (let y = 2015; y <= 2024; y++) hist[y] = {};
    const splitFrac = (typeof window.__baSplitX === 'number') ? window.__baSplitX : 0;
    const cx = lon2x(center[0], zoom), cy = lat2y(center[1], zoom);
    const halfW = W/2, halfH = H/2;
    const splitPx = splitFrac * W;
    const ul = pixelToLonLat(0, 0), br = pixelToLonLat(W, H);
    const lon0 = Math.min(ul[0], br[0]), lon1 = Math.max(ul[0], br[0]);
    const lat0 = Math.min(ul[1], br[1]), lat1 = Math.max(ul[1], br[1]);

    // Chip state (suspectHidden, hiddenClusters) is NOT applied here —
    // the stacked histogram needs the full per-group totals so its
    // y-scale stays stable; renderBars then hides toggled-off groups
    // via a `visibility` attr. Filtering here caused the "bars get
    // fatter on toggle" issue since yMax would fall when a group's
    // contribution vanished.
    const keepCid = (cid) => {
      if (cid === 255) return false;
      if (HIST_HIDDEN.has(cid)) return false;
      return tagOf(cid) === 'deforest';
    };

    if (zoom < HIST_PIXEL_SWITCH) {
      // Hex aggregate path. Each hex carries deforest_n (exact) and a
      // dominant cluster_id. Year is the hex-level median so the stack's
      // time axis is smeared for hexes that span multiple years, but the
      // TOTAL (what drives the "In view" hectare readout) is exact.
      const fine = window.SARAWAK_HEXES_FINE;
      const useFine = zoom >= HIST_HEX_FINE_SWITCH && fine && fine.length;
      const OCEAN_HEX = new Set([2, 11, 12, 15, 16]);
      let src;
      if (useFine) {
        src = [];
        for (const h of fine) {
          if (h.tag !== 'deforest') continue;
          if (OCEAN_HEX.has(h.cluster_id)) continue;
          if (h.elev_m != null && h.elev_m < 3) continue;
          src.push(h);
        }
      } else {
        src = points;
      }
      for (let i = 0; i < src.length; i++) {
        const h = src[i];
        if (h.lon < lon0 || h.lon > lon1) continue;
        if (h.lat < lat0 || h.lat > lat1) continue;
        const cid = h.cluster_id;
        if (cid == null || !keepCid(cid)) continue;
        if (splitPx > 0) {
          const sx = lon2x(h.lon, zoom) - cx + halfW;
          if (sx < splitPx) continue;
        }
        const year = h.y;
        if (hist[year] == null) continue;
        // `points` carries h.n from the globe builder (total, but hex
        // is deforest-dominant so ≈ deforest_n); raw fine hexes have
        // deforest_n separately — prefer it when present for accuracy.
        const nDef = h.deforest_n != null ? h.deforest_n : h.n;
        const key = 'c' + cid;
        hist[year][key] = (hist[year][key] || 0) + nDef;
      }
      return hist;
    }

    if (!binManifest) return null;
    const tileInvScale = TILE_BIN_DEG / 65535;
    const stride = 16;
    for (const [iy, ix] of visibleBinTiles()) {
      const tile = fetchBinTile(iy, ix);
      if (!tile) continue;
      const { n, lonMin, latMin, dx, dy, yr, cl } = tile;
      for (let i = 0; i < n; i += stride) {
        const cid = cl[i];
        if (!keepCid(cid)) continue;
        const lon = lonMin + dx[i] * tileInvScale;
        if (lon < lon0 || lon > lon1) continue;
        const lat = latMin + dy[i] * tileInvScale;
        if (lat < lat0 || lat > lat1) continue;
        if (splitPx > 0) {
          const sx = lon2x(lon, zoom) - cx + halfW;
          if (sx < splitPx) continue;
        }
        const year = 2015 + yr[i];
        if (!hist[year]) continue;
        const key = 'c' + cid;
        hist[year][key] = (hist[year][key] || 0) + stride;
      }
    }
    return hist;
  }

  // Debounce + "wait for tile fetches to settle". Pushing a partial
  // viewport hist while tiles are still streaming causes the histogram
  // to flash: small count replaces big global, then grows as more tiles
  // land. So we skip any update while binFetching is non-empty; a
  // subsequent draw() (fired on each fetch.then) will re-trigger.
  function _pushViewportHist() {
    if (!window._refreshViewportHist) return;
    const hist = buildViewportYearHist();
    if (!hist) { window._refreshViewportHist(null); return; }
    let tot = 0;
    for (const y in hist) {
      for (const k in hist[y]) tot += hist[y][k];
    }
    window._refreshViewportHist(tot > 0 ? hist : null);
  }
  let _vpHistTimer = null;
  function notifyViewportHist() {
    if (_vpHistTimer) clearTimeout(_vpHistTimer);
    _vpHistTimer = setTimeout(() => {
      _vpHistTimer = null;
      if (binFetching.size > 0) return;      // come back after the fetches
      _pushViewportHist();
    }, 500);
  }
  // Exposed for slider/brush updates that want the histogram to track
  // their drag live — the 500ms pan-debounce would feel laggy for those.
  window._refreshViewportHistNow = _pushViewportHist;

  // Which 0.1° tiles intersect the current viewport? Returns list of [iy, ix].
  function visibleBinTiles() {
    // Compute viewport lon/lat corners.
    const ul = pixelToLonLat(0, 0);
    const br = pixelToLonLat(W, H);
    // Buffer one tile around the viewport so panning fetches neighbours early.
    const lon0 = Math.min(ul[0], br[0]) - TILE_BIN_DEG;
    const lon1 = Math.max(ul[0], br[0]) + TILE_BIN_DEG;
    const lat0 = Math.min(ul[1], br[1]) - TILE_BIN_DEG;
    const lat1 = Math.max(ul[1], br[1]) + TILE_BIN_DEG;
    const ix0 = Math.max(0, Math.floor((lon0 - TILE_LON_MIN) / TILE_BIN_DEG));
    const ix1 = Math.min(TILE_GRID_COLS - 1, Math.floor((lon1 - TILE_LON_MIN) / TILE_BIN_DEG));
    const iy0 = Math.max(0, Math.floor((lat0 - TILE_LAT_MIN) / TILE_BIN_DEG));
    const iy1 = Math.min(TILE_GRID_ROWS - 1, Math.floor((lat1 - TILE_LAT_MIN) / TILE_BIN_DEG));
    const out = [];
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) out.push([iy, ix]);
    }
    return out;
  }

  function setup() {
    canvas = document.getElementById('tile-canvas');
    container = document.getElementById('tile-view');
    ctx = canvas.getContext('2d');

    canvas.addEventListener('pointerdown', e => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      downX = e.clientX; downY = e.clientY; downT = performance.now();
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', e => {
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
      // Click if the pointer barely moved from the down position and wasn't held long.
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      const held = performance.now() - downT;
      if (moved < 4 && held < 400) {
        const p = pick(e.clientX, e.clientY);
        if (onClick) onClick(p, e);
      }
    });
    canvas.addEventListener('pointermove', e => {
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        const s = Math.pow(2, zoom) * TILE_SIZE;
        center[0] -= (dx / s) * 360;
        center[1] = y2lat(lat2y(center[1], zoom) - dy, zoom);
        // Clamp
        center[0] = Math.max(-180, Math.min(180, center[0]));
        center[1] = Math.max(-85, Math.min(85, center[1]));
        draw();
      } else {
        // Throttle hover picks — the 47k-point scan shouldn't run every
        // mousemove event (60+ Hz on high-refresh displays). One RAF is plenty.
        if (hoverRaf) return;
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = null;
          const p = pick(hoverEvt.clientX, hoverEvt.clientY);
          if (onHover) onHover(p, hoverEvt);
        });
        hoverEvt = e;
      }
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      // Zoom about the mouse: compute lonlat under mouse, change zoom, re-center.
      const lonBefore = pixelToLonLat(mx, my);
      // Pinch gestures on macOS trackpads emit small deltaY values (and
      // ctrlKey=true). Bump sensitivity for those; regular wheel events
      // get the normal rate so it doesn't feel like the view is fleeing.
      const rate = e.ctrlKey ? 0.012 : 0.005;
      const delta = -e.deltaY * rate;
      zoom = Math.max(3, Math.min(18, zoom + delta));
      const lonAfter = pixelToLonLat(mx, my);
      center[0] += lonBefore[0] - lonAfter[0];
      center[1] += lonBefore[1] - lonAfter[1];
      draw();
    }, { passive: false });

    window.addEventListener('resize', () => { if (opened) { resize(); draw(); } });
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Convert screen pixel → lon/lat at current zoom
  function pixelToLonLat(px, py) {
    const cx = lon2x(center[0], zoom), cy = lat2y(center[1], zoom);
    const wx = cx + (px - W/2);
    const wy = cy + (py - H/2);
    return [x2lon(wx, zoom), y2lat(wy, zoom)];
  }
  function lonLatToPixel(lon, lat) {
    const cx = lon2x(center[0], zoom), cy = lat2y(center[1], zoom);
    const wx = lon2x(lon, zoom), wy = lat2y(lat, zoom);
    return [wx - cx + W/2, wy - cy + H/2];
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    // Cache center-world coords once per pick.
    const cx = lon2x(center[0], zoom), cy = lat2y(center[1], zoom);
    const halfW = W/2, halfH = H/2;
    let best = null, bestD = 100; // px^2
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!visibleFn(p)) continue;
      const sx = lon2x(p.lon, zoom) - cx + halfW;
      const sy = lat2y(p.lat, zoom) - cy + halfH;
      // Quick on-screen cull
      if (sx < -20 || sx > W+20 || sy < -20 || sy > H+20) continue;
      const dx = sx - mx, dy = sy - my;
      const dd = dx*dx + dy*dy;
      if (dd < bestD) { bestD = dd; best = p; }
    }
    return best;
  }

  // ── Render ─────────────────────────────────────────────────────────
  let drawPending = false;
  function draw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => {
      drawPending = false;
      _draw();
    });
  }
  function _draw() {
    ctx.clearRect(0, 0, W, H);

    // Integer zoom level for tiles (use floor; fractional zoom = scale)
    const zInt = Math.floor(zoom);
    const scale = Math.pow(2, zoom - zInt);

    const s = Math.pow(2, zInt) * TILE_SIZE;
    const cx = ((center[0] + 180) / 360) * s;
    const sLat = Math.sin(center[1] * Math.PI / 180);
    const cy = (0.5 - Math.log((1+sLat)/(1-sLat)) / (4*Math.PI)) * s;

    // Visible tile range
    const halfW = W / (2 * scale), halfH = H / (2 * scale);
    const x0 = cx - halfW, x1 = cx + halfW;
    const y0 = cy - halfH, y1 = cy + halfH;
    const tx0 = Math.floor(x0 / TILE_SIZE), tx1 = Math.floor(x1 / TILE_SIZE);
    const ty0 = Math.floor(y0 / TILE_SIZE), ty1 = Math.floor(y1 / TILE_SIZE);

    const nTiles = Math.pow(2, zInt);
    // Draw tiles
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= nTiles) continue;
      for (let tx = tx0; tx <= tx1; tx++) {
        const tw = ((tx % nTiles) + nTiles) % nTiles;
        const img = getTile(zInt, tw, ty, () => draw());
        const sx = (tx * TILE_SIZE - cx) * scale + W/2;
        const sy = (ty * TILE_SIZE - cy) * scale + H/2;
        const sz = TILE_SIZE * scale;
        if (img && img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, sx, sy, sz, sz);
        } else {
          // Placeholder while loading
          ctx.fillStyle = '#1a1410';
          ctx.fillRect(sx, sy, sz, sz);
        }
      }
    }

    // Three-tier LOD in the tile view. Tuned so the transitions show up
    // across the common zoom range (8 → 14) the user sweeps through:
    //   zoom <  10 → coarse hexes (res 7, ~5 km hexes)
    //   10 ≤ zoom < 12 → fine hexes (res 8, ~1.8 km hexes, lazy-loaded)
    //   zoom ≥ 12 → labelled per-pixel dots (1 MB, lazy-loaded)
    const HEX_FINE_SWITCH = 10;
    const PIXEL_SWITCH    = 12;
    const splitFrac = (typeof window.__baSplitX === 'number') ? window.__baSplitX : 0;
    const splitPx = splitFrac * W;
    ctx.save();
    if (splitPx > 0) {
      ctx.beginPath();
      ctx.rect(splitPx, 0, W - splitPx, H);
      ctx.clip();
    }

    // Per-cluster colour — the palette in CLUSTER_META is built in
    // 07_labeled_webviz.py: within each tag, shades are rank-assigned by
    // cluster size (deforest: crimson → tan ramp; regrowth: deep green →
    // yellow). Keeping the variation because different spectral regimes
    // within "deforestation" represent different physical events
    // (clear-cut vs. gradual degradation vs. palm-oil establishment).
    // The chip swatch shows the dominant shade; the viz shows the full
    // ramp so the user can see the sub-structure.
    const CM = window.CLUSTER_META;
    const colorOfCluster = (cid) => {
      if (CM && CM.clusters && CM.clusters[cid]) return CM.clusters[cid].color;
      return '#8a7a60';
    };
    const tagOfCluster = (cid) => {
      if (CM && CM.clusters && CM.clusters[cid]) return CM.clusters[cid].tag;
      return 'mixed';
    };
    // Hidden by cluster-id. Identified empirically via
    // scripts/15_cluster_elev_audit (per-cluster elevation + slope
    // distribution) — see sarawak/README.md §Known issues:
    //   c2, c12, c15  tagged regrowth but sit at negative elevation
    //                 (tidal flats / sun-glint in the sea)
    //   c11, c16      tagged water_ward, also at sea level
    //   c1, c9, c14   tagged deforest but median elev > 300 m, slope-p95
    //                 above 25° → topographic-illumination false
    //                 positives, not real canopy loss
    // Both groups go away on the final pipeline rerun (topo correction
    // + stratified HDBSCAN); the hide-list is a V1 cleanup patch.
    // Two tiers of exclusion:
    //   HIDDEN  — never shown (ocean artefacts + coastal-regrowth).
    //             These are legitimately off-map / noise.
    //   SUSPECT — rendered pale yellow and gated by the 'suspect' chip.
    //             Mountain-cohort clusters whose deforest signal is
    //             likely topographic-illumination artefact; user can
    //             toggle visibility.
    const HIDDEN_CLUSTERS  = new Set([2, 3, 11, 12, 13, 15, 16]);
    const SUSPECT_CLUSTERS = new Set([1, 4, 8, 9, 14, 18]);
    const PALE_YELLOW = '#e8d9b8';
    const suspectHidden = window._state
      && window._state.hiddenGroups && window._state.hiddenGroups.has('suspect');

    if (zoom >= PIXEL_SWITCH) {
      // ── Per-pixel labelled layer — stream .bin tiles on demand ──────
      // Each tile has 6 B/pixel (dx, dy, yr, cl). cl = HDBSCAN cluster id
      // propagated to the full 643M set (see 08_propagate_labels.py +
      // 10_chunk_labeled_tiles.py). Outliers carry cl=255 and render in
      // a neutral shade so their spatial context is still visible.
      loadBinManifest();
      const hiddenTags = window._state && window._state.hiddenCats;
      const cx = lon2x(center[0], zoom), cy = lat2y(center[1], zoom);
      const halfW = W/2, halfH = H/2;
      const r = zoom < 14 ? 1.1 : zoom < 16 ? 1.6 : 2.2;
      const tileInvScale = TILE_BIN_DEG / 65535;
      // Stride keeps the per-frame dot budget bounded. At zoom 12 the
      // viewport spans ~15 tiles × ~250K pixels; drawing every 20th keeps
      // the frame under ~200K arcs. Scales to stride=1 (every pixel) at
      // close zoom where the viewport shrinks.
      const stride =
        zoom >= 16 ? 1 :
        zoom >= 15 ? 2 :
        zoom >= 14 ? 4 :
        zoom >= 13 ? 8 :
                     16;
      // Year filter (applied through window._state.yearRange by the brush).
      const yr0 = (window._state && window._state.yearRange && window._state.yearRange[0]) || 2015;
      const yr1 = (window._state && window._state.yearRange && window._state.yearRange[1]) || 2024;
      const yrLoRel = Math.max(0, yr0 - 2015);
      const yrHiRel = Math.min(15, yr1 - 2015);
      for (const [iy, ix] of visibleBinTiles()) {
        const tile = fetchBinTile(iy, ix);
        if (!tile) continue;
        const { n, lonMin, latMin, dx, dy, yr, cl } = tile;
        const hiddenClusters = window._hiddenClusters;
        for (let i = 0; i < n; i += stride) {
          const cid = cl[i];
          if (cid === 255) continue;                 // propagation outlier
          if (HIDDEN_CLUSTERS.has(cid)) continue;     // ocean + coastal regrowth
          const isSuspect = SUSPECT_CLUSTERS.has(cid);
          if (isSuspect && suspectHidden) continue;
          const tag = tagOfCluster(cid);
          if (tag === 'mixed') continue;
          if (hiddenClusters && hiddenClusters.has(cid)) continue;
          if (yr[i] < yrLoRel || yr[i] > yrHiRel) continue;
          const lon = lonMin + dx[i] * tileInvScale;
          const lat = latMin + dy[i] * tileInvScale;
          const sx = lon2x(lon, zoom) - cx + halfW;
          const sy = lat2y(lat, zoom) - cy + halfH;
          if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
          ctx.fillStyle = isSuspect ? PALE_YELLOW : colorOfCluster(cid);
          ctx.globalAlpha = isSuspect ? 0.4 : 0.82;
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    } else {
      // ── Hex layer (coarse or fine depending on zoom) ────────────────
      // Both coarse and fine arrive pre-classified (11_rebuild_labeled_hexes.py):
      // per-hex `tag` from the full 643M map. We filter to deforest-dominant
      // hexes so the layer stays semantically "this is where canopy was lost"
      // rather than a generic change-heatmap.
      const hasH3 = typeof window.h3 !== 'undefined';
      const useFine = zoom >= HEX_FINE_SWITCH;
      if (useFine && window._ensureFineHexes) window._ensureFineHexes();
      const fine = window.SARAWAK_HEXES_FINE;
      let hexSource;
      let rankFn;
      if (useFine && fine && fine.length) {
        const OCEAN    = new Set([2, 11, 12, 15, 16]);
        const MOUNTAIN = new Set([1, 4, 8, 9, 14, 18]);
        // Match buildPoints' land-only deforest filter so the coarse and
        // fine hex layers show the same set of hexes — no ocean blanket
        // at the coast when the user zooms in. `tag === 'empty'` hexes
        // (added by the pipeline's full-grid backdrop pass) are kept
        // too; the colored pass below filters them out so they only
        // show as pale-yellow footprints.
        const keptFine = fine.filter(h =>
          (h.tag === 'deforest' || h.tag === 'empty')
          && !OCEAN.has(h.cluster_id)
          && (h.elev_m == null || h.elev_m >= 3)
        );
        const sorted = [...keptFine].sort((a, b) => a.n - b.n);
        const rankOf = new Map();
        const denom = Math.max(1, sorted.length - 1);
        for (let i = 0; i < sorted.length; i++) rankOf.set(sorted[i], i / denom);
        hexSource = keptFine;
        rankFn = (h) => rankOf.get(h);
      } else {
        // `points` is already filtered to deforest + carries _rankT.
        hexSource = points;
        rankFn = (p) => (p._rankT ?? 0.5);
      }
      const hexDensityColor = window.hexDensityColor || ((t) => '#c67b2f');
      const yr0 = (window._state && window._state.yearRange && window._state.yearRange[0]) || 2015;
      const yr1 = (window._state && window._state.yearRange && window._state.yearRange[1]) || 2024;
      const BACKDROP_COLOR = '#e8d9b8';   // PALE_YELLOW
      // Two-pass render: first a year-agnostic pale-yellow backdrop so the
      // hex grid is always visible, then the year-filtered colored paint
      // on top. When the user plays the timeline, only the colored layer
      // appears/vanishes — the hex footprint itself stays put, which is
      // what the user expects visually ("map, then dots light up").
      // Cache each hex's projected polygon per-frame so the second pass
      // doesn't re-project.
      const hexPolys = [];
      for (let i = 0; i < hexSource.length; i++) {
        const p = hexSource[i];
        const [sx, sy] = lonLatToPixel(p.lon, p.lat);
        if (sx < -200 || sx > W+200 || sy < -200 || sy > H+200) continue;
        if (!(hasH3 && p.h3)) continue;
        const verts = window.h3.cellToBoundary(p.h3);
        const poly = new Array(verts.length);
        for (let j = 0; j < verts.length; j++) {
          const [vlat, vlon] = verts[j];
          poly[j] = lonLatToPixel(vlon, vlat);
        }
        hexPolys.push({ p, poly });
      }
      const drawPoly = (poly) => {
        ctx.beginPath();
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (let j = 1; j < poly.length; j++) ctx.lineTo(poly[j][0], poly[j][1]);
        ctx.closePath();
      };
      // Pass 1 — pale-yellow backdrop (no year filter).
      ctx.fillStyle = BACKDROP_COLOR;
      ctx.strokeStyle = BACKDROP_COLOR;
      ctx.lineWidth = 0.5;
      ctx.globalAlpha = 0.18;
      for (const { poly } of hexPolys) { drawPoly(poly); ctx.fill(); }
      ctx.globalAlpha = 0.32;
      for (const { poly } of hexPolys) { drawPoly(poly); ctx.stroke(); }
      ctx.globalAlpha = 1;
      // Pass 2 — year-filtered colored paint on top. Skip 'empty' hexes
      // (backdrop-only) and year-out-of-range hexes.
      for (const { p, poly } of hexPolys) {
        if (p.tag === 'empty') continue;
        if (p.y != null && (p.y < yr0 || p.y > yr1)) continue;
        const t = rankFn(p);
        const color = p.color || hexDensityColor(t);
        const a = p.alpha ?? (0.45 + 0.4 * t);
        drawPoly(poly);
        ctx.fillStyle = color;
        ctx.globalAlpha = a * 0.45;
        ctx.fill();
        ctx.globalAlpha = Math.min(0.95, a + 0.15);
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // Highlight
    if (highlight) {
      const [sx, sy] = lonLatToPixel(highlight.lon, highlight.lat);
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Attribution (required by Esri)
    ctx.save();
    ctx.fillStyle = 'rgba(12,9,6,0.7)';
    const attr = 'Imagery: Esri, Maxar, Earthstar Geographics';
    ctx.font = '10px "JetBrains Mono", monospace';
    const tw = ctx.measureText(attr).width;
    ctx.fillRect(W - tw - 14, H - 20, tw + 12, 16);
    ctx.fillStyle = 'rgba(244,237,225,0.65)';
    ctx.fillText(attr, W - tw - 8, H - 8);
    ctx.restore();

    // Coord readout (optional — element may not be present)
    const cv = document.getElementById('tile-coord-val');
    if (cv) {
      cv.textContent = `${Math.abs(center[1]).toFixed(4)}°${center[1]>=0?'N':'S'} · ${Math.abs(center[0]).toFixed(4)}°${center[0]>=0?'E':'W'}  ·  z${zoom.toFixed(1)}`;
    }

    // Debounced push of viewport counts to the histogram.
    notifyViewportHist();
  }

  // ── Public ─────────────────────────────────────────────────────────
  window.TileView = {
    init() { setup(); },
    open(opts) {
      if (!canvas) setup();
      center = [opts.center[0], opts.center[1]];
      zoom = opts.zoom ?? 13;
      points = opts.points ?? [];
      visibleFn = opts.visible ?? (()=>true);
      onHover = opts.onHover ?? null;
      onClick = opts.onClick ?? null;
      container.classList.remove('hidden');
      opened = true;
      resize();
      draw();
    },
    close() {
      if (!container) return;
      container.classList.add('hidden');
      opened = false;
    },
    setVisible(fn) { visibleFn = fn; draw(); },
    setPoints(arr) { points = arr; draw(); },
    setHighlight(p) { highlight = p; draw(); },
    isOpen: () => opened,
    refresh: () => draw(),
    // Programmatic pan — dx/dy in screen pixels. Positive dx moves the view
    // right (i.e. the map content shifts left); positive dy moves it down.
    pan(dx, dy) {
      const s = Math.pow(2, zoom) * TILE_SIZE;
      center[0] += (dx / s) * 360;
      center[1] = y2lat(lat2y(center[1], zoom) + dy, zoom);
      center[0] = Math.max(-180, Math.min(180, center[0]));
      center[1] = Math.max(-85, Math.min(85, center[1]));
      draw();
    },
    zoomBy(delta) {
      zoom = Math.max(3, Math.min(18, zoom + delta));
      draw();
    },
  };
})();
