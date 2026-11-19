#!/usr/bin/env python3
"""
Builds media/sshm-icons.woff and the `contributes.icons` block of package.json.

A quick pick cannot color an icon or put a badge on it, but it can show a glyph of a color font
(COLR/CPAL). So every host icon gets one glyph per color and status: the icon in its color, a notch
in its lower right corner, and the status dot in it. `$(sshm-server-blue-up)` then works in any label.

Icon outlines come from @vscode/codicons (c) Microsoft Corporation, CC BY 4.0.

    pip install fonttools skia-pathops
    python3 scripts/build-icon-font.py path/to/codicon.ttf path/to/codicon.csv
"""
import csv, json, os, re, sys
import pathops
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = ['server', 'vm', 'database', 'cloud', 'home', 'device-desktop', 'device-mobile', 'globe', 'terminal',
         'package', 'rocket', 'beaker', 'shield', 'key', 'lock', 'link', 'broadcast', 'plug', 'organization',
         'code', 'tools', 'flame', 'heart', 'star-full', 'circle-filled', 'folder', 'folder-library']
# one palette for dark and light themes: mid tones that read on both
COLORS = {'red': '#e5534b', 'orange': '#d18616', 'yellow': '#d4a72c', 'green': '#46a758', 'blue': '#3b8eea', 'purple': '#a371f7'}
STATUS = {'up': '#2da44e', 'down': '#f04438', 'mixed': '#e3a008'}
UPM = 300            # the codicon em: a 16 px icon is 300 units
U = UPM / 16
DOT = (12.25 * U, UPM - 12.25 * U, 2.5 * U)
NOTCH = (DOT[0], DOT[1], 4.0 * U)
ALIAS = {'device-desktop': 'vm'}   # same shape under another name
FONT_FILE = 'media/sshm-icons.woff'


def circle(pen, cx, cy, r, n=8):
    import math
    pts = []
    for i in range(n):
        a0 = 2 * math.pi * i / n
        a1 = 2 * math.pi * (i + 1) / n
        am = (a0 + a1) / 2
        k = r / math.cos((a1 - a0) / 2)
        pts.append(((cx + k * math.cos(am), cy + k * math.sin(am)), (cx + r * math.cos(a1), cy + r * math.sin(a1))))
    pen.moveTo((cx + r, cy))
    for ctrl, end in pts:
        pen.qCurveTo(ctrl, end)
    pen.closePath()


def to_glyph(path):
    pen = TTGlyphPen(None)
    path.draw(pen)
    return pen.glyph()


def rgba(hex_):
    return tuple(int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)) + (1.0,)


def main(ttf, names):
    src = TTFont(ttf)
    cmap, glyphs = src.getBestCmap(), src.getGlyphSet()
    code = {r['short_name']: int(r['unicode'], 16) for r in csv.DictReader(open(names))}

    palette = list(COLORS) + list(STATUS)
    hexes = {**COLORS, **STATUS}
    order, outlines, layers, chars = ['.notdef'], {'.notdef': TTGlyphPen(None).glyph()}, {}, {}

    def add(name, glyph):
        order.append(name)
        outlines[name] = glyph

    dot = pathops.Path()
    circle(dot.getPen(), *DOT)
    add('dot', to_glyph(dot))
    hole = pathops.Path()
    circle(hole.getPen(), *NOTCH)

    cp = 0xE000
    for icon in ICONS:
        whole = pathops.Path()
        glyphs[cmap[code[ALIAS.get(icon, icon)]]].draw(whole.getPen())
        whole.simplify(fix_winding=True)
        add(f'i.{icon}', to_glyph(whole))
        add(f'n.{icon}', to_glyph(pathops.op(whole, hole, pathops.PathOp.DIFFERENCE, fix_winding=True)))
        for color in ['plain'] + list(COLORS):
            ink = 0xFFFF if color == 'plain' else palette.index(color)   # 0xFFFF = the text color
            for status in ['none'] + list(STATUS):
                if color == 'plain' and status == 'none':
                    continue  # that is the built-in icon
                name = f'sshm-{icon}-{color}-{status}'
                add(name, TTGlyphPen(None).glyph())
                layers[name] = [(f'i.{icon}', ink)] if status == 'none' else [(f'n.{icon}', ink), ('dot', palette.index(status))]
                chars[name] = cp
                cp += 1

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({c: n for n, c in chars.items()})
    fb.setupGlyf(outlines)
    # the left side bearing must be the outline's own left edge, or the renderer shifts the glyph
    glyf = fb.font['glyf']
    fb.setupHorizontalMetrics({n: (UPM, getattr(glyf[n], 'xMin', 0) if glyf[n].numberOfContours else 0) for n in order})
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    fb.setupNameTable({'familyName': 'sshm-icons', 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, usWinAscent=UPM, usWinDescent=0)
    fb.setupPost()
    fb.font['COLR'] = buildCOLR(layers, version=0)
    fb.font['CPAL'] = buildCPAL([[rgba(hexes[p]) for p in palette]])
    fb.font.flavor = 'woff'
    fb.save(os.path.join(ROOT, FONT_FILE))

    pkg_file = os.path.join(ROOT, 'package.json')
    text = open(pkg_file).read()
    pkg = json.loads(text)
    pkg['contributes']['icons'] = {
        name: {'description': 'SSH Config Manager: ' + name[5:].replace('-', ' '), 'default': {'fontPath': FONT_FILE, 'fontCharacter': '\\%04X' % c}}
        for name, c in chars.items()
    }
    out = json.dumps(pkg, indent=2, ensure_ascii=False)
    # one line per icon: 700 entries would otherwise be 5000 lines
    out = re.sub(r'("sshm-[a-z-]+": )\{\s*("description": "[^"]*"),\s*"default": \{\s*("fontPath": "[^"]*"),\s*("fontCharacter": "[^"]*")\s*\}\s*\}',
                 r'\1{ \2, "default": { \3, \4 } }', out)
    open(pkg_file, 'w').write(out + '\n')
    print(len(chars), 'icons ->', FONT_FILE, os.path.getsize(os.path.join(ROOT, FONT_FILE)), 'bytes')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
