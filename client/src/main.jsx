import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import hydrousSitesCsv from '../../data/hydrous_sites_geo_map.csv?raw';
import './styles.css';

const MAP_LAYERS = {
  color: {
    label: 'Color imagery',
    maxNativeZoom: 7,
    url: 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
  },
  roughness: {
    label: 'Surface roughness',
    maxNativeZoom: 1,
    url: 'https://trek.nasa.gov/tiles/Mars/EQ/mola_roughness/1.0.0/default/default028mm/{z}/{y}/{x}.png',
  },
  thermalInertia: {
    label: 'Thermal inertia',
    maxNativeZoom: 1,
    url: 'https://trek.nasa.gov/tiles/Mars/EQ/TES_Thermal_Inertia/1.0.0/default/default028mm/{z}/{y}/{x}.png',
  },
  dustCoverage: {
    label: 'Dust coverage',
    maxNativeZoom: 1,
    url: 'https://trek.nasa.gov/tiles/Mars/EQ/TES_Dust/1.0.0/default/default028mm/{z}/{y}/{x}.png',
  },
};
const MIN_ZOOM = 2;
const MAX_ZOOM = 9;
const INSPECTION_ZOOM = 5;
const MARS_RADIUS_KM = 3390;
const ROUTE_POI_CORRIDOR_KM = 5;
const DEFAULT_ROVER_SPEED_KPH = 0.1;
const DEFAULT_DRIVING_HOURS_PER_SOL = 4;
const GEO_FEATURES_URL = 'https://geocode.openspaceproject.com/1/list/mars';
const GEO_FEATURES_CACHE_KEY = 'mars-geological-features-v1';
const FOCUS_BOUNDS = {
  minLatitude: 0,
  maxLatitude: 40,
  // This 187E west edge (-173 in NASA's -180 to 180 matrix) leaves room west of -163.
  minLongitude: 187,
  maxLongitude: 290,
};

function normalizeMatrixLongitude(longitude) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function parseHydrousSites(csv) {
  const rows = csv.trim().split(/\r?\n/).map((line) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')));
  if (rows.length === 0) return [];

  const headers = rows[0].map((header) => header.toLowerCase());
  const hasHeader = !Number.isFinite(Number(headers[0]));
  const indexFor = (name, fallback) => hasHeader ? headers.findIndex((header) => header.includes(name)) : fallback;
  const longitudeIndex = indexFor('longitude', 0);
  const latitudeIndex = indexFor('latitude', 1);
  const omegaIndex = indexFor('omega', 2);
  const crismIndex = indexFor('crism', 3);
  const sourceIndex = indexFor('source', 2);
  const siteIdIndex = indexFor('site_id', 3);

  return rows.slice(hasHeader ? 1 : 0).flatMap((row, index) => {
    const longitude = Number(row[longitudeIndex]);
    const latitude = Number(row[latitudeIndex]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 360 || latitude < -90 || latitude > 90) return [];

    const source = row[sourceIndex] ?? '';
    const siteId = row[siteIdIndex] ?? '';
    const explicitOmega = omegaIndex >= 0 ? row[omegaIndex] : '';
    const explicitCrism = crismIndex >= 0 ? row[crismIndex] : '';
    const unlabelledIds = [source, siteId].filter(Boolean);
    const fallbackCrism = unlabelledIds.find((id) => /^FRT|^HRL|^HRS|^FRS/i.test(id)) ?? '';
    const fallbackOmega = unlabelledIds.find((id) => id !== fallbackCrism) ?? '';
    return [{
      id: `${index}-${normalizeMatrixLongitude(longitude)}-${latitude}`,
      latitude,
      longitude: normalizeMatrixLongitude(longitude),
      omegaProductId: explicitOmega || fallbackOmega,
      crismProductId: explicitCrism || fallbackCrism,
    }];
  });
}

function parseGeologicalFeatures(payload) {
  if (!Array.isArray(payload?.result)) throw new Error('OpenSpace returned an invalid feature list.');
  return payload.result.flatMap((feature, index) => {
    const latitude = Number(feature.CenterLatitude);
    const longitude = Number(feature.CenterLongitude);
    const name = typeof feature.FeatureName === 'string' ? feature.FeatureName.trim() : '';
    const type = typeof feature.FeatureType === 'string' ? feature.FeatureType.trim() : '';
    if (!name || !type || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || Math.abs(longitude) > 360) return [];
    return [{
      id: `geological-${index}-${name}`,
      name,
      type,
      latitude,
      longitude: normalizeMatrixLongitude(longitude),
    }];
  });
}

function surfaceDistanceKm(first, second) {
  const latitudeDifference = ((second.latitude - first.latitude) * Math.PI) / 180;
  const longitudeDifference = (normalizeMatrixLongitude(second.longitude - first.longitude) * Math.PI) / 180;
  const a = Math.sin(latitudeDifference / 2) ** 2
    + Math.cos((first.latitude * Math.PI) / 180) * Math.cos((second.latitude * Math.PI) / 180) * Math.sin(longitudeDifference / 2) ** 2;
  return MARS_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function radians(value) {
  return (value * Math.PI) / 180;
}

function initialBearing(first, second) {
  const longitudeDifference = radians(normalizeMatrixLongitude(second.longitude - first.longitude));
  const firstLatitude = radians(first.latitude);
  const secondLatitude = radians(second.latitude);
  return Math.atan2(
    Math.sin(longitudeDifference) * Math.cos(secondLatitude),
    Math.cos(firstLatitude) * Math.sin(secondLatitude) - Math.sin(firstLatitude) * Math.cos(secondLatitude) * Math.cos(longitudeDifference),
  );
}

function distanceToRouteKm(point, path) {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return surfaceDistanceKm(point, path[0]);
  return path.slice(0, -1).reduce((nearest, start, index) => {
    const end = path[index + 1];
    const segmentDistance = surfaceDistanceKm(start, end) / MARS_RADIUS_KM;
    const startDistance = surfaceDistanceKm(start, point) / MARS_RADIUS_KM;
    if (segmentDistance === 0) return Math.min(nearest, startDistance * MARS_RADIUS_KM);
    const crossTrack = Math.asin(Math.sin(startDistance) * Math.sin(initialBearing(start, point) - initialBearing(start, end)));
    const alongTrack = Math.atan2(
      Math.sin(startDistance) * Math.cos(initialBearing(start, point) - initialBearing(start, end)),
      Math.cos(startDistance),
    );
    const distance = alongTrack >= 0 && alongTrack <= segmentDistance
      ? Math.abs(crossTrack) * MARS_RADIUS_KM
      : Math.min(surfaceDistanceKm(point, start), surfaceDistanceKm(point, end));
    return Math.min(nearest, distance);
  }, Infinity);
}

function coordinateLabel(latitude, longitude) {
  return `${Math.abs(latitude).toFixed(2)}°${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(2)}°${longitude < 0 ? 'W' : 'E'}`;
}

async function readApiResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }
  return payload;
}

function worldSize(zoom) {
  // NASA EPSG:104905 level 0 is two columns by one row, not a square XYZ world.
  return { width: 512 * 2 ** zoom, height: 256 * 2 ** zoom };
}

function matrixLongitude(longitude) {
  return longitude > 180 ? longitude - 360 : longitude;
}

function focusPixels(zoom) {
  const { width, height } = worldSize(zoom);
  return {
    left: ((matrixLongitude(FOCUS_BOUNDS.minLongitude) + 180) / 360) * width,
    right: ((matrixLongitude(FOCUS_BOUNDS.maxLongitude) + 180) / 360) * width,
    top: ((90 - FOCUS_BOUNDS.maxLatitude) / 180) * height,
    bottom: ((90 - FOCUS_BOUNDS.minLatitude) / 180) * height,
  };
}

function fittingZoom(element) {
  const bounds = focusPixels(0);
  const scale = Math.min(
    element.clientWidth / (bounds.right - bounds.left),
    element.clientHeight / (bounds.bottom - bounds.top),
  );
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.log2(scale))));
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
  const hydrousExploreRef = useRef(false);
  const panelResizeRef = useRef(null);
  const [view, setView] = useState({ zoom: MIN_ZOOM, x: 0, y: 0 });
  const [minimumZoom, setMinimumZoom] = useState(MIN_ZOOM);
  const [layer, setLayer] = useState('color');
  const [tileError, setTileError] = useState('');
  const [longitude, setLongitude] = useState('');
  const [latitude, setLatitude] = useState('');
  const [locationError, setLocationError] = useState('');
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [measurementStart, setMeasurementStart] = useState(null);
  const [measurementEnd, setMeasurementEnd] = useState(null);
  const [routeWaypoint, setRouteWaypoint] = useState(null);
  const [route, setRoute] = useState({ status: 'idle', value: null });
  const [routeError, setRouteError] = useState('');
  const [roverSpeedKph, setRoverSpeedKph] = useState(String(DEFAULT_ROVER_SPEED_KPH));
  const [drivingHoursPerSol, setDrivingHoursPerSol] = useState(String(DEFAULT_DRIVING_HOURS_PER_SOL));
  const [elevation, setElevation] = useState({ status: 'idle', value: null });
  const [temperature, setTemperature] = useState({ status: 'idle', value: null });
  const [elevationError, setElevationError] = useState('');
  const [terrainCoverage, setTerrainCoverage] = useState(null);
  const [hydrousSites, setHydrousSites] = useState({ status: 'loading', value: [] });
  const [hydrousError, setHydrousError] = useState('');
  const [highlightedHydrousSite, setHighlightedHydrousSite] = useState(null);
  const [geologicalFeatures, setGeologicalFeatures] = useState({ status: 'loading', value: [] });
  const [geologicalError, setGeologicalError] = useState('');
  const [highlightedGeologicalFeature, setHighlightedGeologicalFeature] = useState(null);
  const [nearbyFilter, setNearbyFilter] = useState('all');
  const [hydrousExploreMode, setHydrousExploreMode] = useState(false);

  useEffect(() => {
    const element = mapRef.current;
    const centerInitialView = () => {
      const zoom = fittingZoom(element);
      const bounds = focusPixels(zoom);
      setMinimumZoom(zoom);
      setView(constrain({
        zoom,
        x: element.clientWidth / 2 - (bounds.left + bounds.right) / 2,
        y: element.clientHeight / 2 - (bounds.top + bounds.bottom) / 2,
      }, element));
    };

    centerInitialView();
    const observer = new ResizeObserver(() => setView((current) => constrain(current, element, hydrousExploreRef.current)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/coverage', { signal: controller.signal })
      .then(readApiResponse)
      .then((payload) => setTerrainCoverage(payload.bounds ?? null))
      .catch(() => setTerrainCoverage(null));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const loadFeatures = async () => {
      try {
        const cached = localStorage.getItem(GEO_FEATURES_CACHE_KEY);
        if (cached) {
          const features = parseGeologicalFeatures(JSON.parse(cached));
          setGeologicalFeatures({ status: 'ready', value: features });
          return;
        }

        const response = await fetch(GEO_FEATURES_URL, { signal: controller.signal });
        if (!response.ok) throw new Error(`OpenSpace request failed with status ${response.status}`);
        const payload = await response.json();
        const features = parseGeologicalFeatures(payload);
        if (features.length === 0) throw new Error('OpenSpace returned no valid Mars features.');
        try {
          localStorage.setItem(GEO_FEATURES_CACHE_KEY, JSON.stringify(payload));
        } catch {
          // Continue with in-memory results when browser storage is unavailable.
        }
        setGeologicalFeatures({ status: 'ready', value: features });
      } catch (error) {
        if (error.name !== 'AbortError') {
          setGeologicalFeatures({ status: 'error', value: [] });
          setGeologicalError(error.message);
        }
      }
    };
    loadFeatures();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    try {
      const sites = parseHydrousSites(hydrousSitesCsv);
      if (sites.length === 0) throw new Error('No valid hydrous-site records were found.');
      setHydrousSites({ status: 'ready', value: sites });
    } catch (error) {
      setHydrousSites({ status: 'error', value: [] });
      setHydrousError(error.message);
    }
  }, []);

  useEffect(() => {
    if (!selectedLocation) return undefined;
    const controller = new AbortController();
    setElevation({ status: 'loading', value: null });
    setTemperature({ status: 'loading', value: null });
    setElevationError('');

    fetch(`/api/elevation?longitude=${selectedLocation.lng}&latitude=${selectedLocation.lat}`, { signal: controller.signal })
      .then(readApiResponse)
      .then((payload) => {
        setElevation({ status: 'ready', value: payload.elevation });
        setTemperature({ status: 'ready', value: payload.temperature });
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setElevationError(error.message);
      });

    return () => controller.abort();
  }, [selectedLocation]);

  useEffect(() => {
    if (!measurementStart || !measurementEnd) return undefined;
    const speed = Number(roverSpeedKph);
    const dailyHours = Number(drivingHoursPerSol);
    if (!Number.isFinite(speed) || speed < 0.01 || speed > 0.152 || !Number.isFinite(dailyHours) || dailyHours < 0.5 || dailyHours > 12) {
      setRoute({ status: 'idle', value: null });
      setRouteError('Enter rover speed from 0.01 to 0.152 km/h and driving hours from 0.5 to 12 per sol.');
      return undefined;
    }
    const controller = new AbortController();
    setRoute({ status: 'loading', value: null });
    setRouteError('');
    const query = new URLSearchParams({
      fromLongitude: measurementStart.lng,
      fromLatitude: measurementStart.lat,
      toLongitude: measurementEnd.lng,
      toLatitude: measurementEnd.lat,
      roverSpeedKph,
      drivingHoursPerSol,
    });
    if (routeWaypoint) {
      query.set('viaLongitude', routeWaypoint.lng);
      query.set('viaLatitude', routeWaypoint.lat);
    }

    fetch(`/api/route?${query}`, { signal: controller.signal })
      .then(readApiResponse)
      .then((payload) => setRoute({ status: 'ready', value: payload }))
      .catch((error) => {
        if (error.name !== 'AbortError') setRouteError(error.message);
      });

    return () => controller.abort();
  }, [measurementStart, measurementEnd, routeWaypoint, roverSpeedKph, drivingHoursPerSol]);

  const zoomAtCenter = (nextZoom) => {
    const element = mapRef.current;
    const zoom = Math.max(minimumZoom, Math.min(MAX_ZOOM, nextZoom));
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
    }, mapRef.current, hydrousExploreMode));
  };

  const addMeasurementPoint = (location) => {
    hydrousExploreRef.current = false;
    setHydrousExploreMode(false);
    setHighlightedHydrousSite(null);
    setHighlightedGeologicalFeature(null);
    if (!measurementStart || measurementEnd) {
      setMeasurementStart(location);
      setMeasurementEnd(null);
      setRouteWaypoint(null);
      setRoute({ status: 'idle', value: null });
      setRouteError('');
    } else {
      setMeasurementEnd(location);
    }
    setSelectedLocation(location);
  };

  const clearMeasurement = () => {
    setMeasurementStart(null);
    setMeasurementEnd(null);
    setRouteWaypoint(null);
    setRoute({ status: 'idle', value: null });
    setRouteError('');
    setSelectedLocation(null);
    setLongitude('');
    setLatitude('');
    setHighlightedHydrousSite(null);
    setHighlightedGeologicalFeature(null);
    hydrousExploreRef.current = false;
    setHydrousExploreMode(false);
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
    addMeasurementPoint({ lng, lat, matrixLongitude });
  };

  const endDrag = (event) => {
    const dragState = dragRef.current;
    dragRef.current = null;
    if (dragState && !dragState.moved) selectMapLocation(event);
  };

  const startTopPanelResize = (event) => {
    const panel = event.currentTarget.parentElement;
    const bounds = panel.getBoundingClientRect();
    panelResizeRef.current = {
      height: bounds.height,
      width: bounds.width,
      x: event.clientX,
      y: event.clientY,
      panel,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const resizeTopPanel = (event) => {
    const resize = panelResizeRef.current;
    if (!resize) return;
    const width = Math.min(window.innerWidth - 36, Math.max(280, resize.width + event.clientX - resize.x));
    const height = Math.min(window.innerHeight - 36, Math.max(220, resize.height - (event.clientY - resize.y)));
    resize.panel.style.width = `${width}px`;
    resize.panel.style.height = `${height}px`;
    event.stopPropagation();
  };

  const endTopPanelResize = (event) => {
    panelResizeRef.current = null;
    event.stopPropagation();
  };

  const selectLocation = (event) => {
    event.preventDefault();
    const lng = Number(longitude);
    const lat = Number(latitude);
    if (!longitude.trim() || !latitude.trim() || !Number.isFinite(lng) || !Number.isFinite(lat) || lng < 0 || lng > 360 || lat < -90 || lat > 90) {
      setLocationError('Enter longitude from 0 to 360E and latitude from -90 to 90N.');
      return;
    }

    const element = mapRef.current;
    const zoom = Math.max(minimumZoom, INSPECTION_ZOOM);
    const { width, height } = worldSize(zoom);
    // NASA's matrix spans -180 to 180 while entered areocentric longitude is 0 to 360 east.
    const tileLongitude = matrixLongitude(lng);
    // Normalize areocentric degrees into NASA's equirectangular tile matrix.
    const pointX = ((tileLongitude + 180) / 360) * width;
    const pointY = ((90 - lat) / 180) * height;
    setLocationError('');
    addMeasurementPoint({ lng, lat, matrixLongitude: tileLongitude });
    setView(constrain({
      zoom,
      x: element.clientWidth / 2 - pointX,
      y: element.clientHeight / 2 - pointY,
    }, element));
  };

  const centerOnReference = (site, category) => {
    const element = mapRef.current;
    const zoom = view.zoom;
    const { width, height } = worldSize(zoom);
    const pointX = ((site.longitude + 180) / 360) * width;
    const pointY = ((90 - site.latitude) / 180) * height;
    setHydrousExploreMode(true);
    hydrousExploreRef.current = true;
    setHighlightedHydrousSite(category === 'hydrous' ? site.id : null);
    setHighlightedGeologicalFeature(category === 'geological' ? site.id : null);
    if (measurementEnd) {
      setRouteWaypoint({
        lat: site.latitude,
        lng: site.longitude < 0 ? site.longitude + 360 : site.longitude,
        label: category === 'geological' ? site.name : 'Hydrous site',
      });
    }
    setView(constrain({
      zoom,
      x: element.clientWidth / 2 - pointX,
      y: element.clientHeight / 2 - pointY,
    }, element, true));
  };

  const { width, height } = worldSize(view.zoom);
  const activeLayer = MAP_LAYERS[layer];
  const sourceZoom = Math.min(view.zoom, activeLayer.maxNativeZoom);
  const tileScale = 2 ** (view.zoom - sourceZoom);
  const renderedTileSize = 256 * tileScale;
  const firstCol = Math.max(0, Math.floor(-view.x / renderedTileSize));
  const lastCol = Math.min(2 ** (sourceZoom + 1) - 1, Math.ceil((mapRef.current?.clientWidth - view.x) / renderedTileSize));
  const firstRow = Math.max(0, Math.floor(-view.y / renderedTileSize));
  const lastRow = Math.min(2 ** sourceZoom - 1, Math.ceil((mapRef.current?.clientHeight - view.y) / renderedTileSize));
  const tiles = [];
  const markers = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      const src = activeLayer.url.replace('{z}', sourceZoom).replace('{y}', row).replace('{x}', col);
      tiles.push(
        <img
          alt=""
          className="mars-tile"
          key={`${layer}-${src}`}
          onError={() => setTileError(`NASA WMTS tile failed to load: ${src}`)}
          src={src}
          style={{
            height: `${renderedTileSize}px`,
            transform: `translate(${view.x + col * renderedTileSize}px, ${view.y + row * renderedTileSize}px)`,
            width: `${renderedTileSize}px`,
          }}
        />,
      );
    }
  }

  for (const [label, location] of [['A', measurementStart], ['B', measurementEnd]]) {
    if (!location) continue;
    const markerX = ((location.matrixLongitude + 180) / 360) * width + view.x;
    const markerY = ((90 - location.lat) / 180) * height + view.y;
    markers.push(<span aria-label={`Measurement point ${label}`} className={`location-marker marker-${label.toLowerCase()}`} key={label} style={{ transform: `translate(${markerX}px, ${markerY}px)` }}>{label}</span>);
  }

  const nearbyHydrousSites = selectedLocation && !measurementEnd && hydrousSites.status === 'ready'
    ? hydrousSites.value
      .map((site) => ({
        ...site,
        distanceKm: surfaceDistanceKm(
          { latitude: selectedLocation.lat, longitude: selectedLocation.matrixLongitude },
          site,
        ),
      }))
      .sort((first, second) => first.distanceKm - second.distanceKm)
      .slice(0, 5)
    : [];

  const nearbyGeologicalFeatures = selectedLocation && !measurementEnd && geologicalFeatures.status === 'ready'
    ? geologicalFeatures.value
      .map((feature) => ({
        ...feature,
        distanceKm: surfaceDistanceKm(
          { latitude: selectedLocation.lat, longitude: selectedLocation.matrixLongitude },
          feature,
        ),
      }))
      .sort((first, second) => first.distanceKm - second.distanceKm)
      .slice(0, 5)
    : [];
  const routePath = route.value?.path.map((point) => ({
    latitude: point.latitudeAreocentric,
    longitude: normalizeMatrixLongitude(point.longitudeEast),
  })) ?? [];
  const routePois = measurementEnd && routePath.length > 0
    ? (() => {
      const allPois = [
      ...hydrousSites.value.map((site) => ({ ...site, category: 'Hydrous site', poiType: 'hydrous' })),
      ...geologicalFeatures.value.map((feature) => ({ ...feature, category: feature.type, poiType: 'geological' })),
      ].map((poi) => ({
        ...poi,
        startDistanceKm: surfaceDistanceKm(poi, { latitude: measurementStart.lat, longitude: measurementStart.matrixLongitude }),
        endDistanceKm: surfaceDistanceKm(poi, { latitude: measurementEnd.lat, longitude: measurementEnd.matrixLongitude }),
        routeDistanceKm: distanceToRouteKm(poi, routePath),
      }));
      const startNearest = [...allPois].sort((first, second) => first.startDistanceKm - second.startDistanceKm).slice(0, 5)
        .map((poi) => ({ ...poi, distanceKm: poi.startDistanceKm, proximity: 'Near start' }));
      const endNearest = [...allPois].sort((first, second) => first.endDistanceKm - second.endDistanceKm).slice(0, 5)
        .map((poi) => ({ ...poi, distanceKm: poi.endDistanceKm, proximity: 'Near destination' }));
      const corridorPois = allPois.filter((poi) => poi.routeDistanceKm <= ROUTE_POI_CORRIDOR_KM)
        .map((poi) => ({ ...poi, distanceKm: poi.routeDistanceKm, proximity: 'Along route' }));
      const uniquePois = new Map();
      for (const poi of [...startNearest, ...endNearest, ...corridorPois]) {
        const key = `${poi.poiType}-${poi.id}`;
        const existing = uniquePois.get(key);
        if (!existing || poi.distanceKm < existing.distanceKm) uniquePois.set(key, poi);
      }
      return [...uniquePois.values()].sort((first, second) => first.distanceKm - second.distanceKm);
    })()
    : [];
  const displayedHydrousSites = measurementEnd
    ? routePois.filter((poi) => poi.poiType === 'hydrous')
    : nearbyHydrousSites;
  const displayedGeologicalFeatures = measurementEnd
    ? routePois.filter((poi) => poi.poiType === 'geological')
    : nearbyGeologicalFeatures;
  const showHydrousSites = nearbyFilter !== 'geological';
  const showGeologicalFeatures = nearbyFilter !== 'hydrous';
  const filteredRoutePois = routePois.filter((poi) => nearbyFilter === 'all' || poi.poiType === nearbyFilter);

  for (const site of showHydrousSites ? displayedHydrousSites : []) {
    const markerX = ((site.longitude + 180) / 360) * width + view.x;
    const markerY = ((90 - site.latitude) / 180) * height + view.y;
    const isHighlighted = highlightedHydrousSite === site.id;
    markers.push(
      <button
        aria-label={`Hydrous site, ${site.distanceKm.toFixed(1)} kilometers away`}
        className={`hydrous-marker${isHighlighted ? ' highlighted' : ''}`}
        key={site.id}
        onClick={() => centerOnReference(site, 'hydrous')}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        style={{ transform: `translate(${markerX}px, ${markerY}px)` }}
        type="button"
      />,
    );
  }

  for (const feature of showGeologicalFeatures ? displayedGeologicalFeatures : []) {
    const markerX = ((feature.longitude + 180) / 360) * width + view.x;
    const markerY = ((90 - feature.latitude) / 180) * height + view.y;
    const isHighlighted = highlightedGeologicalFeature === feature.id;
    markers.push(
      <button
        aria-label={`${feature.name}, ${feature.type}, ${feature.distanceKm.toFixed(1)} kilometers to center`}
        className={`geological-marker${isHighlighted ? ' highlighted' : ''}`}
        key={feature.id}
        onClick={() => centerOnReference(feature, 'geological')}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        style={{ transform: `translate(${markerX}px, ${markerY}px)` }}
        type="button"
      />,
    );
  }

  const routeLine = route.value?.path.map((point) => {
    const longitude = matrixLongitude(point.longitudeEast);
    const x = ((longitude + 180) / 360) * width + view.x;
    const y = ((90 - point.latitudeAreocentric) / 180) * height + view.y;
    return `${x},${y}`;
  }).join(' ');
  const coverageRectangle = terrainCoverage && (() => {
    const left = ((matrixLongitude(terrainCoverage.minLongitude) + 180) / 360) * width + view.x;
    const right = ((matrixLongitude(terrainCoverage.maxLongitude) + 180) / 360) * width + view.x;
    const top = ((90 - terrainCoverage.maxLatitude) / 180) * height + view.y;
    const bottom = ((90 - terrainCoverage.minLatitude) / 180) * height + view.y;
    return { x: left, y: top, width: right - left, height: bottom - top };
  })();
  const mapWidth = mapRef.current?.clientWidth ?? 0;
  const mapHeight = mapRef.current?.clientHeight ?? 0;

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
      {coverageRectangle && (
        <>
          <svg aria-label="Terrain data coverage area" className="terrain-coverage" height={mapHeight} width={mapWidth}>
            <rect {...coverageRectangle} />
          </svg>
          <p className="terrain-coverage-legend">Elevation and routing data only available within dashed boundary</p>
        </>
      )}
      {routeLine && (
        <svg aria-label="Terrain-aware route" className="route-line" height={mapHeight} width={mapWidth}>
          <polyline points={routeLine} />
        </svg>
      )}
      {markers}
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
      <div className="layer-toggle" aria-label="Map layer" onPointerDown={(event) => event.stopPropagation()}>
        {Object.entries(MAP_LAYERS).map(([key, mapLayer]) => (
          <button
            aria-pressed={layer === key}
            className={layer === key ? 'active' : ''}
            key={key}
            onClick={() => { setLayer(key); setTileError(''); }}
            type="button"
          >
            {mapLayer.label}
          </button>
        ))}
      </div>
      <div className="zoom-controls" aria-label="Map zoom controls" onPointerDown={(event) => event.stopPropagation()}>
        <button aria-label="Zoom in" disabled={view.zoom === MAX_ZOOM} onClick={() => zoomAtCenter(view.zoom + 1)} type="button">+</button>
        <button aria-label="Zoom out" disabled={view.zoom === minimumZoom} onClick={() => zoomAtCenter(view.zoom - 1)} type="button">-</button>
      </div>
      {selectedLocation && (
        <section className="location-info" onPointerDown={(event) => event.stopPropagation()}>
          <span
            aria-hidden="true"
            className="panel-resize-handle"
            onPointerDown={startTopPanelResize}
            onPointerMove={resizeTopPanel}
            onPointerUp={endTopPanelResize}
          />
          <header>
            <span>{measurementEnd ? 'Terrain-aware route' : 'Route start selected'}</span>
            <strong>
              {measurementEnd
                ? `${Math.abs(measurementStart.lat).toFixed(4)}N, ${measurementStart.lng.toFixed(4)}E to ${Math.abs(measurementEnd.lat).toFixed(4)}N, ${measurementEnd.lng.toFixed(4)}E`
                : `${Math.abs(selectedLocation.lat).toFixed(5)}${selectedLocation.lat < 0 ? 'S' : 'N'} / ${selectedLocation.lng.toFixed(5)}E`}
            </strong>
          </header>
          {!measurementEnd && <>
            <div className="metrics">
              <div>
                <span>Elevation</span>
                {elevationError && <strong>Unavailable</strong>}
                {!elevationError && elevation.status === 'loading' && <strong>Loading</strong>}
                {!elevationError && elevation.status === 'ready' && !elevation.value && <strong>No sample</strong>}
                {elevation.value && <strong>{elevation.value.meters.toLocaleString()} m</strong>}
              </div>
              <div>
                <span>Temperature</span>
                {elevationError && <strong>Unavailable</strong>}
                {!elevationError && temperature.status === 'loading' && <strong>Loading</strong>}
                {!elevationError && temperature.status === 'ready' && !temperature.value && <strong>No sample</strong>}
                {temperature.value && <>
                  <strong>{temperature.value.averageC.toFixed(1)} C avg</strong>
                  <small>Max {temperature.value.maximumC.toFixed(1)} C / Min {temperature.value.minimumC.toFixed(1)} C</small>
                </>}
              </div>
            </div>
            <div className="nearby-points">
              <span>Nearby Martian Features</span>
              <div className="nearby-filters" role="group" aria-label="Nearby feature filter">
                {[['all', 'All'], ['hydrous', 'Hydrous Sites'], ['geological', 'Geological Features']].map(([value, label]) => (
                  <button
                    aria-pressed={nearbyFilter === value}
                    className={nearbyFilter === value ? 'active' : ''}
                    key={value}
                    onClick={() => setNearbyFilter(value)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
              {showHydrousSites && <>
                {hydrousSites.status === 'loading' && <p>Loading hydrous sites...</p>}
                {hydrousSites.status === 'error' && <p>{hydrousError || 'Hydrous-site data is unavailable.'}</p>}
                {hydrousSites.status === 'ready' && nearbyHydrousSites.length === 0 && <p>No nearby hydrous sites were found.</p>}
                <div className="hydrous-site-list">
                  {nearbyHydrousSites.map((site) => (
                    <button
                      className={highlightedHydrousSite === site.id ? 'highlighted' : ''}
                      key={site.id}
                      onClick={() => centerOnReference(site, 'hydrous')}
                      type="button"
                    >
                      <span className="hydrous-site-distance">{site.distanceKm.toFixed(1)} km</span>
                      <span className="hydrous-site-coordinates">{coordinateLabel(site.latitude, site.longitude)}</span>
                      {(site.omegaProductId || site.crismProductId) && (
                        <span className="hydrous-site-ids">
                          {site.omegaProductId && `OMEGA ${site.omegaProductId}`}
                          {site.omegaProductId && site.crismProductId && ' · '}
                          {site.crismProductId && `CRISM ${site.crismProductId}`}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </>}
              {showGeologicalFeatures && <>
                {geologicalFeatures.status === 'loading' && <p>Loading geological features...</p>}
                {geologicalFeatures.status === 'error' && <p>{geologicalError || 'Geological features are unavailable from OpenSpace.'}</p>}
                {geologicalFeatures.status === 'ready' && nearbyGeologicalFeatures.length === 0 && <p>No nearby geological features were found.</p>}
                <div className="geological-feature-list">
                  {nearbyGeologicalFeatures.map((feature) => (
                    <button
                      className={highlightedGeologicalFeature === feature.id ? 'highlighted' : ''}
                      key={feature.id}
                      onClick={() => centerOnReference(feature, 'geological')}
                      type="button"
                    >
                      <span className="geological-feature-distance">{feature.distanceKm.toFixed(1)} km to center</span>
                      <span className="geological-feature-name">{feature.name}</span>
                      <span className="geological-feature-type">{feature.type}</span>
                      <span className="geological-feature-coordinates">{coordinateLabel(feature.latitude, feature.longitude)}</span>
                    </button>
                  ))}
                </div>
              </>}
            </div>
            <p className="measurement-hint">Select a second map point to calculate a terrain-aware route. Hydrous sites are nearby reference detections.</p>
          </>}
          {measurementEnd && <>
            <div className="rover-settings">
              <label>
                Rover speed (km/h)
                <input max="0.152" min="0.01" onChange={(event) => setRoverSpeedKph(event.target.value)} step="0.01" type="number" value={roverSpeedKph} />
              </label>
              <label>
                Driving hours / sol
                <input max="12" min="0.5" onChange={(event) => setDrivingHoursPerSol(event.target.value)} step="0.5" type="number" value={drivingHoursPerSol} />
              </label>
            </div>
            {routeWaypoint && <p className="route-waypoint">Route via <strong>{routeWaypoint.label}</strong> · {coordinateLabel(routeWaypoint.lat, normalizeMatrixLongitude(routeWaypoint.lng))}</p>}
            <div className="metrics measurement-metrics">
              <div>
                <span>Route distance</span>
                {routeError && <strong>Unavailable</strong>}
                {!routeError && route.status === 'loading' && <strong>Routing</strong>}
                {route.value && <strong>{route.value.distance.kilometers.toFixed(2)} km</strong>}
              </div>
              <div>
                <span>Rover driving time</span>
                {route.value && <strong>{route.value.roverPlan.drivingHours.toFixed(1)} h</strong>}
                {!route.value && <strong>--</strong>}
              </div>
              <div>
                <span>Mission duration</span>
                {route.value && <strong>{route.value.roverPlan.estimatedSols} sols</strong>}
                {!route.value && <strong>--</strong>}
              </div>
              <div>
                <span>Elevation gain / loss</span>
                {route.value && <strong>{route.value.elevation.gainMeters.toLocaleString()} / {route.value.elevation.lossMeters.toLocaleString()} m</strong>}
                {!route.value && <strong>--</strong>}
              </div>
              <div>
                <span>Net elevation change</span>
                {route.value && <strong>{route.value.elevation.netChangeMeters.toLocaleString()} m</strong>}
                {!route.value && <strong>--</strong>}
              </div>
            </div>
            {routeError && <p className="route-warning">{routeError}</p>}
            {route.value && <p className="route-note">{route.value.roverPlan.assumption}</p>}
            {route.value && <p className="route-warning">{route.value.terrainWarning}</p>}
            <div className="nearby-points route-pois">
              <span>Scientific POIs Along Route</span>
              <small>{ROUTE_POI_CORRIDOR_KM} km route corridor, plus the five nearest POIs to each endpoint.</small>
              <div className="nearby-filters" role="group" aria-label="Route point of interest filter">
                {[['all', 'All'], ['hydrous', 'Hydrous Sites'], ['geological', 'Geological Features']].map(([value, label]) => (
                  <button aria-pressed={nearbyFilter === value} className={nearbyFilter === value ? 'active' : ''} key={value} onClick={() => setNearbyFilter(value)} type="button">{label}</button>
                ))}
              </div>
              {route.status === 'loading' && <p>Finding route POIs...</p>}
              {route.value && filteredRoutePois.length === 0 && <p>No scientific POIs fall within the route corridor.</p>}
              <div className="route-poi-list">
                {filteredRoutePois.map((poi) => (
                  <button className={poi.poiType === 'hydrous' ? 'hydrous' : 'geological'} key={`${poi.poiType}-${poi.id}`} onClick={() => centerOnReference(poi, poi.poiType)} type="button">
                    <span>{poi.distanceKm.toFixed(1)} km · {poi.proximity}</span>
                    <strong>{poi.poiType === 'geological' ? poi.name : 'Hydrous site'}</strong>
                    <small>
                      {poi.category} · {coordinateLabel(poi.latitude, poi.longitude)}
                      {poi.poiType === 'hydrous' && poi.crismProductId && ` · CRISM ${poi.crismProductId}`}
                    </small>
                  </button>
                ))}
              </div>
            </div>
          </>}
          <button className="clear-measurement" onClick={clearMeasurement} type="button">Clear route</button>
        </section>
      )}
      {tileError && <p id="tile-error" role="alert">{tileError}</p>}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<MarsMap />);
