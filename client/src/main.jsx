import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const TILE_URL =
  'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg';
const MIN_ZOOM = 2;
const MAX_ZOOM = 7;

function worldSize(zoom) {
  // NASA EPSG:104905 level 0 is two columns by one row, not a square XYZ world.
  return { width: 512 * 2 ** zoom, height: 256 * 2 ** zoom };
}

function constrain(view, element) {
  const { width, height } = worldSize(view.zoom);
  return {
    ...view,
    x: Math.min(0, Math.max(element.clientWidth - width, view.x)),
    y: Math.min(0, Math.max(element.clientHeight - height, view.y)),
  };
}

function MarsMap() {
  const mapRef = useRef(null);
  const dragRef = useRef(null);
  const [view, setView] = useState({ zoom: MIN_ZOOM, x: 0, y: 0 });
  const [tileError, setTileError] = useState('');

  useEffect(() => {
    const element = mapRef.current;
    const centerInitialView = () => {
      const { width, height } = worldSize(MIN_ZOOM);
      setView({ zoom: MIN_ZOOM, x: (element.clientWidth - width) / 2, y: (element.clientHeight - height) / 2 });
    };

    centerInitialView();
    const observer = new ResizeObserver(() => setView((current) => constrain(current, element)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const zoomAtCenter = (nextZoom) => {
    const element = mapRef.current;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    if (zoom === view.zoom) return;

    const scale = 2 ** (zoom - view.zoom);
    setView(constrain({
      zoom,
      x: element.clientWidth / 2 - (element.clientWidth / 2 - view.x) * scale,
      y: element.clientHeight / 2 - (element.clientHeight / 2 - view.y) * scale,
    }, element));
  };

  const startDrag = (event) => {
    dragRef.current = { x: event.clientX, y: event.clientY, view };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drag = (event) => {
    if (!dragRef.current) return;
    const { x, y, view: startView } = dragRef.current;
    setView(constrain({
      ...startView,
      x: startView.x + event.clientX - x,
      y: startView.y + event.clientY - y,
    }, mapRef.current));
  };

  const { width, height } = worldSize(view.zoom);
  const firstCol = Math.max(0, Math.floor(-view.x / 256));
  const lastCol = Math.min(width / 256 - 1, Math.ceil((mapRef.current?.clientWidth - view.x) / 256));
  const firstRow = Math.max(0, Math.floor(-view.y / 256));
  const lastRow = Math.min(height / 256 - 1, Math.ceil((mapRef.current?.clientHeight - view.y) / 256));
  const tiles = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      const src = TILE_URL.replace('{z}', view.zoom).replace('{y}', row).replace('{x}', col);
      tiles.push(
        <img
          alt=""
          className="mars-tile"
          key={src}
          onError={() => setTileError(`NASA WMTS tile failed to load: ${src}`)}
          src={src}
          style={{ transform: `translate(${view.x + col * 256}px, ${view.y + row * 256}px)` }}
        />,
      );
    }
  }

  return (
    <main
      aria-label="Interactive map of Mars"
      id="mars-map"
      onPointerDown={startDrag}
      onPointerMove={drag}
      onPointerUp={() => { dragRef.current = null; }}
      ref={mapRef}
      tabIndex="0"
    >
      {tiles}
      <div className="zoom-controls" aria-label="Map zoom controls" onPointerDown={(event) => event.stopPropagation()}>
        <button aria-label="Zoom in" disabled={view.zoom === MAX_ZOOM} onClick={() => zoomAtCenter(view.zoom + 1)} type="button">+</button>
        <button aria-label="Zoom out" disabled={view.zoom === MIN_ZOOM} onClick={() => zoomAtCenter(view.zoom - 1)} type="button">-</button>
      </div>
      {tileError && <p id="tile-error" role="alert">{tileError}</p>}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<MarsMap />);
