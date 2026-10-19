#!/usr/bin/env python3
"""Make an AxiDraw calibration sheet for spring-loaded pen pressure.

With a spring (the AxiDraw spring kit, or a spring-loaded pen holder), the pen-down height can change how hard the pen
presses - but only over a narrow band between first touching the paper and the point where the lift arm lets go of the
pen; below that the force stays the same. This sheet shows where that band is for your pen and paper. This writes an SVG with one row of test marks per pen-down height, each row
in its own AxiDraw layer whose name sets that height (e.g. "3+H35 ..."), so the whole sheet plots in one go:

  - a straight line, to measure line width
  - a wave, to see how the pen behaves through curves and changes of direction
  - two hatched patches (lines spaced about 1 mm and 0.5 mm apart), to judge how dark an area of strokes comes out
  - a run of short dashes, to see how the line starts and ends (blobs or skips when the pen touches down)

Each row is labelled with its height, drawn in single strokes on a separate layer at a light pressure. Plot it, then
measure each row's line width and judge the patches' darkness - that's the lookup from height to line width/value.

AxiDraw heights run 0-100, where LOWER numbers lower the pen further. Within the band described above, lower numbers
press harder; look for the row where the line stops getting darker. Keep every height below your pen-up height.

The pen LOWERING rate can't be set per layer (only height +H and drawing speed +S can) - set it for the whole plot in
AxiDraw Control > Options > Timing ("pen lowering rate"), or with axicli's --pen_rate_lower. With a spring, a slow rate
avoids a blob or a hard landing at the start of each stroke: plot the sheet at two or three rates and compare the dashes.

Usage:
    python3 axidraw_calibration.py                         # A4 landscape, heights 50 down to 10 in steps of 5
    python3 axidraw_calibration.py --speed 20              # also fix the pen-down drawing speed on every row
    python3 axidraw_calibration.py --heights 60,50,40,35,30,25,20,15,10
    python3 axidraw_calibration.py --page A5 --portrait --label-height 55 -o sheet.svg

Open the SVG in Inkscape and plot all layers with the AxiDraw extension (or `axicli sheet.svg --mode layers`, etc.).
"""

import argparse
import math
import sys

PAGES_MM = {"A3": (420, 297), "A4": (297, 210), "A5": (210, 148), "LETTER": (279.4, 215.9)}

# Single-stroke digits on a 2 x 4 unit grid (seven-segment style), as lists of polylines
DIGITS = {
    "0": [[(0, 0), (2, 0), (2, 4), (0, 4), (0, 0)]],
    "1": [[(1, 0), (1, 4)]],
    "2": [[(0, 0), (2, 0), (2, 2), (0, 2), (0, 4), (2, 4)]],
    "3": [[(0, 0), (2, 0), (2, 4), (0, 4)], [(0, 2), (2, 2)]],
    "4": [[(0, 0), (0, 2), (2, 2)], [(2, 0), (2, 4)]],
    "5": [[(2, 0), (0, 0), (0, 2), (2, 2), (2, 4), (0, 4)]],
    "6": [[(2, 0), (0, 0), (0, 4), (2, 4), (2, 2), (0, 2)]],
    "7": [[(0, 0), (2, 0), (2, 4)]],
    "8": [[(0, 0), (2, 0), (2, 4), (0, 4), (0, 0)], [(0, 2), (2, 2)]],
    "9": [[(2, 2), (0, 2), (0, 0), (2, 0), (2, 4), (0, 4)]],
    "H": [[(0, 0), (0, 4)], [(2, 0), (2, 4)], [(0, 2), (2, 2)]],
}


def parse_heights(text):
    try:
        heights = [int(h) for h in text.split(",") if h.strip()]
    except ValueError:
        raise argparse.ArgumentTypeError("heights must be whole numbers separated by commas, e.g. 50,40,30")
    if not heights or any(h < 0 or h > 100 for h in heights):
        raise argparse.ArgumentTypeError("heights must be between 0 and 100")
    return heights


def polyline(points):
    return '<polyline fill="none" points="' + " ".join(f"{x:.2f},{y:.2f}" for x, y in points) + '"/>'


def text_strokes(text, x, y, height):
    """Single-stroke text (digits and 'H' only), top-left at (x, y), characters `height` mm tall."""
    unit = height / 4.0
    out = []
    for ch in text:
        for stroke in DIGITS.get(ch, []):
            out.append(polyline([(x + px * unit, y + py * unit) for px, py in stroke]))
        x += 3.2 * unit
    return out


def hatch(x, y, width, height, spacing):
    """Back-and-forth (boustrophedon) vertical hatching, so the pen stays down across the whole patch."""
    points = []
    count = max(2, int(round(width / spacing)) + 1)
    for i in range(count):
        px = x + i * width / (count - 1)
        points += [(px, y), (px, y + height)] if i % 2 == 0 else [(px, y + height), (px, y)]
    return [polyline(points)]


def wave(x, y, width, amplitude, cycles=3, steps=120):
    return [polyline([(x + width * t / steps, y + amplitude * math.sin(2 * math.pi * cycles * t / steps)) for t in range(steps + 1)])]


def dashes(x, y, width, dash=2.0, gap=2.0):
    out, px = [], x
    while px + dash <= x + width:
        out.append(polyline([(px, y), (px + dash, y)]))
        px += dash + gap
    return out


def layer(number, height, label, elements, plotted=True, speed=None):
    codes = (f"+H{height}" if height is not None else "") + (f"+S{speed}" if speed is not None else "")
    name = f"{'' if plotted else '%'}{number}{codes} {label}"
    body = "\n    ".join(elements)
    return (f'  <g inkscape:groupmode="layer" inkscape:label="{name}" id="layer{number}">\n'
            f'    {body}\n  </g>')


def main():
    parser = argparse.ArgumentParser(description="Make an AxiDraw spring-pressure calibration sheet (SVG).")
    parser.add_argument("--heights", type=parse_heights, default=parse_heights("50,45,40,35,30,25,20,15,10"),
                        help="pen-down heights to test, comma-separated, 0-100, lower = more pressure (default 50 down to 10 in 5s)")
    parser.add_argument("--label-height", type=int, default=None,
                        help="pen-down height for the row labels (default: the lightest test height)")
    parser.add_argument("--speed", type=int, default=None,
                        help="pen-down drawing speed for every row, 1-100 (default: the AxiDraw's own setting). Keep it the same as you'll use for real plots, since speed changes ink flow and line width too")
    parser.add_argument("--page", default="A4", choices=sorted(PAGES_MM), help="paper size (default A4)")
    parser.add_argument("--portrait", action="store_true", help="portrait instead of landscape")
    parser.add_argument("--margin", type=float, default=15.0, help="page margin in mm (default 15)")
    parser.add_argument("-o", "--output", default="axidraw_calibration.svg", help="output SVG path")
    args = parser.parse_args()

    page_w, page_h = PAGES_MM[args.page]
    if args.portrait:
        page_w, page_h = min(page_w, page_h), max(page_w, page_h)
    heights = args.heights
    label_height = args.label_height if args.label_height is not None else max(heights)
    if not 0 <= label_height <= 100:
        sys.exit("--label-height must be between 0 and 100")
    if args.speed is not None and not 1 <= args.speed <= 100:
        sys.exit("--speed must be between 1 and 100")

    margin = args.margin
    usable_w, usable_h = page_w - 2 * margin, page_h - 2 * margin - 12  # leave room for the title note
    row_h = usable_h / len(heights)
    if row_h < 8:
        sys.exit(f"Too many heights for this page: {len(heights)} rows would be only {row_h:.1f} mm tall. Use fewer heights or a bigger page.")
    mark_h = min(12.0, row_h * 0.7)

    # Column layout across the row: label | straight line | wave | hatch 1 mm | hatch 0.5 mm | dashes
    label_w = 14.0
    gap = 6.0
    remaining = usable_w - label_w - 5 * gap
    line_w, wave_w, patch_w, dash_w = remaining * 0.24, remaining * 0.24, remaining * 0.14, remaining * 0.24
    columns_x = [margin + label_w + gap]
    for w in (line_w, wave_w, patch_w, patch_w):
        columns_x.append(columns_x[-1] + w + gap)

    layers = []
    labels = []
    for i, h in enumerate(heights):
        top = margin + 12 + i * row_h + (row_h - mark_h) / 2
        mid = top + mark_h / 2
        labels += text_strokes(str(h), margin, top + (mark_h - min(mark_h, 7)) / 2, min(mark_h, 7))
        elements = []
        elements.append(polyline([(columns_x[0], mid), (columns_x[0] + line_w, mid)]))
        elements += wave(columns_x[1], mid, wave_w, mark_h * 0.4)
        elements += hatch(columns_x[2], top, patch_w, mark_h, 1.0)
        elements += hatch(columns_x[3], top, patch_w, mark_h, 0.5)
        elements += dashes(columns_x[4], mid, dash_w)
        layers.append(layer(i + 2, h, f"height {h}", elements, speed=args.speed))

    note_lines = [
        "AxiDraw spring-pressure calibration - each row is a pen-down height (lower number = pen lower = more pressure).",
        f"Columns: line | wave | hatch 1 mm | hatch 0.5 mm | dashes. Row labels plot at height {label_height}. This note isn't plotted.",
        "The pen lowering rate isn't set per layer - set it in AxiDraw Options > Timing (or --pen_rate_lower), slow for clean starts;"
        " compare the dashes column at different rates.",
    ]
    note = ('  <g inkscape:groupmode="layer" inkscape:label="%0 notes - not plotted" id="layer0">\n' +
            "".join(f'    <text x="{margin}" y="{margin + 3 + 4 * i}" font-family="sans-serif" font-size="2.8" fill="#888">{line}</text>\n'
                    for i, line in enumerate(note_lines)) +
            '  </g>')

    svg = "\n".join([
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
        f'width="{page_w}mm" height="{page_h}mm" viewBox="0 0 {page_w} {page_h}">',
        '<style>polyline { stroke: #000; stroke-width: 0.3; stroke-linecap: round; stroke-linejoin: round; }</style>',
        note,
        layer(1, label_height, "labels", labels, speed=args.speed),
        *layers,
        "</svg>",
        "",
    ])
    with open(args.output, "w") as f:
        f.write(svg)
    print(f"Wrote {args.output}: {args.page} {'portrait' if args.portrait else 'landscape'}, "
          f"{len(heights)} heights ({', '.join(map(str, heights))}), labels at height {label_height}.")


if __name__ == "__main__":
    main()
