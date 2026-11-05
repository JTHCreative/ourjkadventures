#!/usr/bin/env python3
"""Turn a pin's SVG artwork into a 3D enamel pin model (.glb) for the "See in 3D" viewer.

How the SVG is read:
  - anything filled red (#ff0000), or outlined in red, becomes raised gold metal; a red line on an open
    curve (fill: none) stays an open curve
  - every other fill colour becomes a glossy enamel layer of that colour, stacked in drawing order
  - the outline of everything is the pin's gold back plate, with the post and rubber clutch from an
    existing model behind it

It builds the same layers, sizes and gold as the models already on the site, so a new pin sits the same way
in the viewer. Only run on our side, never on the site.

  pip install shapely mapbox-earcut svgelements      # once
  python3 scripts/svg-to-pin.py art.svg german-shepherd site/assets/3d/german-shepherd.glb
  npx @gltf-transform/cli@4.1.1 quantize --pattern "NORMAL" out.glb tmp.glb   # then slim it, as in docs/decisions.md
  npx @gltf-transform/cli@4.1.1 weld tmp.glb out.glb
"""
import json
import re
import struct
import sys
import xml.etree.ElementTree as ET

import mapbox_earcut as earcut
import numpy as np
import shapely
import shapely.affinity
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
from svgelements import Path, Move, Close

PIN_HEIGHT_M = 0.03833        # every pin on the site is this tall, edge of the gold rim to edge
DONOR = 'site/assets/3d/corgi.glb'   # where the post and rubber clutch come from

# heights in metres, matching the existing models
PLATE = (0.0, 0.0006)
PLATING = (0.0006, 0.00128)
ENAMEL_BOTTOM = 0.00095
ENAMEL_TOP = 0.0013
ENAMEL_STEP = 0.000008       # each later enamel sits a little higher, so overlaps never flicker in the viewer
LINES_TOP = 0.00145
BORDER_TOP = 0.00175

RED = (255, 0, 0)


def hex_rgb(h):
    h = h.strip().lstrip('#')
    if h.lower() == 'red':
        return RED
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def to_linear(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def read_classes(root):
    """The Illustrator <style> block: class name -> {fill, stroke, stroke-width}."""
    css = ''.join(s.text or '' for s in root.iter('{http://www.w3.org/2000/svg}style'))
    styles = {}
    for sel, body in re.findall(r'([^{}]+)\{([^}]*)\}', css):
        props = dict((k.strip(), v.strip()) for k, v in
                     (p.split(':', 1) for p in body.split(';') if ':' in p))
        for name in sel.split(','):
            name = name.strip().lstrip('.')
            styles.setdefault(name, {}).update(props)
    return styles


def path_polygon(d, tol=1.5):
    """SVG path -> shapely shape, even-odd fill. Curves are cut into short straight pieces."""
    rings, cur = [], []
    for seg in Path(d):
        if isinstance(seg, Move):
            if len(cur) > 2:
                rings.append(cur)
            cur = [(seg.end.x, seg.end.y)]
            continue
        if isinstance(seg, Close):
            if len(cur) > 2:
                rings.append(cur)
            cur = []
            continue
        # straight pieces stay one piece; curves are cut by how far apart their control points are
        pts = [q for q in (getattr(seg, k, None) for k in ('start', 'control1', 'control2', 'control', 'end')) if q is not None]
        rough = sum(((b.x - a.x) ** 2 + (b.y - a.y) ** 2) ** 0.5 for a, b in zip(pts, pts[1:]))
        n = 1 if type(seg).__name__ == 'Line' else max(2, min(64, int(rough / tol)))
        for t in np.linspace(0, 1, n + 1)[1:]:
            p = seg.point(t)
            cur.append((p.x, p.y))
    if len(cur) > 2:
        rings.append(cur)
    shape = None
    for r in rings:
        # make_valid keeps the hole when a shape's outer and inner edges are drawn as one continuous line
        p = unary_union(polys(shapely.make_valid(Polygon(r))))
        if p.is_empty:
            continue
        shape = p if shape is None else shape.symmetric_difference(p)
    # drop points closer than a quarter of a drawing unit to the line (about 0.01 mm on the pin)
    return shape.simplify(0.25) if shape is not None else None


def path_lines(d, tol=1.5):
    """SVG path -> the lines a stroke follows: one per piece, closed pieces as loops, open ones left open."""
    from shapely.geometry import LineString, LinearRing
    out, cur = [], []

    def finish(closed):
        if len(cur) > 1:
            out.append(LinearRing(cur) if closed and len(cur) > 2 else LineString(cur))

    for seg in Path(d):
        if isinstance(seg, Move):
            finish(False)
            cur = [(seg.end.x, seg.end.y)]
            continue
        if isinstance(seg, Close):
            finish(True)
            cur = []
            continue
        pts = [q for q in (getattr(seg, k, None) for k in ('start', 'control1', 'control2', 'control', 'end')) if q is not None]
        rough = sum(((b.x - a.x) ** 2 + (b.y - a.y) ** 2) ** 0.5 for a, b in zip(pts, pts[1:]))
        n = 1 if type(seg).__name__ == 'Line' else max(2, min(64, int(rough / tol)))
        for t in np.linspace(0, 1, n + 1)[1:]:
            q = seg.point(t)
            cur.append((q.x, q.y))
    finish(False)
    return out


def polys(shape):
    if shape is None or shape.is_empty:
        return []
    if isinstance(shape, Polygon):
        return [shape]
    out = []
    for g in getattr(shape, 'geoms', []):
        out += polys(g) if hasattr(g, 'geoms') else ([g] if isinstance(g, Polygon) and g.area > 1 else [])
    return out


def extrude(shape, z0, z1, to_world):
    """Solid prism of a flat shape between two heights, in metres. Returns positions, normals, indices."""
    P, N, I = [], [], []

    def add(verts, normal, tris):
        base = len(P)
        P.extend(verts)
        N.extend([normal] * len(verts))
        I.extend(base + t for t in tris)

    for poly in polys(shape):                 # drop specks while still in drawing units
        poly = shapely.affinity.affine_transform(poly, to_world)
        poly = shapely.geometry.polygon.orient(poly, 1.0)  # outer ring counter-clockwise, holes clockwise
        rings = [np.array(poly.exterior.coords[:-1])] + [np.array(r.coords[:-1]) for r in poly.interiors]
        flat = np.vstack(rings)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        tris = earcut.triangulate_float64(flat, ends).reshape(-1, 3)
        a, b, c = flat[tris[:, 0]], flat[tris[:, 1]], flat[tris[:, 2]]
        cw = ((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])) < 0
        tris[cw] = tris[cw][:, ::-1]           # every triangle counter-clockwise seen from the front
        add([(x, y, z1) for x, y in flat], (0, 0, 1), tris.flatten().tolist())
        add([(x, y, z0) for x, y in flat], (0, 0, -1), tris[:, ::-1].flatten().tolist())
        for ring in rings:
            for a, b in zip(ring, np.roll(ring, -1, axis=0)):
                dx, dy = b[0] - a[0], b[1] - a[1]
                ln = (dx * dx + dy * dy) ** 0.5
                if ln == 0:
                    continue
                add([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)],
                    (dy / ln, -dx / ln, 0), [0, 1, 2, 0, 2, 3])
    return np.array(P, np.float32), np.array(N, np.float32), np.array(I, np.uint32)


def read_glb(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    bin_start = 20 + jl + 8
    return j, b[bin_start:]


def main(svg_path, slug, out_path):
    root = ET.parse(svg_path).getroot()
    styles = read_classes(root)

    enamel, gold, fills = [], [], []
    for el in root.iter('{http://www.w3.org/2000/svg}path'):
        d = el.get('d') or ''
        st = styles.get((el.get('class') or '').strip(), {})
        has_fill = st.get('fill', '').lower() != 'none'   # "none" = an outline only, no enamel inside
        if has_fill:
            shape = path_polygon(d)
            if shape is not None and shape.area >= 50:   # skip stray slivers from the drawing program
                fill = hex_rgb(st['fill']) if 'fill' in st else (0, 0, 0)
                if fill == RED:
                    gold.append(shape)
                    fills.append(shape)
                else:
                    enamel.append((fill, shape))
        if st.get('stroke', '').lower() not in ('', 'none') and hex_rgb(st['stroke']) == RED:
            # a red outline is a gold line along the stroke itself, so open curves stay open
            w = float(re.sub('[^0-9.]', '', st.get('stroke-width', '1')))
            line = unary_union([l.buffer(w / 2, join_style='mitre', mitre_limit=4) for l in path_lines(d)])
            if line.area >= 50:
                gold.append(line.simplify(0.25))

    everything = unary_union([s for _, s in enamel] + gold)
    outline = Polygon(max(polys(everything), key=lambda p: p.area).exterior)
    # the outer rim is the gold that touches the pin's edge
    # the outer rim is the red fill that runs along the pin's edge; every other bit of gold is a line between colours
    edge = outline.exterior.buffer(2)
    border = max(fills, key=lambda f: f.intersection(edge).area)
    lines = unary_union([g for g in gold if g is not border]).difference(border).simplify(0.25)

    minx, miny, maxx, maxy = outline.bounds
    scale = PIN_HEIGHT_M / (maxy - miny)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    # drawing units -> metres, centred, with y turned to point up
    to_world = [scale, 0, 0, -scale, -cx * scale, cy * scale]

    donor, donor_bin = read_glb(DONOR)
    mats = [m for m in donor['materials'] if m['name'] in ('gold_backing', 'gold_plating', 'gold_lines', 'rubber_clutch')]
    mat_index = {m['name']: i for i, m in enumerate(mats)}
    enamel_mat = {}
    for fill, _ in enamel:
        if fill in enamel_mat:
            continue
        enamel_mat[fill] = len(mats)
        mats.append({
            'name': 'enamel_%02x%02x%02x' % fill,
            'pbrMetallicRoughness': {'baseColorFactor': [to_linear(c) for c in fill] + [1],
                                     'roughnessFactor': 0.22, 'metallicFactor': 0},
            'extensions': {'KHR_materials_clearcoat': {'clearcoatFactor': 0.6, 'clearcoatRoughnessFactor': 0.08}},
        })

    parts = [('base_plate', outline, PLATE, 'gold_backing'),
             ('gold_plating', outline, PLATING, 'gold_plating')]
    for i, (fill, shape) in enumerate(enamel):
        parts.append(('enamel_%02d' % (i + 1), shape, (ENAMEL_BOTTOM, ENAMEL_TOP + i * ENAMEL_STEP), enamel_mat[fill]))
    parts.append(('gold_lines', lines, (ENAMEL_BOTTOM, LINES_TOP), 'gold_lines'))
    parts.append(('gold_border', border, (0, BORDER_TOP), 'gold_plating'))

    blob = bytearray()
    views, accs, meshes, face_children = [], [], [], []
    nodes = []

    def push(arr, target):
        while len(blob) % 4:
            blob.append(0)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': arr.nbytes, 'target': target})
        blob.extend(arr.tobytes())
        return len(views) - 1

    for name, shape, (z0, z1), mat in parts:
        P, N, I = extrude(shape, z0, z1, to_world)
        if not len(I):
            continue
        pa = len(accs)
        accs.append({'bufferView': push(P, 34962), 'componentType': 5126, 'count': len(P), 'type': 'VEC3',
                     'min': P.min(0).tolist(), 'max': P.max(0).tolist()})
        accs.append({'bufferView': push(N, 34962), 'componentType': 5126, 'count': len(N), 'type': 'VEC3'})
        accs.append({'bufferView': push(I, 34963), 'componentType': 5125, 'count': len(I), 'type': 'SCALAR'})
        m = mat_index[mat] if isinstance(mat, str) else mat
        meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': pa, 'NORMAL': pa + 1}, 'indices': pa + 2, 'material': m}]})
        nodes.append({'name': name, 'mesh': len(meshes) - 1})
        face_children.append(len(nodes) - 1 + 3)

    # post and rubber clutch: copied as they are from the donor model
    back = []
    for dn in donor['nodes']:
        if dn.get('name') not in ('pin_post', 'rubber_clutch'):
            continue
        prim = donor['meshes'][dn['mesh']]['primitives'][0]
        attrs = {}
        for key in ('POSITION', 'NORMAL'):
            a = donor['accessors'][prim['attributes'][key]]
            v = donor['bufferViews'][a['bufferView']]
            kind = {5126: (np.float32, 1), 5122: (np.int16, 32767), 5120: (np.int8, 127)}[a['componentType']]
            size = np.dtype(kind[0]).itemsize
            stride = v.get('byteStride', 3 * size)
            raw = donor_bin[v.get('byteOffset', 0) + a.get('byteOffset', 0):]
            vals = np.array([np.frombuffer(raw[i * stride:i * stride + 3 * size], kind[0]) for i in range(a['count'])], np.float32)
            if a.get('normalized'):
                vals = np.maximum(vals / kind[1], -1.0)   # back to plain numbers, so no extension is needed
            attrs[key] = len(accs)
            acc = {'bufferView': push(vals, 34962), 'componentType': 5126, 'count': a['count'], 'type': 'VEC3'}
            if key == 'POSITION':
                acc.update(min=vals.min(0).tolist(), max=vals.max(0).tolist())
            accs.append(acc)
        a = donor['accessors'][prim['indices']]
        v = donor['bufferViews'][a['bufferView']]
        raw = donor_bin[v.get('byteOffset', 0) + a.get('byteOffset', 0):][:v['byteLength']]
        acc = {'componentType': a['componentType'], 'count': a['count'], 'type': 'SCALAR'}
        acc['bufferView'] = push(np.frombuffer(raw, np.uint8).copy(), 34963)
        accs.append(acc)
        meshes.append({'name': dn['name'], 'primitives': [{'attributes': attrs, 'indices': len(accs) - 1,
                                                           'material': mat_index[donor['materials'][prim['material']]['name']]}]})
        back.append({k: dn[k] for k in ('name', 'rotation', 'translation') if k in dn} | {'mesh': len(meshes) - 1})

    under = slug.replace('-', '_')
    n_parts = len(nodes)
    all_nodes = [
        {'name': under + '_pin', 'children': [1]},
        {'name': under + '_enamel_pin', 'translation': [0, PIN_HEIGHT_M / 2, 0],
         'children': [2] + [3 + n_parts + i for i in range(len(back))]},
        {'name': 'face', 'children': [3 + i for i in range(n_parts)]},
    ] + nodes + back

    while len(blob) % 4:
        blob.append(0)
    gltf = {
        'asset': {'version': '2.0', 'generator': 'j+k adventures scripts/svg-to-pin.py'},
        'extensionsUsed': ['KHR_materials_clearcoat'],
        'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': all_nodes, 'meshes': meshes, 'materials': mats,
        'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}],
    }
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js
    out += struct.pack('<II', len(blob), 0x004E4942) + bytes(blob)
    open(out_path, 'wb').write(out)
    print('%s: %d enamel layers, %d colours, %.1f x %.1f mm, %.2f MB' % (
        out_path, len(enamel), len(enamel_mat), (maxx - minx) * scale * 1000, PIN_HEIGHT_M * 1000, len(out) / 1e6))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
