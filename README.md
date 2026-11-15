# MarsMapper
Mapping Mars for NASA Space Apps

## MVP quick start

This repo renders NASA Mars Trek's public WMTS imagery directly in an interactive map.

1. From the repo root, run `python3 -m venv .venv`, then `.venv/bin/pip install -r requirements.txt`, and finally `.venv/bin/python server.py` in one terminal.
2. In a second terminal, run `cd client && npm install && npm run dev`.
3. Open the local URL Vite prints, normally http://localhost:5173.

The local API reads Mars terrain from the MySQL database configured in `config.ini`
and serves elevation lookups at `/api/elevation` plus slope-aware A* routes at
`/api/route`. Route queries load only a bounded elevation-grid window around the
selected points. Routes are coarse terrain comparisons, not navigation guidance.

The map uses NASA's Viking VIS Global Color Mosaic equirectangular tile matrix
(`EPSG:104905`, `default028mm`), not a Mars Trek iframe or redirect.
