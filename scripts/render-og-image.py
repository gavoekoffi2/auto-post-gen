"""Rasterise public/og-image.svg to public/og-image.png.

Facebook, LinkedIn, WhatsApp and X do not render SVG og:image files — they
show no preview at all — so the shared card must be a raster PNG at the
1200x630 they expect.

Regenerate after editing the SVG:

    python3 scripts/render-og-image.py public/og-image.svg public/og-image.png

Only needs a Chromium binary (set CHROME_PATH to override the default) and
the standard library; the PNG crop is done here rather than pulling in an
image dependency for a file that changes once a year.
"""
import os, struct, subprocess, sys, zlib
from pathlib import Path

W, H = 1200, 630
CHROME = os.environ.get("CHROME_PATH") or "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
svg_path, out_path = Path(sys.argv[1]), Path(sys.argv[2])

tmp = Path(os.environ.get("TMPDIR", "/tmp"))
html = tmp / "_og.html"
html.write_text(
    '<!doctype html><html><head><meta charset="utf-8"><style>'
    '*{margin:0;padding:0;border:0}'
    f'html,body{{width:{W}px;height:{H}px;overflow:hidden}}'
    f'svg{{display:block;width:{W}px;height:{H}px}}'
    "</style></head><body>" + svg_path.read_text(encoding="utf-8") + "</body></html>",
    encoding="utf-8",
)

raw_png = tmp / "_og_raw.png"
# Probe the viewport shortfall instead of hardcoding it.
probe = tmp / "_probe.html"
probe.write_text(
    f'<!doctype html><html><head><style>*{{margin:0;padding:0}}'
    f'html,body{{background:#fff}}'
    f'#p{{width:{W}px;height:{H}px;background:#ff0000}}</style>'
    f'</head><body><div id="p"></div></body></html>',
    encoding="utf-8",
)


def shoot(src: Path, dst: Path, win_h: int) -> None:
    subprocess.run(
        [CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=1", f"--window-size={W},{win_h}",
         f"--screenshot={dst}", f"file://{src}"],
        check=True, capture_output=True,
    )


def read_png(path: Path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    idat, pos = b"", 8
    width = height = depth = color = None
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            width, height, depth, color = struct.unpack(">IIBB", body[:10])
        elif ctype == b"IDAT":
            idat += body
        pos += 12 + length
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color]
    assert depth == 8, "expected 8-bit PNG"
    return width, height, channels, zlib.decompress(idat)


def unfilter(width, height, channels, raw):
    stride = width * channels
    out, prev, pos = bytearray(), bytearray(stride), 0
    for _ in range(height):
        ftype = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            if ftype == 1: line[i] = (line[i] + a) & 0xFF
            elif ftype == 2: line[i] = (line[i] + b) & 0xFF
            elif ftype == 3: line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif ftype == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out += line
        prev = line
    return bytes(out)


def write_png(path: Path, width, height, channels, pixels):
    stride = width * channels
    raw = b"".join(b"\x00" + pixels[y * stride:(y + 1) * stride] for y in range(height))
    color = {1: 0, 3: 2, 4: 6}[channels]
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


# 1. Measure how many rows the viewport actually paints.
probe_png = tmp / "_probe.png"
shoot(probe, probe_png, H)
pw, ph, pch, praw = read_png(probe_png)
ppx = unfilter(pw, ph, pch, praw)
painted = 0
for y in range(ph):
    if ppx[y * pw * pch] > 200 and ppx[y * pw * pch + 1] < 60:
        painted = y + 1
shortfall = H - painted
print(f"viewport paints {painted}/{H} rows -> shortfall {shortfall}px")

# 2. Render tall enough that the real content area is exactly H, then crop.
# A generous margin costs nothing: we crop back to exactly H rows below.
shoot(html, raw_png, H + shortfall + 40)
rw, rh, rch, rraw = read_png(raw_png)
px = unfilter(rw, rh, rch, rraw)
stride = rw * rch
cropped = px[:H * stride]
write_png(out_path, W, H, rch, cropped)
print(f"wrote {out_path} ({out_path.stat().st_size} bytes) from a {rw}x{rh} render")
