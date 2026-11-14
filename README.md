# MarsMapper
Mapping Mars for NASA Space Apps

## MVP quick start

This repo renders NASA Mars Trek's public WMTS imagery directly in an interactive map.

1. From the repo root, run:
   `cd client && npm install && npm run dev`
2. Open the local URL Vite prints, normally http://localhost:5173
3. Pan the map and use the `+` and `-` controls to zoom.

The map uses NASA's Viking VIS Global Color Mosaic equirectangular tile matrix
(`EPSG:104905`, `default028mm`), not a Mars Trek iframe or redirect.
