# -*- coding: utf-8 -*-
"""
build_data.py
primary_data/의 나라 목록(world.toml)과 세계 지도(countries-110m.json)를 웹 클라이언트용
data/world.js로 묶는다. 지도는 빌드할 때 SVG 경로로 바꿔 넣는다(외부 스크립트·인터넷 없이 보이게).

자료 출처: daily-study 소식 페이지 「배우기」 탭(curriculum/world.toml, local/assets/).
지도 투영은 그쪽 local/learn.py와 같은 등장방형(경도·위도를 그대로 x·y로)이라 js/engine.js가 되돌릴 수 있다.

실행: python -X utf8 scripts/build_data.py
"""
from __future__ import annotations

import json
import tomllib
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
SRC = BASE / "primary_data"
OUT = BASE / "data" / "world.js"

W = 1000                        # 지도 너비(좌표 단위). js/engine.js의 MAP과 같아야 한다
LAT_TOP, LAT_BOTTOM = 84, -58   # 남극·북극 끝은 잘라 낸다
H = round((LAT_TOP - LAT_BOTTOM) / 360 * W)
SKIP = {"010"}                  # 남극
# 본토와 멀리 떨어진 해외 영토는 정답 영역에서 뺀다(프랑스령 기아나를 눌러 프랑스 정답이 되면 안 된다)
OVERSEAS = {"fr": lambda lon, lat: lon < -20}


def load_countries() -> list[dict]:
    return tomllib.loads((SRC / "world.toml").read_text(encoding="utf-8"))["country"]


def decode_arcs(topo: dict) -> list[list[tuple[float, float]]]:
    """TopoJSON 양자화·델타 인코딩을 풀어 (경도, 위도) 목록으로."""
    (sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]
    out = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        out.append(pts)
    return out


def ring(arcs: list, idx: list[int]) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for i in idx:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(a if not pts else a[1:])
    return pts


def xy(lon: float, lat: float) -> tuple[float, float]:
    return (lon + 180) / 360 * W, (LAT_TOP - lat) / 360 * W


def path_d(rings: list[list[tuple[float, float]]]) -> str:
    parts = []
    for r in rings:
        seg, cmd, prev = [], "M", None
        for x, y in (xy(*p) for p in r):
            # 날짜변경선을 넘는 고리(러시아 동쪽 끝, 피지)는 화면을 가로지르는 선이 생기므로 끊는다
            if prev and abs(x - prev[0]) > W / 2:
                cmd = "M"
            seg.append(f"{cmd}{x:.1f} {y:.1f}")
            cmd, prev = "L", (x, y)
        parts.append("".join(seg) + "Z")
    return "".join(parts)


def box_area(r: list[tuple[float, float]]) -> float:
    xs, ys = [p[0] for p in r], [p[1] for p in r]
    return (max(xs) - min(xs)) * (max(ys) - min(ys))


def world_svg(targets: dict[str, str]) -> str:
    """세계 지도 SVG. 문제로 나올 나라(숫자 코드 → 알파벳 코드)는 data-c를, 작은 나라 판정용 표식 원은 data-m을 단다."""
    topo = json.loads((SRC / "countries-110m.json").read_text(encoding="utf-8"))
    arcs = decode_arcs(topo)
    paths, marks = [], []
    for g in topo["objects"]["countries"]["geometries"]:
        gid = g.get("id")
        if gid in SKIP or g.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        polys = [g["arcs"]] if g["type"] == "Polygon" else g["arcs"]
        code = targets.get(gid)
        cut = OVERSEAS.get(code)
        if cut:
            away = [p for p in polys if cut(*ring(arcs, p[0])[0])]
            polys = [p for p in polys if p not in away]
            if away:
                paths.append(f'<path d="{path_d([ring(arcs, r) for poly in away for r in poly])}"/>')
        rings = [ring(arcs, r) for poly in polys for r in poly]
        attr = f' data-c="{code}"' if code else ""
        paths.append(f'<path{attr} d="{path_d(rings)}"/>')
        if code:
            # 가장 큰 다각형의 상자 가운데. 섬·해외 영토에 찍히지 않게
            big = max((ring(arcs, poly[0]) for poly in polys), key=box_area)
            xs, ys = [p[0] for p in big], [p[1] for p in big]
            if max(xs) - min(xs) > 180:
                # 날짜변경선을 넘는 고리(러시아)는 서경을 +360 해서 이어 붙여야 상자 가운데가 본토에 온다
                xs = [x + 360 if x < 0 else x for x in xs]
            mid = (max(xs) + min(xs)) / 2
            cx, cy = xy(mid - 360 if mid > 180 else mid, (max(ys) + min(ys)) / 2)
            marks.append(f'<circle data-m="{code}" cx="{cx:.1f}" cy="{cy:.1f}" r="9"/>')
    return (f'<svg class="wmap" viewBox="0 0 {W} {H}" role="img" aria-label="세계 지도">'
            f'<g class="land">{"".join(paths)}</g><g class="marks">{"".join(marks)}</g>'
            f'<g class="fx"></g></svg>')


def main() -> None:
    countries = load_countries()
    data = [{k: c.get(k, "") for k in ("code", "name", "alias", "continent", "where")} for c in countries]
    missing = [c["code"] for c in countries if not (SRC / "flags" / f"{c['code']}.svg").exists()]
    if missing:
        raise SystemExit(f"국기 파일 없음: {missing}")
    svg = world_svg({c["num"]: c["code"] for c in countries})
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(
        "// 자동 생성: python -X utf8 scripts/build_data.py (직접 고치지 않는다)\n"
        f"window.WORLD = {json.dumps(data, ensure_ascii=False)};\n"
        f"window.MAP_SVG = {json.dumps(svg, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    print(f"나라 {len(data)}개, 지도 {W}x{H}, {OUT.relative_to(BASE)} {OUT.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
