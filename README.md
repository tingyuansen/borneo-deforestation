# Borneo, in pixels

Interactive 3D globe visualisation of a decade of canopy change in northern Sarawak, Borneo — every dot is one Sentinel-2 pixel that changed between 2015 and 2024. Rotate the globe, fly in to the pilot tile, scrub the timeline, and explore the clusters.

## Public data only

Nothing in this repository is sensitive or proprietary. All change-detection data is derived from the [ESA/Copernicus Sentinel-2](https://sentiwiki.copernicus.eu/web/s2-mission) open-data archive; satellite basemap tiles are served from [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9).

## Running locally

The site is a static HTML/CSS/JS bundle with no build step. Because `fetch()` refuses `file://` URLs, serve it over HTTP:

```bash
python3 -m http.server 8765
```

Then open <http://127.0.0.1:8765/>.

## Live demo

https://tingyuansen.github.io/borneo-deforestation/

## Stack

- [Three.js](https://threejs.org/) — 3D globe with NASA Blue Marble texture, custom shader for sphere-gated 47k-point cloud
- [D3](https://d3js.org/) — stacked-area timeline, UMAP scatter, brushes
- Esri ArcGIS World Imagery — slippy-map tiles for the 2D pilot view
- Vanilla JS, no bundler
