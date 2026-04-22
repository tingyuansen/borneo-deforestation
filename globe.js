// Interactive globe: real Earth texture, orbit controls, and deforestation
// detections rendered as dots directly on the sphere surface.
//
// Public API:
//   const g = Globe.init(container, { onReady });
//   g.setPoints(points)       // [{lon, lat, color, day, bucket, ...}]
//   g.setVisibility(fn)       // predicate: point => boolean
//   g.flyTo(lon, lat, alt)    // animate camera
//   g.setAutoRotate(on)
//
// Uses NASA Blue Marble texture via unpkg CDN. Lightweight OrbitControls.

(function () {
  const R = 1.0;                 // sphere radius (world units)
  const POINT_R = R * 1.0015;    // points sit just above surface

  function llToVec(lon, lat, r) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lon + 180) * Math.PI / 180;
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
       r * Math.cos(phi),
       r * Math.sin(phi) * Math.sin(theta)
    );
  }
  const easeInOut = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3) / 2;

  // Minimal orbit controls: left-drag rotates, wheel zooms, right-drag pans disabled.
  // Camera orbits a fixed target (origin) at distance `dist`, using spherical
  // coords (theta, phi). Enforces min/max distance so user can't go inside the
  // sphere.
  function makeOrbitControls(camera, dom, opts) {
    const state = {
      theta: 0,                     // azimuthal (Y axis rotation)
      phi:   Math.PI / 2,           // polar (from +Y)
      dist:  opts.initialDist ?? 3.2,
      // 1.0 = sphere surface. The camera can't usefully zoom below ~1.05
      // because texture/geometry resolution can't resolve single tiles;
      // past that point the app swaps to a dedicated 2D tile view.
      minDist: opts.minDist ?? 1.05,
      maxDist: opts.maxDist ?? 6.0,
      autoRotate: false,            // static until the user triggers flyTo.
                                    // Decorative spinning was getting mistaken
                                    // for an in-progress response to clicks.
      autoSpeed: 0.04,              // rad/sec
    };
    let onChangeCB = null;
    function apply() {
      const x = state.dist * Math.sin(state.phi) * Math.sin(state.theta);
      const y = state.dist * Math.cos(state.phi);
      const z = state.dist * Math.sin(state.phi) * Math.cos(state.theta);
      camera.position.set(x, y, z);
      camera.lookAt(0, 0, 0);
      if (onChangeCB) onChangeCB();
    }
    apply();

    // Drag-to-rotate is intentionally disabled on the main globe view —
    // the UX was ambiguous (click vs drag vs pointer-capture stealing
    // focus from HUD buttons). Any left-click on the globe is now the
    // "fly in" gesture instead; users reach the tile view either by
    // clicking the globe (handler wired in index.html), clicking the
    // Fly button, or wheel-zooming close enough to trigger the auto
    // tile-view threshold. Auto-rotate still animates idly so the globe
    // doesn't look static.
    dom.style.cursor = 'pointer';
    dom.addEventListener('wheel', e => {
      e.preventDefault();
      const scale = Math.exp(e.deltaY * 0.0015);
      // Zoom by distance-above-surface rather than raw distance so the wheel
      // keeps biting all the way down to the tile.
      const above = Math.max(state.minDist - 1.0, state.dist - 1.0);
      const newAbove = Math.max(state.minDist - 1.0, Math.min(state.maxDist - 1.0, above * scale));
      state.dist = 1.0 + newAbove;
      state.autoRotate = false;
      apply();
    }, { passive: false });
    dom.style.cursor = 'grab';

    function tick(dt) {
      let moved = false;
      if (state.autoRotate) { state.theta -= state.autoSpeed * dt; apply(); moved = true; }
      return moved;
    }
    function flyTo(lon, lat, dist, duration = 1800) {
      return new Promise(res => {
        // Target theta/phi so that llToVec(lon,lat) is on +Z side of camera
        // (i.e. lies along the view direction). Easier: solve for theta/phi
        // such that camera.position points to the given ll.
        // Camera is at (dist*sin(phi)*sin(theta), dist*cos(phi), dist*sin(phi)*cos(theta))
        // We want this to align with llToVec(lon,lat,1).
        const v = llToVec(lon, lat, 1);
        const targetPhi = Math.acos(v.y);
        const targetTheta = Math.atan2(v.x, v.z);
        const d0 = state.dist, t0 = state.theta, p0 = state.phi;
        // Unwrap theta so we take the short way around
        let dt_theta = targetTheta - t0;
        dt_theta = ((dt_theta + Math.PI) % (2*Math.PI)) - Math.PI;
        const dt_phi = targetPhi - p0;
        const dt_dist = (dist ?? d0) - d0;
        const start = performance.now();
        state.autoRotate = false;
        function step(now) {
          const k = Math.min(1, (now - start) / duration);
          const e = easeInOut(k);
          state.theta = t0 + dt_theta * e;
          state.phi   = p0 + dt_phi * e;
          state.dist  = d0 + dt_dist * e;
          apply();
          if (k < 1) requestAnimationFrame(step); else res();
        }
        requestAnimationFrame(step);
      });
    }
    return {
      tick, apply, flyTo, state,
      set onChange(cb) { onChangeCB = cb; },
      setAutoRotate(on) { state.autoRotate = on; },
      getDist() { return state.dist; },
    };
  }

  // ── Texture loader (external earth bitmap) ────────────────────────
  function loadEarthTex(onReady) {
    // Try several CDNs for a real Blue Marble-style texture, fall back to a
    // procedural earthy painting if all fail or time out.
    const urls = [
      'https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/earth-blue-marble.jpg',
      'https://unpkg.com/three-globe@2.31.1/example/img/earth-blue-marble.jpg',
      'https://cdn.jsdelivr.net/gh/vasturiano/three-globe@master/example/img/earth-blue-marble.jpg',
    ];
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    let done = false;
    const fin = tex => { if (done) return; done = true; onReady(tex); };
    // Timeout fallback so we never sit on a black globe.
    const tid = setTimeout(() => fin(makeFallbackTex()), 4500);
    const tryNext = i => {
      if (i >= urls.length) { clearTimeout(tid); return fin(makeFallbackTex()); }
      loader.load(
        urls[i],
        tex => {
          clearTimeout(tid);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          fin(tex);
        },
        undefined,
        () => tryNext(i + 1),
      );
    };
    tryNext(0);
  }

  // Procedural earthy painting — not a photo, but clearly a globe with Borneo
  // positioned correctly so the user sees where they are.
  function makeFallbackTex() {
    const W = 2048, H = 1024;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    // Ocean — deep teal, hint of warmth at equator for editorial feel.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#102a3e');
    g.addColorStop(0.5, '#0e2736');
    g.addColorStop(1, '#10293a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    const P = (lon, lat) => [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];

    // Soft equatorial glow band
    const band = ctx.createLinearGradient(0, H*0.42, 0, H*0.58);
    band.addColorStop(0, 'rgba(212,158,92,0)');
    band.addColorStop(0.5, 'rgba(212,158,92,0.05)');
    band.addColorStop(1, 'rgba(212,158,92,0)');
    ctx.fillStyle = band; ctx.fillRect(0, H*0.42, W, H*0.16);

    // Rich continent polygons — hand-drawn-ish forest greens.
    const LAND = [
      // North America
      [[-168,66],[-140,70],[-100,72],[-78,63],[-60,50],[-64,42],[-80,25],[-98,18],[-108,23],[-125,36],[-130,55],[-168,66]],
      // Greenland
      [[-55,82],[-22,82],[-20,72],[-42,60],[-55,82]],
      // South America
      [[-81,12],[-56,10],[-38,-6],[-38,-24],[-58,-38],[-72,-54],[-72,-20],[-78,-8],[-81,12]],
      // Eurasia (big one)
      [[-10,37],[0,46],[20,40],[32,48],[44,44],[52,40],[60,44],[75,50],[88,50],[100,55],[120,56],[135,50],[142,54],[155,62],[172,70],[160,76],[110,80],[70,78],[30,73],[5,65],[-10,58],[-10,37]],
      // Africa
      [[-17,18],[12,33],[32,32],[43,12],[52,12],[44,-3],[40,-15],[32,-28],[20,-34],[14,-22],[8,4],[-10,8],[-17,18]],
      // India
      [[68,8],[80,8],[88,22],[78,32],[70,24],[68,8]],
      // SE Asia mainland
      [[94,20],[106,22],[110,10],[103,1],[98,6],[94,20]],
      // Australia
      [[114,-12],[136,-11],[145,-12],[153,-24],[150,-37],[138,-38],[118,-34],[114,-22],[114,-12]],
      // Antarctica hint
      [[-180,-70],[180,-70],[180,-85],[-180,-85],[-180,-70]],
    ];

    // Islands — Borneo, Sumatra, Java, New Guinea, Philippines, Japan, UK, Madagascar, NZ.
    const ISLANDS = [
      { poly: [[108.5,7.2],[118.5,7.0],[119.5,4.2],[118.3,0.5],[114.7,-3.8],[110.0,-2.8],[109.2,1.9],[108.5,7.2]], color: '#3f5c3a', name: 'Borneo' },
      { poly: [[95,5.5],[99,2],[105,-1],[106,-5.5],[102,-5.8],[97,-3],[95,1],[95,5.5]], color: '#3d5a37' },
      { poly: [[105,-6],[114,-6.8],[115,-8.6],[110,-8.4],[105,-7.2],[105,-6]], color: '#3d5a37' },
      { poly: [[131,-1],[141,-3],[150,-6],[150,-10.5],[140,-9],[132,-4.5],[131,-1]], color: '#3d5a37' },
      { poly: [[117,6],[122,7],[125,10],[126,17],[121,18],[118,12],[117,6]], color: '#3d5a37' },
      { poly: [[130,33],[141,36],[145,43],[141,45],[132,35],[130,33]], color: '#41603b' },
      { poly: [[-8,50],[2,52],[2,58],[-6,58],[-8,50]], color: '#41603b' },
      { poly: [[43,-12],[50,-14],[50,-25],[44,-25],[43,-12]], color: '#3d5a37' },
      { poly: [[166,-35],[176,-37],[175,-46],[167,-46],[166,-35]], color: '#3d5a37' },
    ];

    // Paint continents with layered fills for a little texture.
    ctx.fillStyle = '#3a5636';
    LAND.forEach(poly => {
      ctx.beginPath();
      poly.forEach((p,i) => { const [x,y] = P(p[0],p[1]); if (i) ctx.lineTo(x,y); else ctx.moveTo(x,y); });
      ctx.closePath(); ctx.fill();
    });
    // Desert/arid overlays — Sahara, Australia outback, SW US.
    ctx.fillStyle = 'rgba(180,132,70,0.35)';
    [
      [[-10,30],[30,32],[30,18],[-10,18],[-10,30]],      // Sahara
      [[40,24],[55,28],[55,14],[42,14],[40,24]],          // Arabia
      [[120,-20],[140,-22],[140,-32],[120,-32],[120,-20]],// Australian outback
      [[-115,38],[-100,38],[-100,28],[-115,28],[-115,38]],// SW US
    ].forEach(poly => {
      ctx.beginPath();
      poly.forEach((p,i) => { const [x,y] = P(p[0],p[1]); if (i) ctx.lineTo(x,y); else ctx.moveTo(x,y); });
      ctx.closePath(); ctx.fill();
    });
    // Ice caps
    ctx.fillStyle = 'rgba(230,230,240,0.55)';
    ctx.fillRect(0, 0, W, H*0.06);
    ctx.fillRect(0, H*0.94, W, H*0.06);

    // Islands
    ISLANDS.forEach(isl => {
      ctx.fillStyle = isl.color;
      ctx.beginPath();
      isl.poly.forEach((p,i) => { const [x,y] = P(p[0],p[1]); if (i) ctx.lineTo(x,y); else ctx.moveTo(x,y); });
      ctx.closePath(); ctx.fill();
    });

    // Highlight Sarawak — subtle ochre glow centered on the pilot bbox so the
    // user can find it at a glance while we wait for the real texture.
    const [sx, sy] = P(114.05, 4.05);
    const rg = ctx.createRadialGradient(sx, sy, 2, sx, sy, 34);
    rg.addColorStop(0, 'rgba(231,199,152,0.55)');
    rg.addColorStop(1, 'rgba(231,199,152,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(sx - 40, sy - 40, 80, 80);

    // Soft noise — very low amplitude so it reads as paper/terrain rather than TV static.
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 10;
      d[i]   = Math.max(0, Math.min(255, d[i]   + n));
      d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
      d[i+2] = Math.max(0, Math.min(255, d[i+2] + n));
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  // ── Public API ────────────────────────────────────────────────────
  window.Globe = {
    init(container, opts = {}) {
      const w = () => container.clientWidth;
      const h = () => container.clientHeight;

      const scene = new THREE.Scene();
      scene.background = null;

      const camera = new THREE.PerspectiveCamera(35, w()/h(), 0.0001, 100);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setSize(w(), h());
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      container.appendChild(renderer.domElement);

      // Lights
      scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      const key = new THREE.DirectionalLight(0xfff0dc, 1.05);
      key.position.set(4, 2, 3); scene.add(key);
      const fill = new THREE.DirectionalLight(0x8faac7, 0.35);
      fill.position.set(-4, -1, -2); scene.add(fill);

      // Earth
      const earthGeo = new THREE.SphereGeometry(R, 128, 128);
      const earthMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.95,
        metalness: 0.0,
      });
      const earth = new THREE.Mesh(earthGeo, earthMat);
      scene.add(earth);

      loadEarthTex(tex => {
        earthMat.map = tex;
        earthMat.needsUpdate = true;
        if (opts.onReady) opts.onReady();
      });

      // Atmosphere halo
      const atmoMat = new THREE.ShaderMaterial({
        transparent: true, side: THREE.BackSide, depthWrite: false,
        uniforms: {},
        vertexShader: `varying vec3 vN; void main(){ vN=normalize(normalMatrix*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
        fragmentShader: `varying vec3 vN; void main(){ float i=pow(0.62-dot(vN,vec3(0,0,1)),2.0); vec3 c=vec3(0.62,0.82,1.0)*i*1.0; gl_FragColor=vec4(c,i);}`,
      });
      const atmo = new THREE.Mesh(new THREE.SphereGeometry(R*1.08, 64, 64), atmoMat);
      scene.add(atmo);

      // Starfield
      const starGeom = new THREE.BufferGeometry();
      const sc = 1600, sp = new Float32Array(sc*3);
      for (let i=0;i<sc;i++){ const r=30+Math.random()*25, th=Math.random()*Math.PI*2, ph=Math.acos(2*Math.random()-1);
        sp[i*3]=r*Math.sin(ph)*Math.cos(th); sp[i*3+1]=r*Math.cos(ph); sp[i*3+2]=r*Math.sin(ph)*Math.sin(th); }
      starGeom.setAttribute('position', new THREE.BufferAttribute(sp,3));
      scene.add(new THREE.Points(starGeom, new THREE.PointsMaterial({ color:0xfff1d6, size:0.06, transparent:true, opacity:0.6 })));

      // Points layer: one Points mesh with per-dot color + size attrs,
      // mapped to the sphere. Custom shader keeps dots looking like
      // round stickers on the surface, not raw gl points.
      let pointsMesh = null;
      let _pointsData = [];
      let _visibleFn = () => true;

      const pointsMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uCamPos:   { value: new THREE.Vector3() },
          uSizeBase: { value: 2.4 },
          uPxRatio:  { value: Math.min(devicePixelRatio, 2) },
        },
        vertexShader: `
          attribute vec3 aColor;
          attribute float aSize;
          attribute float aVisible;
          varying vec3 vColor;
          varying float vVisible;
          varying float vFacing;
          uniform vec3 uCamPos;
          uniform float uSizeBase;
          uniform float uPxRatio;
          void main() {
            vColor = aColor;
            vVisible = aVisible;
            // Normal at this point = normalized position (unit sphere)
            vec3 n = normalize(position);
            vec3 toCam = normalize(uCamPos - position);
            vFacing = dot(n, toCam); // 1 = facing camera, -1 = back
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            // Size grows as camera gets closer (distance in world space)
            float d = length(uCamPos - position);
            gl_PointSize = aSize * uSizeBase * uPxRatio * (2.2 / max(d, 0.2));
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          varying float vVisible;
          varying float vFacing;
          void main() {
            if (vVisible < 0.5) discard;
            // Discard back-facing points (occluded by sphere)
            if (vFacing < 0.05) discard;
            vec2 uv = gl_PointCoord - 0.5;
            float d = length(uv);
            if (d > 0.5) discard;
            float alpha = smoothstep(0.5, 0.35, d);
            // Fade near the limb (horizon) for subtlety
            float limb = smoothstep(0.05, 0.35, vFacing);
            gl_FragColor = vec4(vColor, alpha * limb * 0.95);
          }
        `,
      });

      // Cache parsed hex→rgb to avoid 47k THREE.Color allocations at rebuild.
      const _colorCache = new Map();
      function hexToRgb(hex) {
        let c = _colorCache.get(hex);
        if (c) return c;
        const h = hex.replace('#','');
        const r = parseInt(h.slice(0,2),16)/255;
        const g = parseInt(h.slice(2,4),16)/255;
        const b = parseInt(h.slice(4,6),16)/255;
        c = [r,g,b];
        _colorCache.set(hex, c);
        return c;
      }
      function rebuildPoints() {
        if (pointsMesh) { scene.remove(pointsMesh); pointsMesh.geometry.dispose(); }
        const n = _pointsData.length;
        const pos = new Float32Array(n*3);
        const col = new Float32Array(n*3);
        const size = new Float32Array(n);
        const vis  = new Float32Array(n);
        const _v = { x:0, y:0, z:0 };
        for (let i=0;i<n;i++) {
          const p = _pointsData[i];
          // Match llToVec's coord convention (theta = lon + π) so the dots
          // land on the same spot on the earth texture as flyTo(lon,lat)
          // aims the camera at. The old version had the opposite z sign,
          // placing dots 180° east of their true longitude — Borneo (114°E)
          // rendered at 114°W, mid-Pacific.
          const lon = p.lon * Math.PI/180, lat = p.lat * Math.PI/180;
          const cl = Math.cos(lat);
          pos[i*3]   =  POINT_R * cl * Math.cos(lon);
          pos[i*3+1] =  POINT_R * Math.sin(lat);
          pos[i*3+2] = -POINT_R * cl * Math.sin(lon);
          const rgb = hexToRgb(p.color);
          col[i*3]=rgb[0]; col[i*3+1]=rgb[1]; col[i*3+2]=rgb[2];
          size[i] = p.size ?? 1.0;
          vis[i]  = _visibleFn(p) ? 1 : 0;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos,3));
        g.setAttribute('aColor',   new THREE.BufferAttribute(col,3));
        g.setAttribute('aSize',    new THREE.BufferAttribute(size,1));
        g.setAttribute('aVisible', new THREE.BufferAttribute(vis,1));
        pointsMesh = new THREE.Points(g, pointsMat);
        pointsMesh.frustumCulled = false;
        scene.add(pointsMesh);
      }

      function setPoints(arr) {
        _pointsData = arr; rebuildPoints();
        if (renderer._markDirty) renderer._markDirty(3);
      }
      function setVisibility(fn) {
        _visibleFn = fn;
        if (!pointsMesh) return;
        const v = pointsMesh.geometry.attributes.aVisible;
        for (let i=0;i<_pointsData.length;i++) v.array[i] = fn(_pointsData[i]) ? 1 : 0;
        v.needsUpdate = true;
        if (renderer._markDirty) renderer._markDirty(3);
      }
      function setPointSize(scale) {
        // Base multiplier was 1.8 — too big for the state-wide hex layer
        // where 28k points cover a large area. 1.0 reads as "individual
        // hexes" without swallowing the surrounding geography.
        pointsMat.uniforms.uSizeBase.value = 1.0 * scale;
      }

      // Pilot bounding-box outline on sphere (a small orange square marker)
      let pilotBox = null;
      function setPilotBox(bbox) {
        if (pilotBox) { scene.remove(pilotBox); pilotBox.geometry.dispose(); }
        const [w,s,e,n_] = bbox;
        const steps = 24;
        const pts = [];
        function add(lon, lat) { pts.push(llToVec(lon, lat, R*1.003)); }
        for (let i=0;i<=steps;i++) add(w + (e-w)*i/steps, s);
        for (let i=0;i<=steps;i++) add(e, s + (n_-s)*i/steps);
        for (let i=0;i<=steps;i++) add(e - (e-w)*i/steps, n_);
        for (let i=0;i<=steps;i++) add(w, n_ - (n_-s)*i/steps);
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        pilotBox = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xc67b2f, transparent: true, opacity: 0.85 }));
        scene.add(pilotBox);
      }

      // Orbit controls
      const controls = makeOrbitControls(camera, renderer.domElement, {
        initialDist: 3.2, minDist: 1.05, maxDist: 5.5,
      });

      // Render loop — dirty-flag driven so we're not re-rendering 60× / sec
      // when nothing's changing. The loop itself keeps running (cheap — the
      // callback just checks the dirty flag) but the actual render() call
      // only fires on:
      //   (a) autoRotate ticking the camera
      //   (b) user input (drag / wheel / flyTo / setVisibility)
      //   (c) a few frames after any camera change so the anti-aliasing
      //       post-settle is captured
      // This reclaims ~90 % of the prior render budget, which was previously
      // competing with the timeline-brush DOM work during drag.
      let last = performance.now();
      let dirty = true, settleFrames = 0;
      function markDirty(n = 2) { dirty = true; settleFrames = Math.max(settleFrames, n); }
      controls.onChange = () => markDirty(4);
      function frame(now) {
        const dt = (now - last) / 1000; last = now;
        const moved = controls.tick(dt);
        if (moved) markDirty(2);
        if (dirty || settleFrames > 0) {
          pointsMat.uniforms.uCamPos.value.copy(camera.position);
          renderer.render(scene, camera);
          if (!moved) settleFrames = Math.max(0, settleFrames - 1);
          dirty = false;
        }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      // Expose so other modules (points rebuilds, visibility updates) can
      // nudge the loop awake.
      renderer._markDirty = markDirty;

      // Resize
      function resize() {
        renderer.setSize(w(), h());
        camera.aspect = w()/h();
        camera.updateProjectionMatrix();
      }
      window.addEventListener('resize', resize);

      // Hit-testing: returns nearest point to screen coord (x,y) within px radius.
      const rayc = new THREE.Raycaster();
      function pickPoint(clientX, clientY, pxRadius = 16) {
        if (!pointsMesh) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const mx = ((clientX - rect.left) / rect.width) * 2 - 1;
        const my = -((clientY - rect.top) / rect.height) * 2 + 1;
        rayc.setFromCamera({ x: mx, y: my }, camera);
        // Cheap: project all points, find nearest in screen space that's front-facing
        const pos = pointsMesh.geometry.attributes.position.array;
        const vis = pointsMesh.geometry.attributes.aVisible.array;
        const camPos = camera.position;
        let best = null, bestD = pxRadius*pxRadius;
        const v = new THREE.Vector3();
        const W = rect.width, H = rect.height;
        for (let i=0;i<_pointsData.length;i++) {
          if (!vis[i]) continue;
          v.set(pos[i*3], pos[i*3+1], pos[i*3+2]);
          const n = v.clone().normalize();
          const toCam = camPos.clone().sub(v).normalize();
          if (n.dot(toCam) < 0.05) continue; // back-face
          const p = v.clone().project(camera);
          const sx = (p.x*0.5+0.5)*W, sy = (-p.y*0.5+0.5)*H;
          const dx = sx - (clientX-rect.left), dy = sy - (clientY-rect.top);
          const dd = dx*dx + dy*dy;
          if (dd < bestD) { bestD = dd; best = _pointsData[i]; best._screenX = sx; best._screenY = sy; }
        }
        return best;
      }

      return {
        el: renderer.domElement,
        scene, camera, controls,
        setPoints, setVisibility, setPointSize,
        setPilotBox,
        pickPoint,
        flyTo: (lon, lat, dist, dur) => controls.flyTo(lon, lat, dist, dur),
        setAutoRotate: on => controls.setAutoRotate(on),
        getDist: () => controls.getDist(),
        resize,
      };
    }
  };
})();
