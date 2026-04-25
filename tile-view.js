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
  const MAX_CACHE = 400;     // 4K screens at zoom 13 want ~50 tiles × 2 layers
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
  let onZoom  = null;    // external callback fired on zoom change
  let onClick = null;
  let highlight = null;  // point to highlight

  // ── Per-tile pixel streaming ──────────────────────────────────────
  // Why this exists: the full 2-of-3 detection set is ~2 GB. Loading it all
  // up front would stall the page and blow mobile memory. We chunk it into
  // 0.1° × 0.1° binary tiles (see 09_chunk_tiles.py) and fetch only the
  // tiles that intersect the current viewport, above a zoom threshold where
  // per-pixel detail makes sense. Below that threshold we fall back to
  // the H3 hex aggregate (rendered from `points`).
  const TILE_BIN_DEG    = 0.1;                  // matches 09_chunk_tiles.py
  const TILE_GRID_COLS  = 65;                   // Sarawak bbox widths
  const TILE_GRID_ROWS  = 42;
  const TILE_LON_MIN    = 109.5;
  const TILE_LAT_MIN    =   0.8;
  // Sarawak admin-1 boundary, multi-polygon — GADM v4.1 with Douglas-
  // Peucker simplification (mainland 0.008° ≈ 880 m, islands 0.0025°
  // ≈ 275 m).  Drops offshore rocks under ~1.2 km².  ~14 rings /
  // ~1100 verts / ~17 KB.  The previous single 162-vertex outline cut
  // peninsulas like Bako and Santubong inland of the actual coast,
  // omitting their hexes.  Build script: ../sarawak/scripts/build_sarawak_boundary.py
  const SARAWAK_RINGS = [
    [[110.2611,1.0528],[110.2416,1.1101],[110.2078,1.1185],[110.206,1.1521],[110.1892,1.1785],[110.1446,1.1996],[110.0963,1.1975],[110.0817,1.2157],[110.0413,1.2047],[110.0652,1.2393],[110.0615,1.2591],[109.9786,1.2986],[109.9592,1.3943],[109.9239,1.4219],[109.8304,1.4244],[109.8363,1.4824],[109.8006,1.4695],[109.7952,1.4986],[109.6857,1.6081],[109.6607,1.6193],[109.6568,1.6704],[109.6829,1.785],[109.6354,1.8051],[109.5846,1.791],[109.5821,1.8181],[109.5724,1.8204],[109.5801,1.838],[109.5531,1.8578],[109.5397,1.9049],[109.5636,1.9446],[109.548,1.956],[109.5516,1.9666],[109.6184,1.9872],[109.6467,2.0577],[109.6569,2.0383],[109.6468,2.0082],[109.6668,1.9852],[109.6507,1.9825],[109.6442,1.9461],[109.6517,1.9103],[109.6844,1.8765],[109.6817,1.8608],[109.7745,1.8183],[109.7939,1.7892],[109.7846,1.7832],[109.7969,1.7903],[109.787,1.8082],[109.8528,1.7871],[109.8518,1.7712],[109.8822,1.7532],[109.8705,1.7278],[109.925,1.7006],[109.8831,1.6942],[109.8832,1.6737],[109.9048,1.6819],[109.8943,1.6484],[109.8542,1.6706],[109.862,1.6473],[109.8481,1.6273],[109.8642,1.6232],[109.8427,1.6222],[109.8431,1.6059],[109.8428,1.6204],[109.8654,1.6237],[109.858,1.6345],[109.8492,1.6285],[109.8634,1.6472],[109.8576,1.6716],[109.8982,1.6509],[109.9071,1.68],[109.8994,1.6869],[109.8841,1.6757],[109.8888,1.6977],[109.925,1.6856],[109.9541,1.7013],[109.9759,1.6938],[109.9755,1.6753],[109.9238,1.6392],[109.9342,1.637],[109.9637,1.6721],[110.0049,1.6805],[109.9892,1.687],[110.0067,1.6981],[110.1347,1.6972],[110.1294,1.6656],[110.1142,1.6744],[110.0861,1.6606],[110.0958,1.6544],[110.1153,1.6722],[110.1444,1.6564],[110.135,1.6692],[110.1411,1.6958],[110.195,1.7069],[110.1956,1.6843],[110.2436,1.6669],[110.2392,1.655],[110.2145,1.65],[110.2174,1.6416],[110.2303,1.6497],[110.2392,1.6122],[110.2325,1.6486],[110.2433,1.6525],[110.2586,1.6133],[110.2878,1.6344],[110.3014,1.6118],[110.3008,1.6214],[110.3133,1.6181],[110.3184,1.5932],[110.3158,1.6181],[110.2908,1.6328],[110.2967,1.6403],[110.3167,1.6272],[110.2992,1.6411],[110.3114,1.6626],[110.2942,1.6872],[110.3292,1.7133],[110.3414,1.705],[110.3361,1.6706],[110.3636,1.6042],[110.4066,1.5781],[110.3701,1.5735],[110.3766,1.5569],[110.3292,1.5708],[110.3067,1.545],[110.2931,1.5528],[110.275,1.5181],[110.2964,1.5508],[110.3081,1.5442],[110.33,1.5689],[110.3761,1.5543],[110.3826,1.5634],[110.3726,1.5725],[110.4006,1.5751],[110.3933,1.5472],[110.4169,1.5219],[110.3855,1.4803],[110.4106,1.5122],[110.43,1.4992],[110.3958,1.5483],[110.4194,1.5764],[110.435,1.5769],[110.4461,1.5675],[110.4242,1.5617],[110.4312,1.5233],[110.4586,1.5067],[110.4883,1.5167],[110.5089,1.4917],[110.4914,1.4833],[110.5119,1.4333],[110.5356,1.4386],[110.5361,1.4211],[110.5167,1.4072],[110.5239,1.3928],[110.5183,1.4069],[110.5369,1.4203],[110.5364,1.4394],[110.5139,1.4328],[110.4956,1.4839],[110.5108,1.4883],[110.4981,1.5081],[110.5192,1.5181],[110.5,1.525],[110.5042,1.5478],[110.4842,1.5269],[110.4739,1.535],[110.4903,1.5644],[110.5283,1.5489],[110.5414,1.5856],[110.596,1.6015],[110.7314,1.5464],[110.7392,1.4819],[110.6428,1.4239],[110.6594,1.3928],[110.7047,1.4172],[110.7442,1.3942],[110.7342,1.3794],[110.6833,1.3869],[110.6611,1.3703],[110.6783,1.3467],[110.7064,1.3394],[110.6719,1.3061],[110.7237,1.3028],[110.6844,1.2828],[110.6947,1.2731],[110.6825,1.26],[110.6878,1.2464],[110.6961,1.2733],[110.6856,1.2824],[110.7264,1.3014],[110.7103,1.3136],[110.6746,1.3087],[110.7108,1.3344],[110.6675,1.3711],[110.6753,1.3797],[110.7322,1.3739],[110.7483,1.3964],[110.7056,1.4231],[110.6601,1.3985],[110.6489,1.4228],[110.7525,1.4731],[110.7656,1.5592],[110.7881,1.5786],[110.9781,1.4983],[111.0674,1.4014],[111.1228,1.3889],[111.1702,1.3596],[111.2185,1.3913],[111.2531,1.3946],[111.2803,1.3419],[111.3183,1.3248],[111.3238,1.3357],[111.2949,1.4001],[111.2403,1.4169],[111.1725,1.3876],[111.1333,1.4183],[111.0663,1.4456],[111.0361,1.5083],[110.9944,1.5233],[110.9944,1.5722],[111.0168,1.651],[111.0467,1.6808],[111.1399,1.6787],[111.1513,1.6397],[111.1691,1.6276],[111.2074,1.64],[111.2357,1.6167],[111.2831,1.6211],[111.2366,1.6295],[111.21,1.6522],[111.1669,1.6417],[111.1556,1.6906],[111.1239,1.7011],[111.0862,1.7566],[111.1358,1.8014],[111.1357,1.8199],[111.1053,1.7922],[111.1028,1.8202],[111.1669,1.9504],[111.1885,2.0346],[111.2224,2.0209],[111.2458,2.0342],[111.2033,2.0289],[111.1953,2.0469],[111.21,2.0957],[111.2315,2.0748],[111.27,2.0653],[111.2692,2.0544],[111.2832,2.0547],[111.2783,2.045],[111.2839,2.0552],[111.2703,2.055],[111.2716,2.0658],[111.2952,2.0677],[111.303,2.057],[111.2886,2.0492],[111.3195,2.0206],[111.2897,2.0533],[111.3245,2.0628],[111.3443,2.0884],[111.3489,2.0478],[111.3485,2.0936],[111.3809,2.1081],[111.3489,2.0953],[111.3547,2.1347],[111.3608,2.12],[111.3803,2.1303],[111.4119,2.1097],[111.4139,2.0933],[111.4169,2.115],[111.4064,2.1117],[111.4035,2.1249],[111.4033,2.1136],[111.3811,2.1325],[111.3594,2.1233],[111.3574,2.155],[111.3813,2.1428],[111.4128,2.1536],[111.4607,2.1272],[111.47,2.1334],[111.4668,2.1613],[111.4794,2.1576],[111.4829,2.1381],[111.5265,2.1309],[111.5312,2.1525],[111.5483,2.1502],[111.5549,2.1736],[111.5426,2.1861],[111.5528,2.1727],[111.5458,2.1514],[111.5301,2.1543],[111.5217,2.1367],[111.4832,2.1422],[111.4753,2.1644],[111.4603,2.1606],[111.4616,2.1314],[111.4129,2.1611],[111.3811,2.1502],[111.3712,2.1635],[111.3767,2.1875],[111.4028,2.1683],[111.4133,2.1878],[111.4536,2.2058],[111.4744,2.1747],[111.5042,2.212],[111.4731,2.1767],[111.4553,2.2072],[111.4236,2.1883],[111.3889,2.2078],[111.4268,2.2334],[111.4816,2.2263],[111.4755,2.2438],[111.4815,2.233],[111.46,2.2229],[111.4548,2.238],[111.4264,2.2343],[111.3848,2.2064],[111.3797,2.22],[111.3545,2.2042],[111.3454,2.2523],[111.2946,2.3038],[111.32,2.3191],[111.3182,2.304],[111.3447,2.2915],[111.3397,2.2649],[111.3787,2.2586],[111.3927,2.2412],[111.4385,2.264],[111.4606,2.2586],[111.4358,2.2651],[111.4353,2.2546],[111.3941,2.2424],[111.3792,2.26],[111.3425,2.2647],[111.3465,2.2874],[111.3818,2.2738],[111.3089,2.3247],[111.3251,2.3386],[111.3078,2.3573],[111.3275,2.3702],[111.355,2.3406],[111.3361,2.3281],[111.3693,2.3337],[111.358,2.3359],[111.3744,2.34],[111.3875,2.3647],[111.4117,2.3594],[111.4392,2.3775],[111.4928,2.3436],[111.4794,2.3672],[111.4147,2.4153],[111.3961,2.4917],[111.4672,2.4725],[111.5,2.4908],[111.5086,2.4575],[111.5433,2.4342],[111.5575,2.4389],[111.5667,2.4639],[111.585,2.4444],[111.6026,2.4486],[111.565,2.4717],[111.5436,2.4408],[111.5153,2.4653],[111.5078,2.4981],[111.4636,2.4869],[111.3975,2.5317],[111.4339,2.7022],[111.4672,2.7125],[111.4908,2.7451],[111.5981,2.7942],[111.635,2.8494],[111.6491,2.8494],[111.6809,2.8168],[111.7404,2.7963],[111.6786,2.8342],[111.6853,2.8416],[111.8733,2.8761],[111.8802,2.8688],[111.8599,2.8508],[111.8727,2.8396],[111.882,2.8563],[111.8793,2.8425],[111.8944,2.8448],[111.8884,2.8197],[111.8997,2.8221],[111.9044,2.7995],[111.907,2.8137],[111.889,2.821],[111.8956,2.8449],[111.8797,2.8434],[111.8819,2.8577],[111.872,2.8409],[111.8609,2.8527],[111.8856,2.8736],[112.0908,2.9111],[112.0964,2.8989],[112.0999,2.9144],[112.5053,3.0106],[112.5662,3.0211],[112.5861,3.0035],[112.5856,3.0154],[112.6212,3.0387],[112.785,3.0865],[112.8178,3.0711],[112.8003,3.0845],[112.9233,3.1137],[113.0064,3.1601],[113.0742,3.244],[113.0667,3.2562],[113.0768,3.263],[113.0525,3.2669],[113.1587,3.3493],[113.1896,3.4146],[113.2614,3.4686],[113.3026,3.5167],[113.2955,3.5464],[113.3725,3.6214],[113.4151,3.6933],[113.4339,3.7564],[113.553,3.8353],[113.6939,3.9553],[113.7714,4.0408],[113.8181,4.1222],[113.924,4.2485],[113.964,4.3227],[113.9711,4.3497],[113.9605,4.3619],[113.9853,4.3922],[113.9794,4.3867],[113.9772,4.3992],[113.9971,4.4433],[113.9947,4.5011],[113.9678,4.5809],[113.977,4.5977],[114.1395,4.5846],[114.1725,4.5716],[114.196,4.5411],[114.2372,4.5295],[114.3086,4.4173],[114.3054,4.3772],[114.3288,4.3524],[114.3178,4.2759],[114.35,4.2642],[114.3779,4.2774],[114.4125,4.2665],[114.4477,4.2853],[114.4598,4.2334],[114.5003,4.1577],[114.5456,4.146],[114.5806,4.0827],[114.6375,4.0621],[114.6224,4.0262],[114.6485,4.0249],[114.7252,4.062],[114.8145,4.1559],[114.8222,4.1713],[114.8003,4.1687],[114.8018,4.1855],[114.8624,4.2835],[114.8272,4.2617],[114.8269,4.2835],[114.8866,4.3741],[114.888,4.4232],[114.8487,4.4346],[114.8309,4.4541],[114.8168,4.6475],[114.7912,4.7089],[114.7948,4.7464],[114.8379,4.7579],[114.877,4.8139],[114.9762,4.8368],[115.0007,4.8846],[115.0214,4.8909],[115.0185,4.8697],[115.03,4.8731],[115.0073,4.8416],[115.0273,4.8535],[115.021,4.8122],[115.038,4.7932],[115.0607,4.6342],[115.1107,4.4924],[115.1141,4.3989],[115.2105,4.376],[115.2493,4.3789],[115.2621,4.3464],[115.2932,4.3503],[115.3278,4.3146],[115.3459,4.3133],[115.3749,4.3357],[115.3759,4.3536],[115.2883,4.4617],[115.2802,4.5598],[115.3004,4.6134],[115.2959,4.6421],[115.2691,4.6642],[115.2771,4.689],[115.263,4.7094],[115.266,4.7452],[115.2419,4.7766],[115.2481,4.811],[115.1936,4.8561],[115.1553,4.9112],[115.1941,4.9301],[115.1974,4.965],[115.2296,4.9596],[115.2493,4.9166],[115.322,4.8935],[115.3843,4.9144],[115.3968,4.9269],[115.3932,4.9494],[115.4331,4.9817],[115.4547,4.9857],[115.5026,4.9674],[115.5621,4.996],[115.6126,5.0022],[115.6306,4.9924],[115.6659,4.8392],[115.6648,4.7907],[115.6098,4.6847],[115.5684,4.6422],[115.5598,4.6093],[115.5914,4.527],[115.5747,4.492],[115.6066,4.4275],[115.6004,4.3754],[115.6594,4.3471],[115.6797,4.3178],[115.6459,4.189],[115.6597,4.1395],[115.6901,4.1245],[115.6819,4.0707],[115.6656,4.0642],[115.6534,4.0336],[115.6713,4.0321],[115.6562,3.9876],[115.6177,3.9373],[115.5895,3.9429],[115.5714,3.9267],[115.6259,3.8799],[115.6282,3.8644],[115.5895,3.7824],[115.5823,3.6961],[115.5712,3.6799],[115.5933,3.5945],[115.6117,3.5757],[115.6193,3.5102],[115.6425,3.4776],[115.6339,3.4645],[115.657,3.4394],[115.6237,3.4087],[115.6097,3.447],[115.5873,3.4493],[115.5459,3.3682],[115.5373,3.2359],[115.5155,3.2227],[115.5214,3.1893],[115.5642,3.1614],[115.5217,3.1151],[115.5217,3.0651],[115.4982,3.0294],[115.486,3.0182],[115.4404,3.024],[115.3936,2.9796],[115.3317,2.9752],[115.3168,3.0173],[115.2884,3.0354],[115.25,2.966],[115.2127,2.9586],[115.1751,2.9312],[115.1599,2.8674],[115.0934,2.8211],[115.1552,2.7907],[115.1409,2.7758],[115.1405,2.7475],[115.1075,2.7229],[115.1212,2.6522],[115.0977,2.6127],[115.1171,2.5886],[115.1772,2.6106],[115.2122,2.5736],[115.2236,2.5426],[115.2578,2.5404],[115.2421,2.4986],[115.2048,2.4716],[115.1893,2.4828],[115.1445,2.4759],[115.1035,2.4342],[115.0989,2.4035],[115.0504,2.4043],[115.0531,2.3855],[115.0374,2.389],[115.0249,2.3645],[115.007,2.3641],[114.9983,2.3493],[114.9629,2.3654],[114.9482,2.3216],[114.9653,2.2868],[114.9381,2.2801],[114.9172,2.2553],[114.7998,2.2504],[114.7845,2.2006],[114.7387,2.1903],[114.7365,2.1338],[114.7933,2.146],[114.8186,2.1277],[114.7973,2.0878],[114.8098,2.064],[114.7907,2.0584],[114.8078,2.0241],[114.8564,2.0437],[114.8869,2.0244],[114.8527,1.966],[114.8541,1.9479],[114.8826,1.9158],[114.8556,1.8948],[114.8194,1.8923],[114.7921,1.8465],[114.7463,1.8684],[114.7223,1.8568],[114.7279,1.8338],[114.6977,1.8091],[114.7151,1.7841],[114.7087,1.638],[114.6525,1.5896],[114.6115,1.575],[114.6021,1.5323],[114.6164,1.5159],[114.5661,1.4263],[114.4059,1.5127],[114.3073,1.4715],[114.2864,1.4517],[114.2389,1.4461],[114.2099,1.4107],[114.1373,1.464],[114.0251,1.4468],[113.9788,1.4529],[113.9474,1.4384],[113.934,1.4173],[113.8214,1.3709],[113.8273,1.3327],[113.8009,1.2978],[113.7032,1.2609],[113.6624,1.2214],[113.6368,1.2177],[113.6235,1.2204],[113.6212,1.2478],[113.5979,1.2593],[113.5808,1.3019],[113.5417,1.3196],[113.424,1.2834],[113.3214,1.3771],[113.2639,1.3918],[113.1722,1.3793],[113.1324,1.3942],[113.1002,1.4393],[113.0121,1.4072],[112.9735,1.4081],[112.9763,1.4483],[113.0326,1.4738],[113.0304,1.4931],[113.0618,1.5308],[113.0565,1.5542],[113.0251,1.565],[112.9259,1.5683],[112.8876,1.5875],[112.8399,1.5376],[112.8014,1.5397],[112.777,1.5618],[112.7251,1.5654],[112.6815,1.5524],[112.6501,1.5693],[112.4861,1.5761],[112.4485,1.5544],[112.4291,1.5249],[112.3228,1.5035],[112.2672,1.4662],[112.2087,1.4493],[112.1991,1.4102],[112.2229,1.3831],[112.2036,1.3326],[112.1745,1.3019],[112.1612,1.2111],[112.1436,1.1809],[112.1524,1.152],[111.9455,1.1217],[111.8807,1.0507],[111.8617,1.003],[111.799,1.0185],[111.785,1.0018],[111.7658,1.0222],[111.7279,1.0109],[111.6686,1.0467],[111.5892,0.9936],[111.5485,0.9852],[111.5352,0.9606],[111.5123,1.0105],[111.4807,1.0355],[111.4112,1.0091],[111.2296,1.085],[111.1459,1.0508],[110.9045,1.025],[110.8863,0.9838],[110.8536,0.9514],[110.8012,0.944],[110.8083,0.8595],[110.7765,0.8911],[110.7975,0.906],[110.7729,0.9321],[110.757,0.8992],[110.7177,0.906],[110.6939,0.8609],[110.6763,0.8782],[110.6603,0.871],[110.6445,0.8976],[110.634,0.8946],[110.6302,0.869],[110.5768,0.8537],[110.4823,0.881],[110.4376,0.9169],[110.4363,0.9452],[110.4061,0.9521],[110.3933,0.9936],[110.3616,0.9833],[110.3093,1.0037],[110.2753,0.9977],[110.2778,1.0474],[110.2611,1.0528]],
    [[110.2697,1.7106],[110.2753,1.7042],[110.2781,1.7086],[110.2864,1.7078],[110.2883,1.6981],[110.2769,1.6836],[110.2681,1.6864],[110.2647,1.6803],[110.2711,1.68],[110.2656,1.6817],[110.2672,1.685],[110.2794,1.6814],[110.2786,1.6781],[110.2928,1.6633],[110.3033,1.6575],[110.2861,1.6344],[110.2742,1.63],[110.2718,1.6225],[110.2667,1.6297],[110.255,1.6319],[110.2573,1.6415],[110.2472,1.6522],[110.2486,1.6661],[110.2442,1.6739],[110.2136,1.6797],[110.2078,1.685],[110.2208,1.6947],[110.2289,1.6939],[110.2442,1.6842],[110.2436,1.6883],[110.2239,1.6964],[110.2064,1.6886],[110.215,1.7019],[110.2697,1.7106]],
    [[110.4078,1.5619],[110.4014,1.5567],[110.3954,1.5617],[110.4056,1.5661],[110.4078,1.5744],[110.4111,1.5728],[110.4078,1.5619]],
    [[110.4922,1.6342],[110.5119,1.6292],[110.5197,1.6156],[110.5256,1.5922],[110.5339,1.5803],[110.5311,1.5594],[110.5211,1.5511],[110.4975,1.5675],[110.4886,1.5683],[110.4739,1.5469],[110.4722,1.5317],[110.4789,1.5253],[110.4856,1.5247],[110.4939,1.5417],[110.5011,1.5458],[110.5047,1.5417],[110.4981,1.5311],[110.4983,1.5236],[110.5153,1.5197],[110.5167,1.5131],[110.4944,1.5094],[110.4836,1.5189],[110.4572,1.5081],[110.4458,1.5128],[110.4328,1.5247],[110.4258,1.5411],[110.4256,1.56],[110.4294,1.5642],[110.4347,1.5564],[110.4417,1.5567],[110.4483,1.5694],[110.4395,1.5786],[110.4583,1.58],[110.4681,1.5883],[110.4689,1.5986],[110.46,1.615],[110.4603,1.6222],[110.4728,1.6303],[110.4922,1.6342]],
    [[110.505,1.7503],[110.515,1.7428],[110.5128,1.7388],[110.5183,1.7372],[110.5181,1.7297],[110.5256,1.7236],[110.5125,1.7194],[110.4983,1.7075],[110.4903,1.6828],[110.4947,1.6739],[110.4919,1.6697],[110.48,1.6672],[110.4786,1.6583],[110.4817,1.6539],[110.4956,1.6492],[110.4736,1.6417],[110.4528,1.6233],[110.4533,1.6069],[110.4622,1.5928],[110.4208,1.5828],[110.4117,1.575],[110.4008,1.5897],[110.3958,1.5914],[110.3894,1.5858],[110.385,1.5867],[110.3844,1.6025],[110.3747,1.6],[110.3653,1.6053],[110.3517,1.6447],[110.365,1.6547],[110.3736,1.6514],[110.3786,1.6542],[110.3744,1.6889],[110.3889,1.6942],[110.4083,1.6906],[110.42,1.6778],[110.4314,1.6756],[110.4333,1.6717],[110.4256,1.6817],[110.4292,1.6936],[110.4328,1.6936],[110.4408,1.7074],[110.4389,1.7158],[110.4459,1.7189],[110.4417,1.7244],[110.4436,1.7303],[110.4533,1.7342],[110.4581,1.7292],[110.4608,1.7392],[110.4728,1.7327],[110.4719,1.725],[110.4942,1.7236],[110.4953,1.7292],[110.5022,1.7319],[110.4961,1.7453],[110.4994,1.7464],[110.5008,1.7425],[110.5019,1.7503],[110.505,1.7503]],
    [[110.2905,1.6781],[110.301,1.6726],[110.3016,1.6638],[110.2916,1.6671],[110.288,1.6765],[110.2905,1.6781]],
    [[110.3397,1.8058],[110.3472,1.7969],[110.3383,1.7864],[110.3392,1.7789],[110.3556,1.7589],[110.3581,1.7361],[110.3547,1.7311],[110.3592,1.7261],[110.3533,1.7189],[110.3722,1.705],[110.3725,1.675],[110.3786,1.6589],[110.3761,1.6531],[110.3642,1.6558],[110.3517,1.6462],[110.34,1.6728],[110.3444,1.7039],[110.3319,1.7164],[110.3153,1.7161],[110.3129,1.7306],[110.3019,1.7372],[110.3069,1.7428],[110.3058,1.7489],[110.3133,1.7503],[110.3192,1.7603],[110.3161,1.7675],[110.3275,1.7892],[110.3283,1.8011],[110.3397,1.8058]],
    [[111.3044,2.1067],[111.3189,2.1006],[111.3425,2.1061],[111.3461,2.0969],[111.3452,2.0901],[111.3308,2.0792],[111.3283,2.0673],[111.3076,2.058],[111.3015,2.0676],[111.281,2.0763],[111.2784,2.0834],[111.2833,2.0992],[111.2883,2.0988],[111.2842,2.1014],[111.2914,2.1116],[111.3044,2.1067]],
    [[111.2903,2.1153],[111.2773,2.0869],[111.2801,2.076],[111.2695,2.0711],[111.2477,2.0744],[111.2226,2.0925],[111.2344,2.1178],[111.2417,2.1131],[111.25,2.1142],[111.2517,2.1033],[111.2469,2.1026],[111.253,2.1033],[111.2519,2.1133],[111.2417,2.1147],[111.2362,2.122],[111.2483,2.1342],[111.2725,2.1275],[111.2903,2.1153]],
    [[111.3575,2.1883],[111.3574,2.1998],[111.3654,2.2141],[111.3821,2.2172],[111.3818,2.2056],[111.3983,2.2017],[111.3983,2.1953],[111.4056,2.1925],[111.3992,2.1833],[111.4011,2.1719],[111.3894,2.1808],[111.3836,2.1911],[111.3719,2.19],[111.3706,2.1703],[111.3499,2.1635],[111.3396,2.1537],[111.3381,2.1275],[111.3317,2.1183],[111.3189,2.1228],[111.2972,2.1394],[111.2861,2.1422],[111.2961,2.1447],[111.2972,2.1514],[111.2953,2.1456],[111.2833,2.1419],[111.2475,2.1522],[111.2118,2.1493],[111.1933,2.1403],[111.1887,2.1442],[111.1833,2.137],[111.1584,2.1588],[111.1664,2.1864],[111.1908,2.195],[111.1939,2.1929],[111.1916,2.2009],[111.2043,2.212],[111.2184,2.2363],[111.2229,2.2349],[111.2414,2.1982],[111.2491,2.1912],[111.2655,2.1887],[111.2821,2.197],[111.2896,2.2202],[111.2831,2.2824],[111.3057,2.2763],[111.3416,2.2513],[111.3507,2.2281],[111.3473,2.2084],[111.356,2.2],[111.3575,2.1883]],
    [[111.2531,2.4359],[111.2401,2.4109],[111.2365,2.3954],[111.2424,2.3877],[111.2579,2.3905],[111.265,2.3811],[111.2633,2.3768],[111.2516,2.3792],[111.2452,2.3744],[111.2516,2.3658],[111.2476,2.3567],[111.2492,2.3498],[111.2655,2.3364],[111.2605,2.3276],[111.2554,2.3264],[111.2586,2.3254],[111.2581,2.3058],[111.2604,2.3251],[111.2685,2.3361],[111.2567,2.3428],[111.2507,2.3517],[111.2539,2.3668],[111.2475,2.3753],[111.2625,2.3743],[111.2673,2.3812],[111.2581,2.3934],[111.2406,2.3928],[111.2445,2.4093],[111.2589,2.4236],[111.2601,2.4181],[111.2662,2.4145],[111.3019,2.4022],[111.3063,2.3916],[111.3043,2.3796],[111.2922,2.3642],[111.2925,2.3522],[111.2782,2.349],[111.2836,2.3201],[111.2789,2.3064],[111.2699,2.299],[111.2617,2.2822],[111.2855,2.3161],[111.281,2.3487],[111.2943,2.35],[111.2959,2.3643],[111.3078,2.3781],[111.3136,2.3959],[111.3269,2.3925],[111.3292,2.3875],[111.3033,2.3566],[111.3051,2.3492],[111.3182,2.3428],[111.3205,2.3353],[111.3025,2.3275],[111.3028,2.3089],[111.292,2.3037],[111.2975,2.2958],[111.2832,2.2936],[111.2762,2.2816],[111.2761,2.2381],[111.2822,2.2057],[111.2748,2.1989],[111.2583,2.1942],[111.2509,2.1964],[111.243,2.2226],[111.2208,2.2468],[111.2089,2.2482],[111.194,2.2335],[111.1902,2.2346],[111.1917,2.2913],[111.1831,2.3497],[111.1842,2.3664],[111.1981,2.3972],[111.2243,2.4241],[111.2451,2.4379],[111.2531,2.4359]],
    [[111.3369,2.8025],[111.3517,2.785],[111.3656,2.7506],[111.3831,2.7356],[111.3869,2.7261],[111.3883,2.7169],[111.3792,2.7033],[111.3781,2.6942],[111.3845,2.6161],[111.3778,2.5703],[111.3806,2.5183],[111.3781,2.49],[111.3964,2.4608],[111.4047,2.4067],[111.4111,2.3936],[111.4222,2.3833],[111.415,2.3694],[111.3928,2.3747],[111.3797,2.3719],[111.37,2.3517],[111.3631,2.3475],[111.345,2.3697],[111.3456,2.3911],[111.3403,2.4044],[111.3269,2.4178],[111.3019,2.4308],[111.3003,2.4658],[111.3105,2.5131],[111.2961,2.5642],[111.2811,2.6453],[111.28,2.6861],[111.2833,2.6989],[111.2806,2.7075],[111.2878,2.7469],[111.3136,2.7928],[111.3283,2.8025],[111.3369,2.8025]],
    [[111.3925,2.721],[111.3836,2.7539],[111.4037,2.7676],[111.396,2.7224],[111.3938,2.7181],[111.3925,2.721]],
    [[111.2868,1.386],[111.2972,1.3757],[111.2925,1.3559],[111.2813,1.3702],[111.2823,1.386],[111.2868,1.386]],
  ];
  // Even-odd ray-cast against each ring; return true if inside any ring.
  // Sarawak's GADM geometry has no holes, so OR-across-rings is the same
  // as point-in-multipolygon.
  const inSarawak = (lon, lat) => {
    for (let r = 0; r < SARAWAK_RINGS.length; r++) {
      const ring = SARAWAK_RINGS[r];
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };
  // Expose globally so index.html (chip totals) and globe.js can use the
  // same Sarawak clip as tile-view's hex render — we want Sarawak-only
  // numbers everywhere (the bbox spills into Brunei/Sabah/Kalimantan).
  window.inSarawak = inSarawak;
  window.SARAWAK_RINGS = SARAWAK_RINGS;
  // Zoom threshold: at zoom < this we render the hex aggregate; at ≥ this
  // we render per-pixel dots from .bin tiles. Set to 13 so any nontrivial
  // zoom-out from the fly-in (which opens at zoom 13.2) flips back to the
  // hex layer — below ~12, the viewport spans dozens of tiles × ~200K
  // points and the tab freezes.
  const LOD_ZOOM_SWITCH = 13;
  const BIN_MAX_CACHE   = 48;                   // LRU budget (~48 × ~1 MB)
  // .bin tiles served from the same public GCS bucket as the rest of
  // the data layer (see DATA_BASE in index.html).  Replaces the previous
  // GitHub LFS path (media.githubusercontent.com/media/...) which had
  // wildly variable TTFB and was the main source of "blank tiles look
  // like no data here" complaints.
  const DATA_BASE = (typeof window !== 'undefined' && window.DATA_BASE)
    || 'https://storage.googleapis.com/borneo-deforestation-data/data/';
  const BIN_BASE     = DATA_BASE + 'tiles/2of3/';
  const MANIFEST_URL = BIN_BASE + 'manifest.json';
  let   binManifest     = null;                 // { tiles: { iy_ix: {...} } }
  const binCache        = new Map();            // key → { dx, dy, yr, n, lonMin, latMin }
  const binFetching     = new Set();

  function loadBinManifest() {
    if (binManifest || loadBinManifest._pending) return loadBinManifest._pending;
    loadBinManifest._pending = fetch(MANIFEST_URL)
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
        // 09_chunk_tiles.py). Reserved id lets us distinguish real
        // clusters from "propagation noise" in the browser.
        const off = 12;
        const dx = new Uint16Array(buf, off,          n);
        const dy = new Uint16Array(buf, off + 2*n,    n);
        const yr = new Uint8Array (buf, off + 4*n,    n);
        const cl = new Uint8Array (buf, off + 5*n,    n);
        // Per-tile Sarawak-clip status — sample 9 corner+midpoint points
        // to classify the tile as ALL_IN / ALL_OUT / MIXED.  Saves the
        // per-pixel polygon test (1100 ops × ~250K-1M pixels per tile)
        // for the common case of fully-inland tiles.
        const lonMax = lonMin + TILE_BIN_DEG, latMax = latMin + TILE_BIN_DEG;
        let inHits = 0;
        for (let lo of [lonMin, (lonMin+lonMax)/2, lonMax]) {
          for (let la of [latMin, (latMin+latMax)/2, latMax]) {
            if (inSarawak(lo, la)) inHits++;
          }
        }
        const _inSarStatus = inHits === 9 ? 'all' : inHits === 0 ? 'none' : 'mixed';
        binCache.set(key, { n, lonMin, latMin, dx, dy, yr, cl, _inSarStatus });
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
  function buildViewportYearHist() {
    const CM = window.CLUSTER_META;
    if (!CM || !CM.clusters) return null;
    const tagOf = (cid) => cid === 255 ? 'outlier'
      : (CM.clusters[cid] && CM.clusters[cid].tag) || 'mixed';
    const isTopo = (cid) =>
      !!(CM.clusters[cid] && CM.clusters[cid].topo_flag);
    const hist = {};
    for (let y = 2015; y <= 2024; y++) hist[y] = {};
    const splitFrac = (typeof window.__baSplitX === 'number') ? window.__baSplitX : 0;
    const cx = lon2x(center[0], zoom), cy = lat2y(center[1], zoom);
    const halfW = W/2, halfH = H/2;
    const splitPx = splitFrac * W;
    const ul = pixelToLonLat(0, 0), br = pixelToLonLat(W, H);
    const lon0 = Math.min(ul[0], br[0]), lon1 = Math.max(ul[0], br[0]);
    const lat0 = Math.min(ul[1], br[1]), lat1 = Math.max(ul[1], br[1]);

    // Chip state (hiddenClusters) is NOT applied here — the stacked
    // histogram needs full per-group totals so its y-scale stays
    // stable; renderBars hides toggled-off groups via visibility attr.
    // Filtering here caused the "bars get fatter on toggle" issue.
    // Filter is data-driven: deforest tag, not topo. Sarawak clip is
    // applied per-hex in the loop below.
    const keepCid = (cid) => {
      if (cid === 255) return false;
      if (isTopo(cid)) return false;
      return tagOf(cid) === 'deforest';
    };

    if (zoom < HIST_PIXEL_SWITCH) {
      // Hex aggregate path. Each hex carries deforest_n (exact) and a
      // dominant cluster_id. Year is the hex-level median so the stack's
      // time axis is smeared for hexes that span multiple years, but the
      // TOTAL (what drives the "In view" hectare readout) is exact.
      const fine = window.SARAWAK_HEXES_FINE;
      const useFine = zoom >= HIST_HEX_FINE_SWITCH && fine && fine.length;
      // Coarse-zoom path reads SARAWAK_HEXES_COARSE directly (not the
      // globe `points` array, which strips hexes for visual reasons).
      // Hex tags + topo_flag + Sarawak polygon do all the filtering.
      // Include BOTH deforest- and mixed-tag hexes, Sarawak-only.
      // The bbox spills into Brunei/Sabah/Kalimantan — those should
      // not contribute to the "In view" hectare readout.
      let src;
      // _inSarawak is precomputed once on hex load (see index.html
      // tagHexesInSarawak) — replaces the per-frame polygon test which
      // ran ~1100 ops × N hexes per render frame.
      if (useFine) {
        src = [];
        for (const h of fine) {
          if (h.tag !== 'deforest' && h.tag !== 'mixed') continue;
          if (h._inSarawak === false) continue;
          src.push(h);
        }
      } else {
        const coarse = window.SARAWAK_HEXES_COARSE || [];
        src = [];
        for (const h of coarse) {
          if (h.tag !== 'deforest' && h.tag !== 'mixed') continue;
          if (h._inSarawak === false) continue;
          src.push(h);
        }
      }
      for (let i = 0; i < src.length; i++) {
        const h = src[i];
        if (h.lon < lon0 || h.lon > lon1) continue;
        if (h.lat < lat0 || h.lat > lat1) continue;
        if (splitPx > 0) {
          const sx = lon2x(h.lon, zoom) - cx + halfW;
          if (sx < splitPx) continue;
        }
        const year = h.y;
        if (hist[year] == null) continue;
        const nDef = h.deforest_n != null ? h.deforest_n : h.n;
        if (!nDef) continue;
        // For deforest-tag hexes, attribute to the dominant cluster's
        // chip via 'c<cid>' key (downstream buildBinData maps it via
        // GROUP_OF). For mixed-tag hexes the dominant cluster isn't in
        // any chip, so attribute directly to 'moderate' — these are
        // deforest-direction pixels just below the dominant-tag bar.
        const key = (h.tag === 'mixed') ? 'moderate' : ('c' + h.cluster_id);
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
          // At per-pixel zoom, prefer the per-pixel pick (looks up the
          // .bin tile dot under the cursor — gives the actual pixel's
          // cluster_id, not the hex's dominant). Fall back to hex pick
          // at lower zoom or if the per-pixel pick misses.
          let p = (zoom >= PIXEL_SWITCH_PICK) ? pickPixel(hoverEvt.clientX, hoverEvt.clientY) : null;
          if (!p) p = pick(hoverEvt.clientX, hoverEvt.clientY);
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
      if (onZoom) onZoom(zoom);
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

  // Per-pixel pick — at high zoom, find the dot in the .bin tile
  // under the cursor. Returns a synthetic point object compatible
  // with the rest of the pick callers, including cluster_id so the
  // spectrum panel can resolve it via CLUSTER_META[cid].
  const PIXEL_SWITCH_PICK = 12;
  const PICK_PIXEL_RADIUS = 14;   // search radius in screen pixels
  function pickPixel(clientX, clientY) {
    if (!binManifest) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const [lon, lat] = pixelToLonLat(mx, my);
    // Locate the .bin tile that contains (lon, lat).
    const ix = Math.floor((lon - TILE_LON_MIN) / TILE_BIN_DEG);
    const iy = Math.floor((lat - TILE_LAT_MIN) / TILE_BIN_DEG);
    if (ix < 0 || ix >= TILE_GRID_COLS || iy < 0 || iy >= TILE_GRID_ROWS) return null;
    const key = `iy${iy}_ix${ix}`;
    const tile = binCache.get(key);
    if (!tile) return null;            // not loaded — fall through
    const { n, lonMin, latMin, dx, dy, cl, yr } = tile;
    const tileInvScale = TILE_BIN_DEG / 65535;
    const cx = lon2x(center[0], zoom), cy = lat2y(center[1], zoom);
    const halfW = W/2, halfH = H/2;
    const r2max = PICK_PIXEL_RADIUS * PICK_PIXEL_RADIUS;
    let bestD = r2max, bestI = -1;
    // Lon/lat bbox around the cursor at the current zoom — used to skip
    // the per-pixel projection for far-away pixels.  Covers the pick
    // radius plus a bit of slack.  At zoom 16 with a 14-px radius this
    // window is ~0.0002° wide → ~99 % of the tile's pixels are skipped.
    const dlon = (PICK_PIXEL_RADIUS + 4) / (lon2x(180, zoom) - lon2x(-180, zoom)) * 360;
    const lonLo = lon - dlon, lonHi = lon + dlon;
    const latLo = lat - dlon, latHi = lat + dlon;   // dlon ≈ dlat at this lat
    const dxLo = (lonLo - lonMin) / tileInvScale;
    const dxHi = (lonHi - lonMin) / tileInvScale;
    const dyLo = (latLo - latMin) / tileInvScale;
    const dyHi = (latHi - latMin) / tileInvScale;
    for (let i = 0; i < n; i++) {
      if (cl[i] === 255) continue;       // outliers don't paint, skip pick
      const dxi = dx[i], dyi = dy[i];
      if (dxi < dxLo || dxi > dxHi) continue;
      if (dyi < dyLo || dyi > dyHi) continue;
      const plon = lonMin + dxi * tileInvScale;
      const plat = latMin + dyi * tileInvScale;
      const sx = lon2x(plon, zoom) - cx + halfW;
      const sy = lat2y(plat, zoom) - cy + halfH;
      const ddx = sx - mx, ddy = sy - my;
      const dd = ddx*ddx + ddy*ddy;
      if (dd < bestD) { bestD = dd; bestI = i; }
    }
    if (bestI < 0) return null;
    const plon = lonMin + dx[bestI] * tileInvScale;
    const plat = latMin + dy[bestI] * tileInvScale;
    return {
      lon: plon, lat: plat,
      cluster_id: cl[bestI],
      y: 2015 + yr[bestI],
      layer: 'pixel',
    };
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

    // Frame-constant projector — same arithmetic as lon2x / lat2y but
    // hoists Math.pow(2, zoom)*TILE_SIZE out of the per-hex loops below.
    // At fine zoom the hex render projects ~14 verts × 293K hexes per
    // frame; saving one Math.pow per call adds up.
    const _frameS  = Math.pow(2, zoom) * TILE_SIZE;
    const _frameCx = ((center[0] + 180) / 360) * _frameS;
    const _frameCy = (0.5 - Math.log((1+sLat)/(1-sLat)) / (4*Math.PI)) * _frameS;
    const _halfW = W/2, _halfH = H/2;
    const D2R = Math.PI / 180, INV4PI = 1 / (4*Math.PI);
    const projLonX = (lon) => ((lon + 180)/360)*_frameS - _frameCx + _halfW;
    const projLatY = (lat) => {
      const sl = Math.sin(lat * D2R);
      return (0.5 - Math.log((1+sl)/(1-sl)) * INV4PI) * _frameS - _frameCy + _halfH;
    };

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
    // 07_cluster_meta_refresh.py: within each tag, shades are rank-assigned by
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
    const isTopoCluster = (cid) =>
      !!(CM && CM.clusters && CM.clusters[cid] && CM.clusters[cid].topo_flag);
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
    // Per-pixel filter is now data-driven (no v1-era hardcoded id lists):
    //   - inSarawak()         drops Brunei/Sabah/Kalimantan
    //   - cluster.topo_flag   drops C-correction artefacts on >10° slopes
    //   - tag === 'deforest'  the only tag we paint
    //   - hiddenClusters      chip toggle
    if (zoom >= PIXEL_SWITCH) {
      // ── Per-pixel labelled layer — stream .bin tiles on demand ──────
      // Each tile has 6 B/pixel (dx, dy, yr, cl). cl = HDBSCAN cluster id
      // propagated to the full 643M set (see 08_propagate_labels.py +
      // 09_chunk_tiles.py). Outliers carry cl=255 and render in
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
        if (tile._inSarStatus === 'none') continue;     // whole tile outside
        const { n, lonMin, latMin, dx, dy, yr, cl } = tile;
        const hiddenClusters = window._hiddenClusters;
        const checkPerPx = tile._inSarStatus === 'mixed';
        for (let i = 0; i < n; i += stride) {
          const cid = cl[i];
          if (cid === 255) continue;                 // propagation outlier
          if (isTopoCluster(cid)) continue;          // topographic artefact
          if (tagOfCluster(cid) !== 'deforest') continue;
          if (hiddenClusters && hiddenClusters.has(cid)) continue;
          if (yr[i] < yrLoRel || yr[i] > yrHiRel) continue;
          const lon = lonMin + dx[i] * tileInvScale;
          const lat = latMin + dy[i] * tileInvScale;
          if (checkPerPx && !inSarawak(lon, lat)) continue;
          const sx = lon2x(lon, zoom) - cx + halfW;
          const sy = lat2y(lat, zoom) - cy + halfH;
          if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
          ctx.fillStyle = colorOfCluster(cid);
          ctx.globalAlpha = 0.82;
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    } else {
      // ── Hex layer (coarse or fine depending on zoom) ────────────────
      // Both coarse and fine arrive pre-classified (08_rebuild_hexes.py):
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
        // Sarawak-only clip applied to all tags (the scan bbox spills
        // into Brunei, Sabah, and Indonesian Kalimantan — those need
        // to be excluded from both display and counting).  v1-era
        // OCEAN_CLUSTERS + elev_m filters dropped (wrong for v3).
        hexSource = fine.filter(h => {
          if (h.tag !== 'deforest' && h.tag !== 'empty' && h.tag !== 'mixed') return false;
          return h._inSarawak !== false;     // cached at load
        });
        // Rank is computed per-frame against the viewport-visible subset
        // (see hexPolys block below), so the colour ramp re-spans 0-1 at
        // every zoom. The previous global rank made every visible hex
        // peg at the deep-red end whenever the viewport was a dense
        // sub-region of the full ~30K hex set.
        rankFn = null;   // placeholder — assigned after hexPolys is built
      } else {
        // Coarse zoom — Sarawak-only clip on every tag, same as fine.
        const coarse = window.SARAWAK_HEXES_COARSE || [];
        hexSource = coarse.filter(h => {
          if (h.tag !== 'deforest' && h.tag !== 'empty' && h.tag !== 'mixed') return false;
          return h._inSarawak !== false;     // cached at load
        });
        rankFn = null;   // viewport-relative rank assigned below
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
        const sx = projLonX(p.lon), sy = projLatY(p.lat);
        if (sx < -200 || sx > W+200 || sy < -200 || sy > H+200) continue;
        // _verts cached at hex-load time (see index.html
        // tagHexesInSarawak).  Falls back to a runtime h3 call if the
        // hex came from somewhere that didn't go through the cache.
        const verts = p._verts || (hasH3 && p.h3 ? window.h3.cellToBoundary(p.h3) : null);
        if (!verts) continue;
        const poly = new Array(verts.length);
        for (let j = 0; j < verts.length; j++) {
          const v = verts[j];
          poly[j] = [projLonX(v[1]), projLatY(v[0])];   // verts are [lat, lon]
        }
        hexPolys.push({ p, poly });
      }
      // If using the fine source (rankFn === null), rank ONLY the
      // colored deforest hexes that are in-viewport. The empty backdrop
      // hexes don't enter the ranking — they only paint as the pale fill.
      if (rankFn === null) {
        const colored = hexPolys
          .filter(({ p }) => p.tag === 'deforest')
          .map(({ p }) => p);
        const sorted = colored.slice().sort((a, b) => (a.n||0) - (b.n||0));
        const rankOf = new Map();
        const denom = Math.max(1, sorted.length - 1);
        for (let i = 0; i < sorted.length; i++) rankOf.set(sorted[i], i / denom);
        rankFn = (p) => rankOf.get(p) ?? 0;
      }
      const drawPoly = (poly) => {
        ctx.beginPath();
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (let j = 1; j < poly.length; j++) ctx.lineTo(poly[j][0], poly[j][1]);
        ctx.closePath();
      };
      // Pass 1 — pale-yellow backdrop for every land hex (empty / mixed
      // / deforest). Solid fill at 0.35 alpha — strong enough to read
      // as continuous land coverage so inland gaps look like "scan
      // covered, no detection here" instead of "missing data". No
      // stroke (the previous 0.32-stroke version made the grid pop
      // visually and competed with the deforest paint).
      ctx.fillStyle = BACKDROP_COLOR;
      ctx.globalAlpha = 0.35;
      for (const { poly } of hexPolys) { drawPoly(poly); ctx.fill(); }
      ctx.globalAlpha = 1;
      // Pass 2 — year-filtered coloured paint on top. Skip
      // backdrop-only hexes (empty / mixed) and year-out-of-range hexes.
      for (const { p, poly } of hexPolys) {
        if (p.tag === 'empty' || p.tag === 'mixed') continue;
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
    // Drive the bottom-right "Streaming detection tiles…" pill.  Visible
    // when at least one fetch is in flight; hidden as soon as the
    // viewport's pixel data is fully loaded.
    updateTilePill();
  }

  // Tile-stream pill driver.  Shown whenever binFetching is non-empty
  // AND we're at per-pixel zoom (where the user actually expects dots).
  function updateTilePill() {
    const pill = document.getElementById('tile-pill');
    if (!pill) return;
    const fetching = binFetching.size;
    const wantPixels = opened && zoom >= 12;
    if (wantPixels && fetching > 0) {
      pill.textContent = `Streaming detection tiles… ${fetching} fetching`;
      pill.classList.add('show');
    } else {
      pill.classList.remove('show');
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
      onZoom  = opts.onZoom  ?? null;
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
    getZoom: () => zoom,
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
      if (onZoom) onZoom(zoom);
      draw();
    },
    // Eagerly fetch *both* layers (.bin pixel tiles + Esri imagery
    // tiles) that will be visible at (center, zoom).  Used during
    // fly-in animations (Baram, place-search) and from setView so
    // network round-trips overlap the camera animation instead of
    // appearing as a blank/empty viewport on arrival.  Safe to call
    // before TileView.open() (no-op until manifest loaded).
    prefetch({ center: pc, zoom: pz }) {
      if (!Array.isArray(pc) || pc.length !== 2) return;
      const lon = pc[0], lat = pc[1];
      const targetZoom = (typeof pz === 'number') ? pz : 13.2;

      // ── Imagery tiles — Esri World Imagery, 256-px Web-Mercator. ──
      // The browser caches each tile's <img> in tileCache, so calling
      // getTile() now means by the time _draw() runs at the new
      // center/zoom the imagery is decoded and ready.
      const zInt = Math.floor(targetZoom);
      const cxImg = lon2x(lon, zInt), cyImg = lat2y(lat, zInt);
      // ±4 tiles ≈ 1024 px window — covers any reasonable viewport.
      const itx0 = Math.floor(cxImg / TILE_SIZE) - 4;
      const itx1 = Math.floor(cxImg / TILE_SIZE) + 4;
      const ity0 = Math.floor(cyImg / TILE_SIZE) - 4;
      const ity1 = Math.floor(cyImg / TILE_SIZE) + 4;
      const nTiles = Math.pow(2, zInt);
      for (let ty = ity0; ty <= ity1; ty++) {
        if (ty < 0 || ty >= nTiles) continue;
        for (let tx = itx0; tx <= itx1; tx++) {
          const tw = ((tx % nTiles) + nTiles) % nTiles;
          getTile(zInt, tw, ty);    // schedules <img> load if not cached
        }
      }

      // ── .bin per-pixel tiles — only matter at zoom ≥ 12. ──
      if (targetZoom < 12) return;
      if (!binManifest) loadBinManifest();
      // ±2 .bin tiles = ±0.2° = ~22 km around target.  Covers any
      // reasonable viewport at zoom 12+.
      const ix0 = Math.max(0, Math.floor((lon - TILE_LON_MIN - 2*TILE_BIN_DEG) / TILE_BIN_DEG));
      const ix1 = Math.min(TILE_GRID_COLS - 1, Math.floor((lon - TILE_LON_MIN + 2*TILE_BIN_DEG) / TILE_BIN_DEG));
      const iy0 = Math.max(0, Math.floor((lat - TILE_LAT_MIN - 2*TILE_BIN_DEG) / TILE_BIN_DEG));
      const iy1 = Math.min(TILE_GRID_ROWS - 1, Math.floor((lat - TILE_LAT_MIN + 2*TILE_BIN_DEG) / TILE_BIN_DEG));
      const kick = () => {
        for (let iy = iy0; iy <= iy1; iy++) {
          for (let ix = ix0; ix <= ix1; ix++) fetchBinTile(iy, ix);
        }
        updateTilePill();
      };
      if (binManifest) kick();
      else if (loadBinManifest._pending) loadBinManifest._pending.then(kick);
    },
    // Programmatic re-centre — used by the place-search box. Snaps to
    // (lon, lat) at the requested zoom (default keeps current zoom).
    setView({ center: c, zoom: z }) {
      if (Array.isArray(c) && c.length === 2) {
        center = [c[0], c[1]];
      }
      if (typeof z === 'number') {
        zoom = Math.max(3, Math.min(18, z));
        if (onZoom) onZoom(zoom);
      }
      draw();
    },
  };
})();
