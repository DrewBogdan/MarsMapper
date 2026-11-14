import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const TILE_URL =
  'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg';
const MIN_ZOOM = 2;
const MAX_ZOOM = 7;
const LOCATION_ZOOM = 5;
const ELEVATION_BOUNDS = {
  minLatitude: 17.70703125,
  maxLatitude: 18.95703125,
  minLongitude: 226.11328125,
  maxLongitude: 227.48828125,
};

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

function parseElevationSamples(csv) {
  return csv.trim().split('\n').slice(1).map((line) => {
    const [, latitude, longitude, elevation] = line.split(',');
    return { latitude: Number(latitude), longitude: Number(longitude), elevation: Number(elevation) };
  });
}

function findNearestSample(samples, latitude, longitude) {
  return samples.reduce((nearest, sample) => {
    const distance = (sample.latitude - latitude) ** 2 + (sample.longitude - longitude) ** 2;
    return !nearest || distance < nearest.distance ? { sample, distance } : nearest;
  }, null)?.sample;
}

function MarsMap() {
  const mapRef = useRef(null);
  const dragRef = useRef(null);
  const [view, setView] = useState({ zoom: MIN_ZOOM, x: 0, y: 0 });
  const [tileError, setTileError] = useState('');
  const [longitude, setLongitude] = useState('');
  const [latitude, setLatitude] = useState('');
  const [locationError, setLocationError] = useState('');
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [elevationSamples, setElevationSamples] = useState([]);
  const [elevationError, setElevationError] = useState('');

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

  useEffect(() => {
    fetch('/mars-polygon.csv')
      .then((response) => {
        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        return response.text();
      })
      .then((csv) => setElevationSamples(parseElevationSamples(csv)))
      .catch((error) => setElevationError(error.message));
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
    dragRef.current = { x: event.clientX, y: event.clientY, view, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drag = (event) => {
    if (!dragRef.current) return;
    const { x, y, view: startView } = dragRef.current;
    if (Math.hypot(event.clientX - x, event.clientY - y) > 4) dragRef.current.moved = true;
    setView(constrain({
      ...startView,
      x: startView.x + event.clientX - x,
      y: startView.y + event.clientY - y,
    }, mapRef.current));
  };

  const selectMapLocation = (event) => {
    const element = mapRef.current;
    const bounds = element.getBoundingClientRect();
    const { width, height } = worldSize(view.zoom);
    const pointX = event.clientX - bounds.left - view.x;
    const pointY = event.clientY - bounds.top - view.y;
    const matrixLongitude = (pointX / width) * 360 - 180;
    const lng = matrixLongitude < 0 ? matrixLongitude + 360 : matrixLongitude;
    const lat = 90 - (pointY / height) * 180;

    if (lat < -90 || lat > 90 || lng < 0 || lng > 360) return;
    setLocationError('');
    setLongitude(lng.toFixed(6));
    setLatitude(lat.toFixed(6));
    setSelectedLocation({ lng, lat, matrixLongitude });
  };

  const endDrag = (event) => {
    const dragState = dragRef.current;
    dragRef.current = null;
    if (dragState && !dragState.moved) selectMapLocation(event);
  };

  const selectLocation = (event) => {
    event.preventDefault();
    const lng = Number(longitude);
    const lat = Number(latitude);
    if (!longitude.trim() || !latitude.trim() || !Number.isFinite(lng) || !Number.isFinite(lat) || lng < 0 || lng > 360 || lat < -90 || lat > 90) {
      setLocationError('Enter areocentric longitude from 0 to 360 and latitude from -90 to 90.');
      return;
    }

    const element = mapRef.current;
    const { width, height } = worldSize(LOCATION_ZOOM);
    // NASA's matrix spans -180 to 180 while entered areocentric longitude is 0 to 360 east.
    const matrixLongitude = lng > 180 ? lng - 360 : lng;
    // Normalize areocentric degrees into NASA's equirectangular tile matrix.
    const pointX = ((matrixLongitude + 180) / 360) * width;
    const pointY = ((90 - lat) / 180) * height;
    setLocationError('');
    setSelectedLocation({ lng, lat, matrixLongitude });
    setView(constrain({
      zoom: LOCATION_ZOOM,
      x: element.clientWidth / 2 - pointX,
      y: element.clientHeight / 2 - pointY,
    }, element));
  };

  const { width, height } = worldSize(view.zoom);
  const firstCol = Math.max(0, Math.floor(-view.x / 256));
  const lastCol = Math.min(width / 256 - 1, Math.ceil((mapRef.current?.clientWidth - view.x) / 256));
  const firstRow = Math.max(0, Math.floor(-view.y / 256));
  const lastRow = Math.min(height / 256 - 1, Math.ceil((mapRef.current?.clientHeight - view.y) / 256));
  const tiles = [];
  let marker;

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

  if (selectedLocation) {
    const markerX = ((selectedLocation.matrixLongitude + 180) / 360) * width + view.x;
    const markerY = ((90 - selectedLocation.lat) / 180) * height + view.y;
    marker = <span aria-label="Selected location" className="location-marker" style={{ transform: `translate(${markerX}px, ${markerY}px)` }} />;
  }

  const hasElevationCoverage = selectedLocation
    && selectedLocation.lat >= ELEVATION_BOUNDS.minLatitude
    && selectedLocation.lat <= ELEVATION_BOUNDS.maxLatitude
    && selectedLocation.lng >= ELEVATION_BOUNDS.minLongitude
    && selectedLocation.lng <= ELEVATION_BOUNDS.maxLongitude;
  const elevationSample = hasElevationCoverage && elevationSamples.length
    ? findNearestSample(elevationSamples, selectedLocation.lat, selectedLocation.lng)
    : null;

  return (
    <main
      aria-label="Interactive map of Mars"
      id="mars-map"
      onPointerDown={startDrag}
      onPointerMove={drag}
      onPointerUp={endDrag}
      ref={mapRef}
      tabIndex="0"
    >
      {tiles}
      {marker}
      <form className="location-form" onPointerDown={(event) => event.stopPropagation()} onSubmit={selectLocation}>
        <label>
          Areocentric longitude
          <input inputMode="decimal" max="360" min="0" onChange={(event) => setLongitude(event.target.value)} placeholder="0" step="any" type="number" value={longitude} />
        </label>
        <label>
          Areocentric latitude
          <input inputMode="decimal" max="90" min="-90" onChange={(event) => setLatitude(event.target.value)} placeholder="0" step="any" type="number" value={latitude} />
        </label>
        <button type="submit">Locate</button>
        {locationError && <p className="location-error" role="alert">{locationError}</p>}
      </form>
      <div className="zoom-controls" aria-label="Map zoom controls" onPointerDown={(event) => event.stopPropagation()}>
        <button aria-label="Zoom in" disabled={view.zoom === MAX_ZOOM} onClick={() => zoomAtCenter(view.zoom + 1)} type="button">+</button>
        <button aria-label="Zoom out" disabled={view.zoom === MIN_ZOOM} onClick={() => zoomAtCenter(view.zoom - 1)} type="button">-</button>
      </div>
      {selectedLocation && (
        <section className="location-info" onPointerDown={(event) => event.stopPropagation()}>
          <strong>
            Areocentric: {Math.abs(selectedLocation.lat).toFixed(5)}{selectedLocation.lat < 0 ? 'S' : 'N'}, {selectedLocation.lng.toFixed(5)}E
          </strong>
          {elevationError && <span>Elevation data failed to load: {elevationError}</span>}
          {!elevationError && !elevationSamples.length && <span>Loading elevation data...</span>}
          {!elevationError && elevationSamples.length && !elevationSample && <span>No elevation sample is available at this location.</span>}
          {elevationSample && <span>MOLA 128ppd elevation: {elevationSample.elevation.toLocaleString()} m</span>}
        </section>
      )}
      {tileError && <p id="tile-error" role="alert">{tileError}</p>}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<MarsMap />);
