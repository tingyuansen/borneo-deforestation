# Borneo, in pixels

Interactive dashboard of a decade of canopy change in northern Sarawak, Borneo. Each detection is a Sentinel-2 pixel (10 m) that flipped between 2015 and 2024; the site lets you rotate the globe, fly into the Baram pilot tile, scrub the timeline, toggle severity classes, and zoom to per-pixel detail.

Live demo: <https://tingyuansen.github.io/borneo-deforestation/>

## What you see

### Globe view
- NASA Blue Marble-style Earth (three-globe CDN texture, procedural fallback).
- ~46 k H3 res-7 hexes painted over Sarawak, colored by deforest-density rank.
- Rotate disabled; a click anywhere on the globe flies into Baram.

### Tile view (fly-in)
- Esri "World Imagery" satellite basemap as a Web-Mercator slippy map (no API key; attribution printed on canvas).
- Three-tier LOD tied to zoom:
  - `zoom < 10`  → res-7 hex layer (already loaded with the globe).
  - `10 ≤ zoom < 12`  → res-8 fine hexes (~293 k, lazy-loaded once).
  - `zoom ≥ 12`  → per-pixel dots streamed from `data/tiles/2of3/tile_iy*_ix*.bin` (see "Pixel tiles" below).
- A pale-yellow hex backdrop always paints under the colored paint, so the grid is present even when the year filter hides all colored hexes.
- Before/after slider clips the detection overlay to the right of the handle; the histogram counts only what's still visible.

### Timeline + chips + counters
- Stacked-area histogram (D3) with three layers matching the three chips:
  - **Bare-soil clearing** (`#9d6f3a`) — full canopy loss to dry mineral soil; deepest spectral footprint.
  - **Canopy clearing** (`#d4a661`) — typical canopy loss with mixed surface response.
  - **Wet-substrate clearing** (`#14d4a4`) — clearing on damp ground (peat, swamp, slash-and-burn in wet conditions, palm planting on moist soil).
- Chip categories are partitioned from each cluster's reconstructed canonical Δ-color (Δ-NDVI, Δ-gNDWI, Δ-NBR computed at boot from `cluster_meta.mean_pre / mean_post`); topographic-illumination clusters and clusters with no real ΔNDVI drop are excluded.
- Brush = year-range filter (2015–2024, fractional); applied live to globe + tile-view layers.
- `y`-axis ceiling is computed from all three groups together, so toggling a chip hides its layer without rescaling the chart.
- "In view" hectare counter updates from the tile-view viewport (hex aggregate at low zoom, `.bin` streaming at close zoom).

## Data layout

All files live under `data/`:

| File | Size | Purpose |
| --- | --- | --- |
| `manifest.json` | < 1 kB | Top-level region + rule meta (`region`, `bbox`, `detection_rule`). |
| `sarawak_cluster_meta.json` | 24 kB | 19 HDBSCAN clusters with `id`, `tag`, `color`, `n`, `year_hist`. |
| `sarawak_hexes_2of3_res7.json` | 8.3 MB | 45 745 coarse hexes for the globe layer. |
| `sarawak_hexes_2of3_res8.json` | 53 MB | 293 324 fine hexes for mid-zoom (lazy-loaded). |
| `tiles/2of3/manifest.json` | 200 kB | Per-tile pixel-count index. |
| `tiles/2of3/tile_iy*_ix*.bin` | 2.6 GB (2 378 files) | 0.1° × 0.1° binary pixel tiles. Each is `n:u32` + `lon_min,lat_min:f32` + `dx:u16[n] | dy:u16[n] | year:u8[n] | cluster_id:u8[n]`. `cluster_id == 255` marks outliers. |

The full 643 M-pixel detection set is stored as the `.bin` tiles. Hex JSONs are pre-aggregated roll-ups of those same pixels, for fast low-zoom rendering.

## Running locally

Static HTML + JS, no build step. `fetch()` refuses `file://`, so serve over HTTP:

```bash
cd borneo_deforestation
python3 -m http.server 8765
# → http://127.0.0.1:8765/
```

All code dependencies are loaded from CDNs at runtime:
- [Three.js 0.160.0](https://unpkg.com/three@0.160.0/build/three.min.js) — globe.
- [D3 v7](https://d3js.org/d3.v7.min.js) — histogram, brush.
- [h3-js 4.1.0](https://unpkg.com/h3-js@4.1.0) — hex boundaries in tile view.

No npm install, no bundler.

## File map

```
borneo_deforestation/
├── index.html        # Main page: DOM, CSS, globe boot, chips, histogram, filter state
├── globe.js          # Three.js globe: blue-marble texture, sphere-gated point shader, orbit
├── tile-view.js      # Esri slippy map + hex / pixel LOD + .bin streaming + viewport hist
├── README.md         # This file
└── data/             # See table above
```

## Deployment

GitHub Pages serves the repo contents verbatim at the `Live demo` URL. The `.bin` tile directory (2.6 GB) exceeds GitHub's size guidance; if it's not committed, the site still renders the globe and hex layers, but the per-pixel zoom ≥ 12 layer will be empty. Upload the `tiles/` tree to a CDN (or enable Git LFS with a paid bandwidth tier) and point `BIN_BASE` in `tile-view.js` at it if you need the pixel layer on the live site.

## Data provenance

All change-detection data is derived from the [ESA/Copernicus Sentinel-2](https://sentiwiki.copernicus.eu/web/s2-mission) open-data archive. Satellite basemap tiles in the tile view come from [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9). Blue Marble globe texture via [three-globe](https://github.com/vasturiano/three-globe). Nothing in this repository is sensitive or proprietary.

The upstream detection + clustering pipeline (change-point detection, HDBSCAN over spectral deltas, H3 roll-ups, slope + elevation masking) lives in a separate research repo (`Sentinel_Sarawak/sarawak/scripts/`); the artefacts checked into `data/` here are its frozen outputs.
