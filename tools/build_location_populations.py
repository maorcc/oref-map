#!/usr/bin/env python3
"""
Build web/location_populations.json from CBS (Israeli Central Bureau of Statistics) data.

Data source: CBS locality file with 2024 population data.
URL: https://www.cbs.gov.il/he/publications/doclib/2019/ishuvim/bycode2024.xlsx

The output maps each oref alert location name (Hebrew) to its population count.
Coverage: ~1,058 of 1,449 oref locations (~73%).

Unresolved locations (no data) are omitted from the output — the UI treats missing
entries as "unknown" and excludes them from the resident count.

To refresh the data:
  python3 tools/build_location_populations.py
"""

import io
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

CBS_URL = "https://www.cbs.gov.il/he/publications/doclib/2019/ishuvim/bycode2024.xlsx"
OREF_POINTS = "web/oref_points.json"
OUTPUT = "web/location_populations.json"


def load_cbs_xlsx(path_or_url: str) -> dict[str, int]:
    """Download (or read) the CBS XLSX and return {name: population}."""
    if path_or_url.startswith("http"):
        print(f"Downloading CBS data from {path_or_url} ...", file=sys.stderr)
        req = urllib.request.Request(path_or_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req) as resp:
            content = resp.read()
    else:
        with open(path_or_url, "rb") as f:
            content = f.read()

    zf = zipfile.ZipFile(io.BytesIO(content))

    # Shared strings table (text values in cells)
    ss_xml = zf.read("xl/sharedStrings.xml").decode("utf-8")
    ss_root = ET.fromstring(ss_xml)
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    strings = [el.text or "" for el in ss_root.findall(f".//{{{ns}}}t")]

    # Sheet data
    sheet_xml = zf.read("xl/worksheets/sheet1.xml").decode("utf-8")
    sheet = ET.fromstring(sheet_xml)

    rows = []
    for row in sheet.findall(f".//{{{ns}}}row"):
        cells = []
        for cell in row.findall(f"{{{ns}}}c"):
            t = cell.get("t", "")
            v_el = cell.find(f"{{{ns}}}v")
            v = v_el.text if v_el is not None else None
            if t == "s" and v is not None:
                v = strings[int(v)]
            cells.append(v)
        rows.append(cells)

    # Column 0 = שם יישוב (locality name), column 12 = total population
    result: dict[str, int] = {}
    for row in rows[1:]:  # skip header
        if len(row) > 12:
            name = row[0]
            pop = row[12]
            if name:
                try:
                    result[name] = int(pop) if pop else 0
                except (ValueError, TypeError):
                    result[name] = 0
    return result


def norm1(s: str) -> str:
    """Strip trailing parentheticals like (קיבוץ), (מושב)."""
    s = re.sub(r"\s+", " ", s.strip())
    s = re.sub(r"\s*\([^)]+\)\s*$", "", s).strip()
    return s


def norm2(s: str) -> str:
    """Also normalise hyphens↔spaces (CBS uses hyphens in compound Arab names)."""
    return re.sub(r"\s+", " ", norm1(s).replace("-", " ")).strip()


def build_mapping(cbs: dict[str, int], oref_names: list[str]) -> dict[str, int]:
    # Build normalised lookup tables
    cbs_n1: dict[str, tuple[str, int]] = {}
    cbs_n2: dict[str, tuple[str, int]] = {}
    for name, pop in cbs.items():
        n1, n2 = norm1(name), norm2(name)
        if n1 not in cbs_n1 or pop > cbs_n1[n1][1]:
            cbs_n1[n1] = (name, pop)
        if n2 not in cbs_n2 or pop > cbs_n2[n2][1]:
            cbs_n2[n2] = (name, pop)

    def lookup(name: str) -> int | None:
        if name in cbs and cbs[name] > 0:
            return cbs[name]
        n1 = norm1(name)
        if n1 in cbs_n1 and cbs_n1[n1][1] > 0:
            return cbs_n1[n1][1]
        n2 = norm2(name)
        if n2 in cbs_n2 and cbs_n2[n2][1] > 0:
            return cbs_n2[n2][1]
        return None

    result: dict[str, int] = {}

    # Pass 1: direct + normalised match
    for name in oref_names:
        pop = lookup(name)
        if pop is not None:
            result[name] = pop

    # Pass 2: combined names ("שדרות, איבים" → sum components)
    for name in oref_names:
        if name in result:
            continue
        parts = [p.strip() for p in re.split(r",\s*", name) if p.strip()]
        if len(parts) > 1:
            total = sum(lookup(p) or 0 for p in parts)
            if total > 0:
                result[name] = total

    # Pass 3: city sub-districts — split parent population equally among
    # residential sub-districts (e.g. ירושלים - מערב gets 1/6 of Jerusalem pop)
    parent_groups: dict[str, list[str]] = {}
    for name in oref_names:
        if name in result:
            continue
        if " - " in name:
            parent = name.split(" - ")[0]
            parent_groups.setdefault(parent, []).append(name)

    non_res_markers = ["תעשייה", "תעשיות", "סנטר", "מלון", "אירפורט", "איירפורט"]
    for parent, districts in parent_groups.items():
        parent_pop = result.get(parent) or lookup(parent) or 0
        residential = [d for d in districts if not any(m in d for m in non_res_markers)]
        industrial = [d for d in districts if d not in residential]
        if parent_pop > 0 and residential:
            per = parent_pop // len(residential)
            for d in residential:
                result[d] = per
        for d in industrial:
            result[d] = 0

    return result


def main() -> None:
    import os

    cbs = load_cbs_xlsx(CBS_URL)
    print(f"CBS entries loaded: {len(cbs)}", file=sys.stderr)

    with open(OREF_POINTS, encoding="utf-8") as f:
        oref = json.load(f)
    oref_names = list(oref.keys())
    print(f"Oref locations: {len(oref_names)}", file=sys.stderr)

    mapping = build_mapping(cbs, oref_names)

    # Only output locations with population > 0
    out = {name: mapping[name] for name in mapping if mapping[name] > 0}
    coverage = len(out)
    unresolved = len(oref_names) - len(mapping)

    print(
        f"Resolved with pop>0: {coverage}  |  unresolved: {unresolved}  |  "
        f"total pop covered: {sum(out.values()):,}",
        file=sys.stderr,
    )

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"Written {OUTPUT} ({size_kb:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
