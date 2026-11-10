#!/usr/bin/env python3
"""把七普 100 m 網格收成多級視窗圖磚（向量化加總，約數分鐘）。

c 0.04° 與 b 0.02° 整張進 Worker。m 0.01°、f 0.005°、n 0.001° 寫在 public/data/pop，
打包腳本排除，改由 R2（WM_POP）提供。

用法：python3 scripts/build-pop-tiles.py /path/to/PopSE_China2020_100m.tif
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
OUT = ROOT / 'public' / 'data' / 'pop'
WEST, SOUTH, EAST, NORTH = 73.0, 17.5, 135.5, 54.0
LOG_SCALE = 14


def row_area(lat, step):
    r = 6371.0088
    s1 = math.sin(math.radians(lat - step / 2))
    s2 = math.sin(math.radians(lat + step / 2))
    return (r * r) * math.radians(step) * abs(s2 - s1)


def encode_people(people, north, step):
    rows, cols = people.shape
    code = np.zeros((rows, cols), np.uint8)
    for i in range(rows):
        lat = north - (i + 0.5) * step
        area = row_area(lat, step)
        if area <= 0:
            continue
        dens = people[i].astype(np.float64) / area
        m = np.isfinite(dens) & (dens >= 1)
        if not np.any(m):
            continue
        code[i, m] = np.clip(np.rint(np.log2(dens[m]) * LOG_SCALE), 1, 255).astype(np.uint8)
    return code


def pack(meta, data: np.ndarray) -> bytes:
    body = json.dumps(meta, separators=(',', ':')).encode()
    return b'WMPOP1' + struct.pack('<HI', 1, len(body)) + body + np.ascontiguousarray(data).tobytes()


def accumulate(path, grids):
    """grids: list of (step, array row0=north)."""
    gdal.UseExceptions()
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    nodata = band.GetNoDataValue()
    src = osr.SpatialReference(wkt=ds.GetProjection())
    dst = osr.SpatialReference()
    dst.ImportFromEPSG(4326)
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    ct = osr.CoordinateTransformation(src, dst)
    gt = ds.GetGeoTransform()
    cols, rows = ds.RasterXSize, ds.RasterYSize
    stride = 32
    lattice = np.arange(0, cols, stride)
    if lattice[-1] != cols - 1:
        lattice = np.append(lattice, cols - 1)
    xs = gt[0] + (lattice + 0.5) * gt[1]
    pix = np.arange(cols)
    report = max(1, rows // 10)
    for y in range(rows):
        arr = band.ReadAsArray(0, y, cols, 1)[0]
        if nodata is not None:
            if not np.any((arr != nodata) & (arr > 0)):
                if y % report == 0:
                    print(f'  row {y}/{rows}', flush=True)
                continue
            people = np.where(arr == nodata, 0, arr).astype(np.float32)
        else:
            people = arr.astype(np.float32)
        if float(people.max()) <= 0:
            continue
        yy = gt[3] + (y + 0.5) * gt[5]
        pts = ct.TransformPoints([(float(x), float(yy), 0.0) for x in xs])
        lon = np.interp(pix, lattice, [p[0] for p in pts])
        lat = np.interp(pix, lattice, [p[1] for p in pts])
        inside = (lon >= WEST) & (lon < EAST) & (lat >= SOUTH) & (lat < NORTH) & (people > 0)
        if not np.any(inside):
            continue
        lon_i, lat_i, p_i = lon[inside], lat[inside], people[inside]
        for step, grid in grids:
            cc = np.floor((lon_i - WEST) / step).astype(np.int32)
            rr = np.floor((NORTH - lat_i) / step).astype(np.int32)
            h, w = grid.shape
            ok = (cc >= 0) & (cc < w) & (rr >= 0) & (rr < h)
            np.add.at(grid, (rr[ok], cc[ok]), p_i[ok])
        if y % report == 0:
            print(f'  row {y}/{rows}', flush=True)
    ds = None


def write_single(grid, step, name, level='c'):
    rows, cols = grid.shape
    code = encode_people(grid, NORTH, step)
    meta = {
        'west': WEST, 'north': NORTH, 'step': step, 'cols': cols, 'rows': rows,
        'year': 2020, 'logScale': LOG_SCALE, 'unit': 'ppl_per_km2', 'license': 'CC BY 4.0',
        'east': WEST + cols * step, 'south': NORTH - rows * step, 'level': level,
        'peopleTotal': int(round(float(grid.sum()))),
    }
    blob = gzip.compress(pack(meta, code), compresslevel=9)
    (OUT / name).write_bytes(blob)
    print(f'c {name} {len(blob)/1024:.0f} KB people {meta["peopleTotal"]}')
    return meta['peopleTotal']


def write_tiles(grid, step, tile_deg, level_id):
    rows, cols = grid.shape
    n = int(round(tile_deg / step))
    dest = OUT / level_id
    dest.mkdir(parents=True, exist_ok=True)
    kept = []
    total = 0
    n_iy = int(math.ceil((NORTH - SOUTH) / tile_deg))
    n_ix = int(math.ceil((EAST - WEST) / tile_deg))
    for iy in range(n_iy):
        tile_north = SOUTH + (iy + 1) * tile_deg
        r0 = int(round((NORTH - tile_north) / step))
        if r0 >= rows or r0 + n <= 0:
            continue
        r_a, r_b = max(0, r0), min(rows, r0 + n)
        for ix in range(n_ix):
            c0 = int(round((ix * tile_deg) / step))
            if c0 >= cols or c0 + n <= 0:
                continue
            c_a, c_b = max(0, c0), min(cols, c0 + n)
            sl = grid[r_a:r_b, c_a:c_b]
            if sl.size == 0 or float(sl.max()) <= 0:
                continue
            # 補成完整圖磚（邊緣塊可能比較短）
            people = np.zeros((n, n), np.float32)
            people[r_a - r0:r_a - r0 + sl.shape[0], c_a - c0:c_a - c0 + sl.shape[1]] = sl
            north = SOUTH + (iy + 1) * tile_deg
            west = WEST + ix * tile_deg
            code = encode_people(people, north, step)
            if int(code.max()) == 0:
                continue
            meta = {
                'west': west, 'north': north, 'step': step, 'cols': n, 'rows': n,
                'year': 2020, 'logScale': LOG_SCALE, 'unit': 'ppl_per_km2', 'license': 'CC BY 4.0',
                'east': west + n * step, 'south': north - n * step, 'level': level_id,
            }
            blob = gzip.compress(pack(meta, code), compresslevel=6)
            (dest / f'{ix}_{iy}.bin.gz').write_bytes(blob)
            kept.append(f'{ix}_{iy}')
            total += len(blob)
    print(f'{level_id} tiles {len(kept)} gzip {total/1024/1024:.1f} MB')
    return kept


def main():
    if len(sys.argv) < 2:
        sys.exit('用法：python3 scripts/build-pop-tiles.py PopSE.tif [--only-n]')
    only_n = '--only-n' in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    people = 0
    if not only_n:
        specs = [('c', 0.04), ('m', 0.01), ('f', 0.005)]
        grids = []
        for _id, step in specs:
            h = int(round((NORTH - SOUTH) / step))
            w = int(round((EAST - WEST) / step))
            print(f'alloc {_id} {w}x{h}')
            grids.append((step, np.zeros((h, w), np.float32)))
        print('pass 1: 0.04 / 0.01 / 0.005')
        accumulate(sys.argv[1], grids)
        people = write_single(grids[0][1], 0.04, 'c.bin.gz')
        write_tiles(grids[1][1], 0.01, 4, 'm')
        write_tiles(grids[2][1], 0.005, 2, 'f')
        del grids
    print('pass 2: 0.001 bands')
    step = 0.001
    tile = 1
    n = int(round(tile / step))
    width = int(round((EAST - WEST) / step))
    # 由北到南，每 1° 寫一列圖磚。用第二次掃描直接灌進目前這 1°。
    gdal.UseExceptions()
    ds = gdal.Open(sys.argv[1])
    band_r = ds.GetRasterBand(1)
    nodata = band_r.GetNoDataValue()
    src = osr.SpatialReference(wkt=ds.GetProjection())
    dst = osr.SpatialReference(); dst.ImportFromEPSG(4326)
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    ct = osr.CoordinateTransformation(src, dst)
    gt = ds.GetGeoTransform()
    cols, rows = ds.RasterXSize, ds.RasterYSize
    stride = 32
    lattice = np.arange(0, cols, stride)
    if lattice[-1] != cols - 1:
        lattice = np.append(lattice, cols - 1)
    xs = gt[0] + (lattice + 0.5) * gt[1]
    pix = np.arange(cols)
    n_dir = OUT / 'n'
    if only_n:
        import shutil
        shutil.rmtree(n_dir, ignore_errors=True)
    n_dir.mkdir(parents=True, exist_ok=True)
    bands = {}
    kept = []
    total_b = 0

    def flush(iy):
        nonlocal total_b
        arr = bands.pop(iy, None)
        if arr is None or float(arr.max()) <= 0:
            return
        north = SOUTH + (iy + 1) * tile
        n_ix = int(math.ceil(width / n))
        for ix in range(n_ix):
            sl = arr[:, ix * n:(ix + 1) * n]
            if sl.shape[1] == 0 or float(sl.max()) <= 0:
                continue
            people_t = np.zeros((n, n), np.float32)
            people_t[:, :sl.shape[1]] = sl
            west = WEST + ix * tile
            code = encode_people(people_t, north, step)
            if int(code.max()) == 0:
                continue
            meta = {
                'west': west, 'north': north, 'step': step, 'cols': n, 'rows': n,
                'year': 2020, 'logScale': LOG_SCALE, 'unit': 'ppl_per_km2', 'license': 'CC BY 4.0',
                'east': west + n * step, 'south': north - n * step, 'level': 'n',
            }
            blob = gzip.compress(pack(meta, code), compresslevel=6)
            (n_dir / f'{ix}_{iy}.bin.gz').write_bytes(blob)
            kept.append(f'{ix}_{iy}')
            total_b += len(blob)

    report = max(1, rows // 10)
    for y in range(rows):
        arr = band_r.ReadAsArray(0, y, cols, 1)[0]
        if nodata is not None:
            if not np.any((arr != nodata) & (arr > 0)):
                continue
            people = np.where(arr == nodata, 0, arr).astype(np.float32)
        else:
            people = arr.astype(np.float32)
        if float(people.max()) <= 0:
            continue
        yy = gt[3] + (y + 0.5) * gt[5]
        pts = ct.TransformPoints([(float(x), float(yy), 0.0) for x in xs])
        lon = np.interp(pix, lattice, [p[0] for p in pts])
        lat = np.interp(pix, lattice, [p[1] for p in pts])
        inside = (lon >= WEST) & (lon < EAST) & (lat >= SOUTH) & (lat < NORTH) & (people > 0)
        if not np.any(inside):
            continue
        lat_i = lat[inside]
        iy = np.floor((lat_i - SOUTH) / tile).astype(np.int32)
        iy_max = int(iy.max())
        cc = np.floor((lon[inside] - WEST) / step).astype(np.int32)
        p_in = people[inside]
        for iy_one in np.unique(iy):
            iy_one = int(iy_one)
            arr = bands.get(iy_one)
            if arr is None:
                arr = np.zeros((n, width), np.float32)
                bands[iy_one] = arr
            rr = np.floor(((SOUTH + (iy_one + 1) * tile) - lat_i) / step).astype(np.int32)
            ok = (iy == iy_one) & (cc >= 0) & (cc < width) & (rr >= 0) & (rr < n)
            if np.any(ok):
                np.add.at(arr, (rr[ok], cc[ok]), p_in[ok])
        for old in [k for k in bands if k > iy_max]:
            flush(old)
        if y % report == 0:
            print(f'  n row {y}/{rows} tiles {len(kept)} open {len(bands)}', flush=True)
    for old in list(bands):
        flush(old)
    print(f'n tiles {len(kept)} gzip {total_b/1024/1024:.1f} MB')

    index = {
        'west': WEST, 'south': SOUTH, 'east': EAST, 'north': NORTH,
        'logScale': LOG_SCALE, 'year': 2020, 'license': 'CC BY 4.0',
        'levels': [
            {'id': 'c', 'step': 0.04, 'tileDeg': 0, 'minZoom': 3, 'file': 'c.bin.gz'},
            {'id': 'm', 'step': 0.01, 'tileDeg': 4, 'minZoom': 8, 'tiles': m_kept if False else sorted(Path(OUT/'m').stem and [p.stem.replace('.bin','') for p in (OUT/'m').glob('*.bin.gz')])},
        ],
    }
    # 上面那行寫醜了，下面覆蓋
    def ids(folder):
        return sorted(p.name.replace('.bin.gz', '') for p in (OUT / folder).glob('*.bin.gz'))
    index['levels'] = [
        {'id': 'c', 'step': 0.04, 'tileDeg': 0, 'minZoom': 3, 'file': 'c.bin.gz'},
        {'id': 'b', 'step': 0.02, 'tileDeg': 0, 'minZoom': 6, 'file': 'b.bin.gz'},
        {'id': 'm', 'step': 0.01, 'tileDeg': 4, 'minZoom': 9, 'tiles': ids('m')},
        {'id': 'f', 'step': 0.005, 'tileDeg': 2, 'minZoom': 11, 'tiles': ids('f')},
        {'id': 'n', 'step': 0.001, 'tileDeg': 1, 'minZoom': 13.5, 'tiles': ids('n')},
    ]
    (OUT / 'index.json').write_text(json.dumps(index, separators=(',', ':')), encoding='utf-8')
    print('index', (OUT/'index.json').stat().st_size, 'bytes people-check', people)


if __name__ == '__main__':
    main()
