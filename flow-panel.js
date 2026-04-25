/* ═══════════════ Flow panel (dashboard widget) ═══════════════
 * Compact Three.js scene rendered above the chip strip on both views.
 * Three ghosted cylinders point along each chip's median Δ-PC vector
 * (PC1/PC2/PC3 axes from the same robust PCA the dashboard uses).
 * Each tube is filled with glowing droplets that flow from forest-green
 * at the source to the chip's saturated post-clearing colour at the tip.
 *
 * Two modes:
 *   'fixed'    — every visible chip shows STREAM_N_MAX droplets.  Used
 *                on the globe view, where there's no map viewport.
 *   'viewport' — per-chip droplet count = round(STREAM_N_MAX × pxCount
 *                / REFERENCE_COUNT), capped at STREAM_N_MAX.  Used in
 *                tile view; pxCount comes from the same per-cluster
 *                viewport histogram that drives the timeline + 'In view'
 *                hectare readout, so year brush + before/after slider +
 *                chip toggles all flow through automatically.
 *
 * Reuses the global THREE loaded by index.html (no module import).
 * ────────────────────────────────────────────────────────────────────
 */
window.FlowPanel = (() => {
  // Palette mirrors pca_flow.html / index.html chip colours.
  const PRE_COL = [0.18, 0.55, 0.22];                  // forest green
  const POST_COL = {
    bare_soil:     [0.83, 0.45, 0.20],                 // #d47033
    canopy:        [0.85, 0.62, 0.20],                 // #d99e33
    wet_substrate: [0.078, 0.831, 0.643],              // #14d4a4 vivid teal
  };
  const STREAM_LEN = 4.0;
  const STREAM_RADIUS = 0.30;
  const STREAM_N_MAX = 180;
  // px count per chip that maps to a "full" tube in viewport mode.
  // Below this the tube fades; above it caps at STREAM_N_MAX.
  const REFERENCE_COUNT = 5e5;
  const GROUPS = ['bare_soil', 'canopy', 'wet_substrate'];

  let scene, camera, renderer, canvasEl;
  let summary = null;
  const streams = {};
  const cylinders = [];
  const axisGroup = new (window.THREE ? THREE.Group : Object)();
  let mode = 'fixed';
  let hiddenGroups = new Set();
  let viewportCounts = null;
  let phase = 0, lastT = null;
  let particleSprite = null;
  // Spherical orbit state (drag to rotate). theta=azimuth, phi=polar.
  const orbit = { theta: Math.PI * 0.30, phi: Math.PI * 0.42, dist: 7.5 };

  // Tiny canvas-text sprite for axis labels — kept compact for a 240×130
  // panel, so 18 px font + tight letter spacing.
  function makeLabelSprite(text, color = '#cfbe98') {
    const c = document.createElement('canvas'); c.width = 96; c.height = 48;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.font = "600 22px 'JetBrains Mono', monospace";
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 48, 24);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex,
      transparent: true, depthTest: false, depthWrite: false }));
    sp.scale.set(0.9, 0.45, 1);
    sp.renderOrder = 10;
    return sp;
  }

  function buildAxes() {
    while (axisGroup.children.length) {
      const c = axisGroup.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    const L = 3.0;                                       // axis half-length
    const lineMat = new THREE.LineBasicMaterial({ color: 0x6e6253,
      transparent: true, opacity: 0.55 });
    const tickMat = new THREE.LineBasicMaterial({ color: 0x8a7a60,
      transparent: true, opacity: 0.40 });
    const axes = [
      { dir: [1, 0, 0], lab: 'PC1' },
      { dir: [0, 1, 0], lab: 'PC2' },
      { dir: [0, 0, 1], lab: 'PC3' },
    ];
    for (const a of axes) {
      // Main axis line (extends to ±L).
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([
        -a.dir[0]*L, -a.dir[1]*L, -a.dir[2]*L,
         a.dir[0]*L,  a.dir[1]*L,  a.dir[2]*L,
      ], 3));
      axisGroup.add(new THREE.Line(g, lineMat));
      // Tick marks at integer steps in both directions, drawn perpendicular
      // to the axis. Picks a perpendicular vector to swing the tick from.
      const perp = (Math.abs(a.dir[1]) < 0.9) ? [0, 1, 0] : [1, 0, 0];
      const t1 = [a.dir[1]*perp[2] - a.dir[2]*perp[1],
                  a.dir[2]*perp[0] - a.dir[0]*perp[2],
                  a.dir[0]*perp[1] - a.dir[1]*perp[0]];
      const tL = 0.08;
      for (let k = -Math.floor(L); k <= Math.floor(L); k++) {
        if (k === 0) continue;
        const cx = a.dir[0]*k, cy = a.dir[1]*k, cz = a.dir[2]*k;
        const tg = new THREE.BufferGeometry();
        tg.setAttribute('position', new THREE.Float32BufferAttribute([
          cx - t1[0]*tL, cy - t1[1]*tL, cz - t1[2]*tL,
          cx + t1[0]*tL, cy + t1[1]*tL, cz + t1[2]*tL,
        ], 3));
        axisGroup.add(new THREE.Line(tg, tickMat));
      }
      // Label at the +axis tip.
      const lab = makeLabelSprite(a.lab);
      lab.position.set(a.dir[0]*(L + 0.35), a.dir[1]*(L + 0.35), a.dir[2]*(L + 0.35));
      axisGroup.add(lab);
    }
  }

  function applyCamera() {
    if (!camera) return;
    const sp = Math.sin(orbit.phi);
    camera.position.set(
      orbit.dist * sp * Math.sin(orbit.theta),
      orbit.dist * Math.cos(orbit.phi),
      orbit.dist * sp * Math.cos(orbit.theta));
    camera.lookAt(0, 0, 0);
  }

  function attachOrbit(canvas) {
    let dragging = false, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', e => {
      dragging = true; lx = e.clientX; ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      orbit.theta -= dx * 0.008;
      orbit.phi   = Math.max(0.15, Math.min(Math.PI - 0.15, orbit.phi - dy * 0.008));
      applyCamera();
    });
    const end = e => { dragging = false; canvas.style.cursor = 'grab'; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
  }

  function makeParticleSprite() {
    if (particleSprite) return particleSprite;
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0.00, 'rgba(255,255,255,1)');
    grad.addColorStop(0.40, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.70, 'rgba(255,255,255,0.25)');
    grad.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    particleSprite = new THREE.CanvasTexture(c);
    return particleSprite;
  }

  // Orthonormal basis perpendicular to an axis vector — used to
  // place particles at random radial offsets around the tube axis so
  // the flow fills the cylinder's volume.
  function perpBasis(ax) {
    const len = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    const a = [ax[0]/len, ax[1]/len, ax[2]/len];
    const helper = (Math.abs(a[1]) < 0.9) ? [0, 1, 0] : [1, 0, 0];
    const u = [a[1]*helper[2] - a[2]*helper[1],
               a[2]*helper[0] - a[0]*helper[2],
               a[0]*helper[1] - a[1]*helper[0]];
    const uL = Math.hypot(u[0], u[1], u[2]) || 1;
    u[0] /= uL; u[1] /= uL; u[2] /= uL;
    const v = [a[1]*u[2] - a[2]*u[1],
               a[2]*u[0] - a[0]*u[2],
               a[0]*u[1] - a[1]*u[0]];
    return { u, v };
  }

  // Pre-anchor: chip_summary.pre_pc.  Tip: extend along normalised
  // (post − pre) for STREAM_LEN units so all three tubes have the same
  // visual length (the *direction* is the message, not the magnitude).
  function chipEndpoints(grp) {
    const cs = summary && summary[grp];
    if (!cs) return null;
    const a = cs.pre_pc.slice();
    const dx = cs.post_pc[0] - a[0],
          dy = cs.post_pc[1] - a[1],
          dz = cs.post_pc[2] - a[2];
    const n = Math.hypot(dx, dy, dz) || 1;
    return {
      pre:  a,
      post: [a[0] + dx/n*STREAM_LEN, a[1] + dy/n*STREAM_LEN, a[2] + dz/n*STREAM_LEN],
    };
  }

  function buildCylinders() {
    for (const c of cylinders) { scene.remove(c); c.geometry.dispose(); c.material.dispose(); }
    cylinders.length = 0;
    if (!summary) return;
    for (const grp of GROUPS) {
      const ep = chipEndpoints(grp);
      if (!ep) continue;
      const a = new THREE.Vector3(...ep.pre);
      const b = new THREE.Vector3(...ep.post);
      const seg = new THREE.CylinderGeometry(STREAM_RADIUS, STREAM_RADIUS,
                                             STREAM_LEN, 24, 1, false);
      const postCol = POST_COL[grp];
      // Vertex-colour by y so base = forest green, tip = chip post colour.
      const cols = new Float32Array(seg.attributes.position.count * 3);
      for (let i = 0; i < seg.attributes.position.count; i++) {
        const y = seg.attributes.position.array[i*3+1];
        const t = (y / STREAM_LEN) + 0.5;
        cols[i*3+0] = PRE_COL[0] + t * (postCol[0] - PRE_COL[0]);
        cols[i*3+1] = PRE_COL[1] + t * (postCol[1] - PRE_COL[1]);
        cols[i*3+2] = PRE_COL[2] + t * (postCol[2] - PRE_COL[2]);
      }
      seg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true,
        transparent: true, opacity: 0.18, side: THREE.BackSide,
        depthWrite: false });
      const mesh = new THREE.Mesh(seg, mat);
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
      mesh.position.copy(mid);
      const dir = new THREE.Vector3().subVectors(b, a).normalize();
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      scene.add(mesh);
      cylinders.push(mesh);
    }
  }

  function buildStream(grp) {
    if (streams[grp]) {
      scene.remove(streams[grp].points);
      streams[grp].geom.dispose();
      streams[grp].points.material.dispose();
      delete streams[grp];
    }
    if (hiddenGroups.has(grp)) return;
    const ep = chipEndpoints(grp);
    if (!ep) return;
    const axis = [ep.post[0]-ep.pre[0], ep.post[1]-ep.pre[1], ep.post[2]-ep.pre[2]];
    const { u, v } = perpBasis(axis);
    const phase0 = new Float32Array(STREAM_N_MAX);
    const rFrac  = new Float32Array(STREAM_N_MAX);
    const angle  = new Float32Array(STREAM_N_MAX);
    for (let i = 0; i < STREAM_N_MAX; i++) {
      phase0[i] = Math.random();
      rFrac[i]  = Math.sqrt(Math.random()) * STREAM_RADIUS * 0.85;
      angle[i]  = Math.random() * Math.PI * 2;
    }
    const positions = new Float32Array(STREAM_N_MAX * 3);
    const colors    = new Float32Array(STREAM_N_MAX * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
    geom.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({
      vertexColors: true, size: 0.20, sizeAttenuation: true,
      map: makeParticleSprite(), alphaTest: 0.05,
      transparent: true, opacity: 1.0, depthWrite: false, depthTest: false,
      blending: THREE.NormalBlending,
    });
    const pts = new THREE.Points(geom, mat);
    pts.renderOrder = 6;
    scene.add(pts);
    streams[grp] = { grp, points: pts, geom, pre: ep.pre, post: ep.post,
                     u, v, phase0, rFrac, angle, activeN: 0 };
  }

  function setActiveN(grp, n) {
    const s = streams[grp];
    if (!s) return;
    n = Math.max(0, Math.min(STREAM_N_MAX, n|0));
    s.activeN = n;
    s.geom.setDrawRange(0, n);
  }

  function applyCounts() {
    for (const grp of GROUPS) {
      let n;
      if (hiddenGroups.has(grp))                       n = 0;
      else if (mode === 'fixed' || !viewportCounts)    n = STREAM_N_MAX;
      else {
        const c = viewportCounts[grp] || 0;
        n = Math.round(STREAM_N_MAX * c / REFERENCE_COUNT);
      }
      setActiveN(grp, n);
    }
  }

  function tickFlow(p) {
    for (const grp of GROUPS) {
      const s = streams[grp];
      if (!s || s.activeN === 0) continue;
      const pos = s.geom.attributes.position.array;
      const col = s.geom.attributes.color.array;
      const postCol = POST_COL[grp];
      for (let i = 0; i < s.activeN; i++) {
        const t = (p + s.phase0[i]) % 1.0;
        const cx = s.pre[0] + t * (s.post[0] - s.pre[0]);
        const cy = s.pre[1] + t * (s.post[1] - s.pre[1]);
        const cz = s.pre[2] + t * (s.post[2] - s.pre[2]);
        const a = s.angle[i] + p * Math.PI;             // gentle swirl
        const r = s.rFrac[i];
        const cosA = Math.cos(a), sinA = Math.sin(a);
        pos[i*3+0] = cx + r * (cosA * s.u[0] + sinA * s.v[0]);
        pos[i*3+1] = cy + r * (cosA * s.u[1] + sinA * s.v[1]);
        pos[i*3+2] = cz + r * (cosA * s.u[2] + sinA * s.v[2]);
        const cr = PRE_COL[0] + t * (postCol[0] - PRE_COL[0]);
        const cg = PRE_COL[1] + t * (postCol[1] - PRE_COL[1]);
        const cb = PRE_COL[2] + t * (postCol[2] - PRE_COL[2]);
        col[i*3+0] = Math.min(1, cr * 1.25 + 0.08);
        col[i*3+1] = Math.min(1, cg * 1.25 + 0.08);
        col[i*3+2] = Math.min(1, cb * 1.25 + 0.08);
      }
      s.geom.attributes.position.needsUpdate = true;
      s.geom.attributes.color.needsUpdate    = true;
    }
  }

  function animate(now) {
    requestAnimationFrame(animate);
    if (lastT == null) lastT = now;
    const dt = (now - lastT) * 0.001; lastT = now;
    phase = (phase + dt * 0.10) % 1.0;                  // ≈10 s per cycle
    tickFlow(phase);
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function fitToCanvas() {
    if (!renderer || !canvasEl) return;
    const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return {
    init(canvas) {
      canvasEl = canvas;
      const w = canvas.clientWidth || 240, h = canvas.clientHeight || 130;
      scene = new THREE.Scene();
      // Tight framing for a 240×130 panel — tubes dominate, axes still fit.
      camera = new THREE.PerspectiveCamera(45, w/h, 0.1, 100);
      applyCamera();
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(w, h, false);
      renderer.setClearColor(0x000000, 0);
      buildAxes();
      scene.add(axisGroup);
      attachOrbit(canvas);
      new ResizeObserver(fitToCanvas).observe(canvas);
      // Pull chip_summary from the JSON the standalone PCA page also uses.
      fetch('data/pca_flow_sample.json?v=' + Date.now())
        .then(r => r.json())
        .then(j => {
          summary = j.chip_summary || null;
          buildCylinders();
          for (const g of GROUPS) buildStream(g);
          applyCounts();
        })
        .catch(e => console.warn('[flow-panel] data load failed:', e));
      requestAnimationFrame(animate);
    },
    setMode(m) {
      if (m !== 'fixed' && m !== 'viewport') return;
      mode = m;
      applyCounts();
    },
    setViewportCounts(c) {
      viewportCounts = c;
      applyCounts();
    },
    setHiddenGroups(set) {
      hiddenGroups = new Set(set || []);
      for (const g of GROUPS) buildStream(g);
      applyCounts();
    },
  };
})();
