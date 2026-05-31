# Borneo, in pixels

Interactive dashboard accompanying Ting & Moortgat (2026), *Most canopy disturbance in Sarawak is partial, widespread, and invisible to global forest-change products: evidence from a calibrated 10 m Sentinel-2 archive (2015–2024)*, submitted to *Remote Sensing of Environment*.

Each detection on the map is a Sentinel-2 pixel (10 m × 10 m) that flipped between 2015 and 2024. The dashboard lets you rotate the globe, fly into Sarawak, scrub the timeline, toggle clearing-type chips, and zoom from regional rollups to per-pixel detail.

Live demo: <https://tingyuansen.github.io/borneo-deforestation/>

Paper repo (pipeline + reproducibility): <https://github.com/tingyuansen/sentinel-sarawak>

## What you see

### Globe view
- NASA Blue Marble-style Earth.
- ~46 k H3 res-7 hexes painted over Sarawak, coloured by detection density.
- A click anywhere on the globe flies into the tile view.

### Tile view (fly-in)
- Esri "World Imagery" satellite basemap as a Web-Mercator slippy map.
- Three-tier level of detail tied to zoom:
  - `zoom < 10`  → res-7 hex layer (≈ 46 k hexes).
  - `10 ≤ zoom < 12`  → res-8 fine hexes (≈ 293 k, lazy-loaded once).
  - `zoom ≥ 12`  → per-pixel dots streamed from `data/tiles/2of3/tile_iy*_ix*.bin`.
- Pale-yellow hex backdrop paints under the coloured detection layer, so the grid is present even when the year filter hides all coloured hexes.
- Before/after slider clips the detection overlay to the right of the handle; the histogram counts only what is still visible.

### Timeline + chips + counters
- Stacked-area histogram (D3) with three layers, one per chip:
  - **Bare-soil clearing** (`#9d6f3a`) — full canopy loss to dry mineral soil; deepest spectral footprint.
  - **Canopy clearing** (`#d4a661`) — typical canopy loss with mixed surface response.
  - **Wet-substrate clearing** (`#14d4a4`) — clearing on damp ground (peat, swamp, slash-and-burn in wet conditions).
- Chip assignment per cluster is the same rule as the paper (`analysis/validation/calibrated_archive.chip_for_cluster`): partition each cluster's reconstructed canonical Δ-colour (Δ-NDVI, Δ-gNDWI, Δ-NBR computed at boot from `cluster_meta.mean_pre` / `mean_post`). Clusters with `Δ-NDVI > -0.05` are flagged "other" and excluded from all three chips. This dashboard ships 18 chip-mapped clusters (12 canopy, 3 bare-soil, 3 wet-substrate) and 4 "other".
- Brush = year-range filter (2015–2024, fractional); applied live to globe and tile-view layers.
- "In view" hectare counter updates from the tile-view viewport (hex aggregate at low zoom, per-pixel binary tiles at close zoom).

## Data layout

All files live under `data/`:

| File | Size | Purpose |
| --- | --- | --- |
| `manifest.json` | < 1 kB | Top-level region + rule metadata. |
| `sarawak_cluster_meta.json` | 17 kB | 22 HDBSCAN clusters with `id`, `n`, `year_hist`, `mean_pre`, `mean_post`. |
| `sarawak_hexes_2of3_res7.json` | 8.3 MB | 45 745 coarse hexes for the globe layer. |
| `sarawak_hexes_2of3_res8.json` | 53 MB | 293 324 fine hexes for mid-zoom (lazy-loaded). |
| `pca_flow_sample.json` | 145 kB | 1500 stratified PC-space pixel samples for the flow-tube visualisation. |
| `tiles/2of3/manifest.json` | 200 kB | Per-tile pixel-count index. |
| `tiles/2of3/tile_iy*_ix*.bin` | 2.6 GB (2378 files) | 0.1° × 0.1° binary pixel tiles. Each file encodes `n:u32` + `lon_min,lat_min:f32` + `dx:u16[n] \| dy:u16[n] \| year:u8[n] \| cluster_id:u8[n]`. `cluster_id == 255` marks outliers. |

The full 643 M-pixel detection set is the `.bin` tiles. Hex JSONs are pre-aggregated rollups for fast low-zoom rendering.

## Running locally

Static HTML + JS, no build step. `fetch()` refuses `file://`, so serve over HTTP:

```bash
cd borneo-deforestation
python3 -m http.server 8765
# → http://127.0.0.1:8765/
```

Runtime dependencies load from CDNs:
- [Three.js 0.160.0](https://unpkg.com/three@0.160.0/build/three.min.js) — globe.
- [D3 v7](https://d3js.org/d3.v7.min.js) — histogram, brush.
- [h3-js 4.1.0](https://unpkg.com/h3-js@4.1.0) — hex boundaries in tile view.

No npm install, no bundler.

## File map

```
borneo-deforestation/
├── index.html        # DOM, CSS, globe boot, chips, histogram, filter state
├── globe.js          # Three.js globe: Blue-Marble texture, sphere-gated point shader, orbit
├── tile-view.js      # Esri slippy map + hex / pixel LOD + .bin streaming + viewport hist
├── flow-panel.js     # 3-D PC-space flow tubes (one per chip)
└── data/             # See table above
```

## Deployment

GitHub Pages serves the repo contents verbatim at the live-demo URL. The `.bin` tile directory (2.6 GB) exceeds GitHub's size guidance; if it is not committed, the site still renders the globe and hex layers, but the per-pixel layer (`zoom ≥ 12`) is empty. Upload the `tiles/` tree to a CDN (or enable Git LFS with a paid bandwidth tier) and point `BIN_BASE` in `tile-view.js` at it to re-enable the pixel layer.

## Data provenance

All change-detection data is derived from the [ESA/Copernicus Sentinel-2](https://sentiwiki.copernicus.eu/web/s2-mission) open-data archive. Satellite basemap tiles in the tile view come from [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9). Blue Marble globe texture via [three-globe](https://github.com/vasturiano/three-globe).

The upstream detection, clustering, and calibration pipeline lives in <https://github.com/tingyuansen/sentinel-sarawak>; the artefacts checked into `data/` here are its frozen outputs. The full per-pixel archive (≈ 3.7 GB) is released as a Zenodo bundle (DOI at publication time).

## Citation

If you use the dashboard or its data, please cite the paper and the Zenodo DOI.

## License

MIT for code. The per-pixel archive on Zenodo is released under CC-BY-4.0.
