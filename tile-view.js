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
  let points = [];       // [{lon, lat, color, size, bucket, day, d}]
  let visibleFn = () => true;
  let opened = false;
  let dragging = false, lastX = 0, lastY = 0;
  let downX = 0, downY = 0, downT = 0;
  let hoverRaf = null, hoverEvt = null;
  let onHover = null;    // external callback for tooltip
  let onClick = null;
  let highlight = null;  // point to highlight

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
      const delta = -e.deltaY * 0.002;
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

    // Pilot bbox outline — draw the 10×10 km study area
    const BB = [114.0, 4.0, 114.1, 4.1]; // w,s,e,n
    const [bx0, by0] = lonLatToPixel(BB[0], BB[3]); // top-left
    const [bx1, by1] = lonLatToPixel(BB[2], BB[1]); // bottom-right
    ctx.save();
    ctx.strokeStyle = '#e7c798';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
    ctx.setLineDash([]);
    ctx.restore();

    // Detection dots — only rendered on the "after" side of the before/after
    // vertical split. window.__baSplitX is the screen X (0..1) of the handle;
    // if undefined, dots show everywhere.
    const splitFrac = (typeof window.__baSplitX === 'number') ? window.__baSplitX : 0;
    const splitPx = splitFrac * W;
    ctx.save();
    const baseR = 0.9 + Math.max(0, (zoom - 12)) * 0.28;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!visibleFn(p)) continue;
      const [sx, sy] = lonLatToPixel(p.lon, p.lat);
      if (sx < splitPx || sx > W+10 || sy < -10 || sy > H+10) continue;
      const r = Math.max(0.8, baseR * (p.size ?? 1));
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.arc(sx, sy, r + 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = p.color;
      ctx.globalAlpha = 0.92;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
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
  };
})();
