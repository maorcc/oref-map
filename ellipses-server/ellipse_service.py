from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import Any

import alphashape
import cv2
import numpy as np
import pandas as pd
from shapely.geometry import Point
from sklearn.cluster import DBSCAN


ROOT_DIR = Path(__file__).resolve().parent.parent
POINTS_PATH = ROOT_DIR / "web" / "oref_points.json"
COAST_PATH = ROOT_DIR / "web" / "israel_mediterranean_coast_0.5km.csv"

LAT_KM = 111.2
LON_KM = 94.6


class EllipseError(Exception):
    pass


class UnknownLocationsError(EllipseError):
    def __init__(self, missing: list[str]) -> None:
        super().__init__(f"Unknown alert locations: {missing}")
        self.missing = missing


class InsufficientPointsError(EllipseError):
    pass


@dataclass(frozen=True)
class EllipseOptions:
    cluster_eps_km: float = 10.0
    cluster_min_samples: int = 10
    alpha: float = 0.1
    boundary_threshold: float = 0.03
    coast_min_distance_km: float = 4.0
    min_boundary_points: int = 6


class EllipseService:
    def __init__(
        self,
        points_path: Path = POINTS_PATH,
        coast_path: Path = COAST_PATH,
    ) -> None:
        self._locations = self._load_locations(points_path)
        self._coast = self._load_coast(coast_path)

    @staticmethod
    def _load_locations(points_path: Path) -> dict[str, tuple[float, float]]:
        with points_path.open(encoding="utf-8") as f:
            raw_points = json.load(f)

        locations: dict[str, tuple[float, float]] = {}
        for name, coords in raw_points.items():
            if not isinstance(name, str):
                continue
            if not isinstance(coords, list) or len(coords) < 2:
                continue

            lat = coords[0]
            lng = coords[1]
            if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
                continue

            locations[name] = (float(lat), float(lng))

        return locations

    @staticmethod
    def _load_coast(coast_path: Path) -> np.ndarray:
        coast = pd.read_csv(coast_path).values
        return np.array(coast)[:, ::-1]

    def load_points_from_alert_names(self, alert_names: list[str]) -> tuple[np.ndarray, list[str]]:
        points: list[list[float]] = []
        missing: list[str] = []

        for alert_name in alert_names:
            coords = self._locations.get(alert_name)
            if coords is None:
                missing.append(alert_name)
                continue

            lat, lng = coords
            points.append([lng, lat])

        return np.array(points, dtype=np.float32), missing

    @staticmethod
    def _detect_main_cluster(
        points: np.ndarray,
        eps_km: float,
        min_samples: int,
    ) -> np.ndarray:
        if len(points) == 0:
            return np.empty((0, 2), dtype=np.float32)

        scaled_points = np.copy(points)
        scaled_points[:, 0] *= LON_KM
        scaled_points[:, 1] *= LAT_KM

        db = DBSCAN(eps=eps_km, min_samples=min_samples)
        labels = db.fit_predict(scaled_points)

        unique, counts = np.unique(labels[labels >= 0], return_counts=True)
        if len(counts) == 0:
            return np.empty((0, 2), dtype=np.float32)

        largest_cluster_label = unique[np.argmax(counts)]
        return points[labels == largest_cluster_label]

    def _filter_points_away_from_coast(
        self,
        edge_points: np.ndarray,
        min_distance_km: float,
    ) -> np.ndarray:
        filtered = []

        for point in edge_points:
            dlon = (self._coast[:, 0] - point[0]) * LON_KM
            dlat = (self._coast[:, 1] - point[1]) * LAT_KM
            distances = np.sqrt(dlat**2 + dlon**2)

            if float(np.min(distances)) > min_distance_km:
                filtered.append(point)

        return np.array(filtered, dtype=np.float32)

    def fit_from_names(
        self,
        alert_names: list[str],
        options: EllipseOptions | None = None,
    ) -> dict[str, Any]:
        if not alert_names:
            raise InsufficientPointsError("At least one location is required")

        options = options or EllipseOptions()
        points, missing = self.load_points_from_alert_names(alert_names)
        if len(points) == 0:
            raise UnknownLocationsError(missing)

        cluster_points = self._detect_main_cluster(
            points,
            eps_km=options.cluster_eps_km,
            min_samples=options.cluster_min_samples,
        )

        if len(cluster_points) < options.min_boundary_points:
            raise InsufficientPointsError(
                f"Need at least {options.min_boundary_points} clustered points, got {len(cluster_points)}"
            )

        boundary_shape = alphashape.alphashape(cluster_points, options.alpha)
        exterior = getattr(boundary_shape, "exterior", None)
        if exterior is None:
            raise InsufficientPointsError("Could not derive a polygon boundary from clustered points")

        edge_points = np.array(
            [
                point
                for point in cluster_points
                if exterior.distance(Point(point)) < options.boundary_threshold
            ],
            dtype=np.float32,
        )

        filtered_points = self._filter_points_away_from_coast(
            edge_points,
            min_distance_km=options.coast_min_distance_km,
        )

        if len(filtered_points) < options.min_boundary_points:
            raise InsufficientPointsError(
                f"Need at least {options.min_boundary_points} filtered boundary points, got {len(filtered_points)}"
            )

        ellipse = cv2.fitEllipse(filtered_points.reshape(-1, 1, 2))
        center, axes, angle_deg = ellipse

        center_lng = float(center[0])
        center_lat = float(center[1])
        axis_a = float(axes[0])
        axis_b = float(axes[1])
        normalized_angle_deg = float(angle_deg)

        if axis_a >= axis_b:
            major_axis_deg = axis_a
            minor_axis_deg = axis_b
        else:
            major_axis_deg = axis_b
            minor_axis_deg = axis_a
            normalized_angle_deg += 90.0

        normalized_angle_deg %= 180.0
        major_radius_deg = major_axis_deg / 2.0
        minor_radius_deg = minor_axis_deg / 2.0

        center_lat_cos = max(math.cos(math.radians(center_lat)), 1e-6)
        lon_km_at_center = 111.32 * center_lat_cos
        angle_rad = math.radians(normalized_angle_deg)

        major_radius_km = math.sqrt(
            ((major_radius_deg * math.cos(angle_rad)) * lon_km_at_center) ** 2
            + ((major_radius_deg * math.sin(angle_rad)) * 111.32) ** 2
        )
        minor_angle_rad = angle_rad + (math.pi / 2.0)
        minor_radius_km = math.sqrt(
            ((minor_radius_deg * math.cos(minor_angle_rad)) * lon_km_at_center) ** 2
            + ((minor_radius_deg * math.sin(minor_angle_rad)) * 111.32) ** 2
        )

        return {
            "center": {
                "lat": center_lat,
                "lng": center_lng,
            },
            "axes": {
                "major_full_degrees": major_axis_deg,
                "minor_full_degrees": minor_axis_deg,
                "semi_major_degrees": major_radius_deg,
                "semi_minor_degrees": minor_radius_deg,
                "semi_major_km": float(major_radius_km),
                "semi_minor_km": float(minor_radius_km),
            },
            "angle_deg": normalized_angle_deg,
            "meta": {
                "input_count": len(alert_names),
                "used_count": int(len(points)),
                "clustered_count": int(len(cluster_points)),
                "boundary_count": int(len(edge_points)),
                "filtered_boundary_count": int(len(filtered_points)),
            },
            "missing_locations": missing,
        }
