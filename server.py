#!/usr/bin/env python3
import heapq
import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from scripts import db_retrieval

PORT = 8000
MARS_RADIUS_KM = 3396.19
GRID_STEP_DEGREES = 1 / 64
NEAREST_SEARCH_DEGREES = 0.05
ROUTE_MARGIN_DEGREES = 0.1
SAMPLE_COLUMNS = "latitude, longitude, elevation, avg_temp, max_temp, min_temp"


class DatabaseUnavailable(Exception):
    pass


def grid_key(sample, origin):
    return (
        round((sample["latitude"] - origin["latitude"]) / GRID_STEP_DEGREES),
        round((sample["longitude"] - origin["longitude"]) / GRID_STEP_DEGREES),
    )


def sample_from_row(row):
    return {
        "latitude": float(row[0]),
        "longitude": float(row[1]),
        "meters": float(row[2]),
        "temperature": {
            "averageC": float(row[3]),
            "maximumC": float(row[4]),
            "minimumC": float(row[5]),
        },
    }


def load_samples(minimum_latitude, maximum_latitude, minimum_longitude, maximum_longitude):
    # Inputs come from parsed floats, so interpolating them cannot inject SQL.
    query = (
        f"SELECT {SAMPLE_COLUMNS} FROM MarsPoints "
        f"WHERE latitude BETWEEN {minimum_latitude:.12f} AND {maximum_latitude:.12f} "
        f"AND longitude BETWEEN {minimum_longitude:.12f} AND {maximum_longitude:.12f}"
    )
    try:
        return [sample_from_row(row) for row in db_retrieval.query_db(query)]
    except Exception as error:
        print(f"Database error: {exc}", file=sys.stderr, flush=True)
        traceback.print_exc()
        raise DatabaseUnavailable(f"Mars terrain database is unavailable: {error}") from error


def nearest_sample(latitude, longitude):
    samples = load_samples(
        latitude - NEAREST_SEARCH_DEGREES,
        latitude + NEAREST_SEARCH_DEGREES,
        longitude - NEAREST_SEARCH_DEGREES,
        longitude + NEAREST_SEARCH_DEGREES,
    )
    return nearest_from_samples(samples, latitude, longitude)


def nearest_from_samples(samples, latitude, longitude):
    if not samples:
        return None
    return min(
        samples,
        key=lambda item: (item["latitude"] - latitude) ** 2 + (item["longitude"] - longitude) ** 2,
    )


def surface_distance_km(first, second):
    latitude_difference = math.radians(second["latitude"] - first["latitude"])
    longitude_difference = math.radians(second["longitude"] - first["longitude"])
    a = (
        math.sin(latitude_difference / 2) ** 2
        + math.cos(math.radians(first["latitude"]))
        * math.cos(math.radians(second["latitude"]))
        * math.sin(longitude_difference / 2) ** 2
    )
    return MARS_RADIUS_KM * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def route_between(start_coordinates, end_coordinates):
    """Find a route through recorded elevation samples, never interpolated terrain."""
    latitude_margin = max(ROUTE_MARGIN_DEGREES, abs(start_coordinates["latitude"] - end_coordinates["latitude"]) * 0.2)
    longitude_margin = max(ROUTE_MARGIN_DEGREES, abs(start_coordinates["longitude"] - end_coordinates["longitude"]) * 0.2)
    samples = load_samples(
        min(start_coordinates["latitude"], end_coordinates["latitude"]) - latitude_margin,
        max(start_coordinates["latitude"], end_coordinates["latitude"]) + latitude_margin,
        min(start_coordinates["longitude"], end_coordinates["longitude"]) - longitude_margin,
        max(start_coordinates["longitude"], end_coordinates["longitude"]) + longitude_margin,
    )
    start = nearest_from_samples(samples, start_coordinates["latitude"], start_coordinates["longitude"])
    end = nearest_from_samples(samples, end_coordinates["latitude"], end_coordinates["longitude"])
    if not start or not end:
        raise ValueError("Both route points must be inside the available elevation-data area")
    origin = {
        "latitude": min(sample["latitude"] for sample in samples),
        "longitude": min(sample["longitude"] for sample in samples),
    }
    elevation_grid = {grid_key(sample, origin): sample for sample in samples}
    start_key = grid_key(start, origin)
    end_key = grid_key(end, origin)
    if start_key not in elevation_grid or end_key not in elevation_grid:
        raise ValueError("Route endpoints are not represented in the available elevation grid")
    frontier = [(0, 0, start_key)]
    came_from = {}
    cost_so_far = {start_key: 0}

    while frontier:
        _, current_cost, current_key = heapq.heappop(frontier)
        if current_cost != cost_so_far.get(current_key):
            continue
        if current_key == end_key:
            break

        current = elevation_grid[current_key]
        for latitude_offset in (-1, 0, 1):
            for longitude_offset in (-1, 0, 1):
                if latitude_offset == 0 and longitude_offset == 0:
                    continue
                neighbor_key = (current_key[0] + latitude_offset, current_key[1] + longitude_offset)
                neighbor = elevation_grid.get(neighbor_key)
                if not neighbor:
                    continue

                horizontal_distance = surface_distance_km(current, neighbor)
                slope = abs(neighbor["meters"] - current["meters"]) / (horizontal_distance * 1000)
                # The slope multiplier makes flatter sampled cells preferable to a straight climb.
                terrain_cost = horizontal_distance * (1 + 12 * slope)
                next_cost = current_cost + terrain_cost
                if next_cost >= cost_so_far.get(neighbor_key, math.inf):
                    continue

                cost_so_far[neighbor_key] = next_cost
                came_from[neighbor_key] = current_key
                heuristic = surface_distance_km(neighbor, end)
                heapq.heappush(frontier, (next_cost + heuristic, next_cost, neighbor_key))

    if end_key not in cost_so_far:
        raise ValueError("No continuous elevation-data route exists between these points")

    path_keys = [end_key]
    while path_keys[-1] != start_key:
        path_keys.append(came_from[path_keys[-1]])
    path = [elevation_grid[key] for key in reversed(path_keys)]

    distance_km = sum(surface_distance_km(first, second) for first, second in zip(path, path[1:]))
    elevation_gain = sum(max(0, second["meters"] - first["meters"]) for first, second in zip(path, path[1:]))
    elevation_loss = sum(max(0, first["meters"] - second["meters"]) for first, second in zip(path, path[1:]))
    return {
        "path": [{"longitudeEast": point["longitude"], "latitudeAreocentric": point["latitude"]} for point in path],
        "start": location_payload({"longitude": start["longitude"], "latitude": start["latitude"]}),
        "end": location_payload({"longitude": end["longitude"], "latitude": end["latitude"]}),
        "distance": {"kilometers": distance_km, "miles": distance_km * 0.621371},
        "elevation": {
            "netChangeMeters": path[-1]["meters"] - path[0]["meters"],
            "gainMeters": elevation_gain,
            "lossMeters": elevation_loss,
        },
    }


def read_coordinates(parameters, prefix=""):
    longitude_key = f"{prefix}Longitude" if prefix else "longitude"
    latitude_key = f"{prefix}Latitude" if prefix else "latitude"
    try:
        longitude = float(parameters[longitude_key][0])
        latitude = float(parameters[latitude_key][0])
    except (KeyError, ValueError, IndexError) as error:
        raise ValueError("longitude and latitude must be valid numbers") from error

    if not 0 <= longitude <= 360 or not -90 <= latitude <= 90:
        raise ValueError("longitude must be 0 to 360 and latitude must be -90 to 90")
    return {"longitude": longitude, "latitude": latitude}


def location_payload(coordinates):
    sample = nearest_sample(coordinates["latitude"], coordinates["longitude"])
    return {
        "longitudeEast": coordinates["longitude"],
        "latitudeAreocentric": coordinates["latitude"],
        "elevation": {"meters": sample["meters"], "source": "MOLA 128ppd"} if sample else None,
        "temperature": sample["temperature"] if sample else None,
    }


class MarsMapperHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        request = urlparse(self.path)
        if request.path not in ("/api/elevation", "/api/route"):
            self.send_error(404, "Not Found")
            return

        parameters = parse_qs(request.query)
        try:
            if request.path == "/api/elevation":
                coordinates = read_coordinates(parameters)
                location = location_payload(coordinates)
                self.send_json(200, {
                    "coordinates": {
                        "longitudeEast": location["longitudeEast"],
                        "latitudeAreocentric": location["latitudeAreocentric"],
                    },
                    "elevation": location["elevation"],
                    "temperature": location["temperature"],
                })
                return

            start = read_coordinates(parameters, "from")
            end = read_coordinates(parameters, "to")
            if request.path == "/api/route":
                self.send_json(200, route_between(start, end))
                return
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        except DatabaseUnavailable as error:
            self.send_json(503, {"error": str(error)})
            return


    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), MarsMapperHandler)
    print(f"Mars Mapper API running on http://127.0.0.1:{PORT}")
    server.serve_forever()
