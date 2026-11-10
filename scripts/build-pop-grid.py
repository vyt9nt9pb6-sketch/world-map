#!/usr/bin/env python3
"""把 Chen et al. 2024 第七次人口普查 100 m 網格（CC BY 4.0）收成網頁用的人口密度檔。

原始檔是 Albers／Krasovsky 的 GeoTIFF，每格是人數（約 100×100 公尺）。
gdalwarp 一次重採樣整張會吃掉數 GB 記憶體，所以這裡逐列讀取：
每列只轉換一條稀疏的經緯度，再線性內插，把人數加進 0.01° 的 WGS-84 網格。
然後換成 人/km²，以 log2×14 編成 uint8；若 gzip 太大就再把鄰格加總。

輸出：public/data/pop/china2020.bin.gz
用法：python3 scripts/build-pop-grid.py /path/to/PopSE_China2020_100m.tif
"""
from __future__ import annotations

import gzip
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from osgeo import gdal, osr

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'data' / 'pop' / 'china2020.bin.gz'
LOG_SCALE = 14
MAX_GZIP = 1_200_000
MAX_RAW = 12_000_000
# 中國陸地（含一點邊界）。普查網格不含港澳台。
WEST, SOUTH, EAST, NORTH = 73.0, 17.5, 135.5, 54.0
FINE_STEP = 0.01


def row_areas(north: float, step: float, rows: int, cols: int) -> np.ndarray:
    r = 6371.0088
    idx = np.arange(rows, dtype=np.float64)
    lat = north - (idx + 0.5) * step
    s1 = np.sin(np.radians(lat - step / 2))
    s2 = np.sin(np.radians(lat + step / 2))
    per = (r * r) * math.radians(step) * np.abs(s2 - s1)
    return np.repeat(per[:, None], cols, axis=1)


def bin_sum(people: np.ndarray, area: np.ndarray, k: int):
    if k == 1:
        return people, area
    rows = (people.shape[0] // k) * k
    cols = (people.shape[1] // k) * k
    p = people[:rows, :cols].reshape(rows // k, k, cols // k, k).sum(axis=(1, 3))
    a = area[:rows, :cols].reshape(rows // k, k, cols // k, k).sum(axis=(1, 3))
    return p, a


def encode(people: np.ndarray, area: np.ndarray) -> np.ndarray:
    dens = np.zeros(people.shape, dtype=np.float64)
    np.divide(people, area, out=dens, where=area > 0)
    code = np.zeros(dens.shape, dtype=np.uint8)
    mask = np.isfinite(dens) & (dens >= 1)
    if np.any(mask):
        raw = np.rint(np.log2(dens[mask]) * LOG_SCALE)
        code[mask] = np.clip(raw, 1, 255).astype(np.uint8)
    return code


def pack(meta: dict, data: np.ndarray) -> bytes:
    body = json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    head = b'WMPOP1' + struct.pack('<HI', 1, len(body))
    return head + body + np.ascontiguousarray(data).tobytes()


def accumulate_albers(path: str):
    """逐列把投影網格的人數加總到 FINE_STEP 度的 WGS-84 網格。回傳 (people, west, north, step, src_total)。"""
    gdal.UseExceptions()
    ds = gdal.Open(path)
    if ds is None:
        sys.exit('無法開啟 GeoTIFF')
    band = ds.GetRasterBand(1)
    nodata = band.GetNoDataValue()
    src_srs = osr.SpatialReference(wkt=ds.GetProjection())
    dst_srs = osr.SpatialReference()
    dst_srs.ImportFromEPSG(4326)
    src_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    ct = osr.CoordinateTransformation(src_srs, dst_srs)
    gt = ds.GetGeoTransform()
    cols = ds.RasterXSize
    rows = ds.RasterYSize
    stride = 32
    lattice = np.arange(0, cols, stride)
    if lattice[-1] != cols - 1:
        lattice = np.append(lattice, cols - 1)
    xs = gt[0] + (lattice + 0.5) * gt[1]
    pix = np.arange(cols)
    dcols = int(round((EAST - WEST) / FINE_STEP))
    drows = int(round((NORTH - SOUTH) / FINE_STEP))
    dest = np.zeros((drows, dcols), dtype=np.float64)
    src_total = 0.0
    kept = 0.0
    report = max(1, rows // 20)
    for y in range(rows):
        arr = band.ReadAsArray(0, y, cols, 1)[0].astype(np.float64, copy=False)
        if nodata is not None:
            valid = arr != nodata
            src_total += float(arr[valid].sum())
            if not np.any(valid & (arr > 0)):
                if y % report == 0:
                    print(f'  row {y}/{rows}', flush=True)
                continue
            people = np.where(valid, arr, 0.0)
        else:
            src_total += float(arr.sum())
            people = arr
        if people.max() <= 0:
            continue
        yy = gt[3] + (y + 0.5) * gt[5]
        pts = ct.TransformPoints([(float(x), float(yy), 0.0) for x in xs])
        lons = np.interp(pix, lattice, [p[0] for p in pts])
        lats = np.interp(pix, lattice, [p[1] for p in pts])
        c = np.floor((lons - WEST) / FINE_STEP).astype(np.int32)
        r = np.floor((NORTH - lats) / FINE_STEP).astype(np.int32)
        m = (people > 0) & (c >= 0) & (c < dcols) & (r >= 0) & (r < drows)
        if np.any(m):
            np.add.at(dest, (r[m], c[m]), people[m])
            kept += float(people[m].sum())
        if y % report == 0:
            print(f'  row {y}/{rows} kept {kept:.0f}', flush=True)
    print(f'source people {src_total:.0f}  binned {kept:.0f}  dropped {src_total - kept:.0f}')
    return dest, WEST, NORTH, FINE_STEP, src_total


def read_geographic(path: str):
    gdal.UseExceptions()
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    people = band.ReadAsArray().astype(np.float64)
    nodata = band.GetNoDataValue()
    if nodata is not None:
        people[people == nodata] = 0
    people[people < 0] = 0
    gt = ds.GetGeoTransform()
    west, step, _, north, _, ystep = gt
    if ystep > 0:
        sys.exit('預期北在上')
    return people, west, north, abs(step), float(people.sum())


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit('用法：python3 scripts/build-pop-grid.py PopSE_China2020_100m.tif')
    ds = gdal.Open(sys.argv[1])
    if ds is None:
        sys.exit('無法開啟 GeoTIFF')
    srs = osr.SpatialReference(wkt=ds.GetProjection())
    ds = None
    if srs.IsGeographic():
        people, west, north, step, total = read_geographic(sys.argv[1])
    else:
        print('投影座標，逐列加總到 0.01° …')
        people, west, north, step, total = accumulate_albers(sys.argv[1])
    print(f'people total {total:.0f}  fine grid {people.shape[1]}x{people.shape[0]}  step {step}')
    rows, cols = people.shape
    area = row_areas(north, step, rows, cols)
    best = None
    for k in (1, 2, 3, 4, 5, 6, 8):
        if people.shape[0] < k or people.shape[1] < k:
            continue
        p, a = bin_sum(people, area, k)
        code = encode(p, a)
        raw_n = int(code.size)
        if raw_n > MAX_RAW:
            print(f'  k={k} raw {raw_n} 超過記憶體預算，略過')
            continue
        meta = {
            'west': west,
            'north': north,
            'step': step * k,
            'cols': int(code.shape[1]),
            'rows': int(code.shape[0]),
            'year': 2020,
            'logScale': LOG_SCALE,
            'unit': 'ppl_per_km2',
            'source': 'Chen et al. 2024 seventh census 100 m',
            'license': 'CC BY 4.0',
            'doi': '10.6084/m9.figshare.24916140',
            'aggregatedFromM': 100,
            'peopleTotal': round(total),
        }
        meta['east'] = meta['west'] + meta['cols'] * meta['step']
        meta['south'] = meta['north'] - meta['rows'] * meta['step']
        gz = gzip.compress(pack(meta, code), compresslevel=9)
        print(f'  k={k} step={meta["step"]:.4f}° {meta["cols"]}x{meta["rows"]} raw {raw_n} gzip {len(gz)}')
        if len(gz) <= MAX_GZIP and (best is None or k < best[0]):
            best = (k, gz, meta)
    if best is None:
        sys.exit('沒有任何解析度同時符合大小上限')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(best[1])
    print(f'wrote {OUT} k={best[0]} step={best[2]["step"]} gzip={len(best[1])}')


if __name__ == '__main__':
    main()
