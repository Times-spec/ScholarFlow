# -*- coding: utf-8 -*-
"""生成漫游有解 App 图标（各密度 PNG + 自适应图标），纯标准库实现。

图案：绿色圆角方块 + 白色指南针（圆环 + 指针 + 中心点），呼应"游览导航"。
做法：在 576px 画布上用有符号距离场（SDF）求覆盖率做抗锯齿，再用整数倍 box filter 下采样。
"""
import os
import struct
import zlib

BASE = 576  # 可被 192/144/96/72/48 整数整除
GREEN = (15, 111, 79)
WHITE = (255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def clamp01(x):
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


def rounded_rect_sdf(x, y, w, h, r):
    """圆角矩形 SDF：内部为负，边缘为 0"""
    dx = abs(x - w / 2) - (w / 2 - r)
    dy = abs(y - h / 2) - (h / 2 - r)
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    outside = (ax * ax + ay * ay) ** 0.5
    inside = min(max(dx, dy), 0.0)
    return outside + inside - r


def ring_alpha(x, y, cx, cy, radius, thickness):
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    return clamp01(thickness / 2 + 0.5 - abs(d - radius))


def needle_alpha(x, y, cx, cy, length, half_w, angle_deg):
    import math
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    # 转成针的局部坐标（针沿 +x 方向）
    lx = (x - cx) * ca + (y - cy) * sa
    ly = -(x - cx) * sa + (y - cy) * ca
    if lx < 0 or lx > length:
        return 0.0
    t = 1.0 - lx / length
    if abs(ly) <= half_w * t:
        return 1.0
    return 0.0


def build_rgba():
    px = [[TRANSPARENT for _ in range(BASE)] for _ in range(BASE)]
    margin = BASE * 0.02
    w = h = BASE - margin * 2
    r = BASE * 0.24
    cx = cy = BASE / 2.0
    SS = 3  # 超采样
    offsets = [(i + 0.5) / SS for i in range(SS)]

    for y in range(BASE):
        for x in range(BASE):
            cov_bg = 0.0
            cov_ring = 0.0
            cov_needle = 0.0
            cov_dot = 0.0
            for oy in offsets:
                for ox in offsets:
                    sx, sy = x + ox, y + oy
                    d = rounded_rect_sdf(sx - margin, sy - margin, w, h, r)
                    cov_bg += clamp01(0.5 - d)
                    cov_ring += ring_alpha(sx, sy, cx, cy, BASE * 0.30, BASE * 0.055)
                    cov_needle += needle_alpha(sx, sy, cx, cy, BASE * 0.30, BASE * 0.075, -50)
                    dd = ((sx - cx) ** 2 + (sy - cy) ** 2) ** 0.5
                    cov_dot += clamp01(BASE * 0.035 + 0.5 - dd)
            n = float(SS * SS)
            cov_bg, cov_ring, cov_needle, cov_dot = cov_bg / n, cov_ring / n, cov_needle / n, cov_dot / n
            white = clamp01(max(cov_ring, cov_needle, cov_dot))
            alpha = cov_bg
            if alpha <= 0.001:
                px[y][x] = TRANSPARENT
                continue
            rr = GREEN[0] * (1 - white) + WHITE[0] * white
            gg = GREEN[1] * (1 - white) + WHITE[1] * white
            bb = GREEN[2] * (1 - white) + WHITE[2] * white
            px[y][x] = (int(rr), int(gg), int(bb), int(round(alpha * 255)))
    return px


def downsample(px, factor):
    out_size = BASE // factor
    out = []
    for y in range(out_size):
        row = []
        for x in range(out_size):
            r = g = b = a = 0
            for dy in range(factor):
                for dx in range(factor):
                    p = px[y * factor + dy][x * factor + dx]
                    r += p[0] * p[3]
                    g += p[1] * p[3]
                    b += p[2] * p[3]
                    a += p[3]
            n = factor * factor
            if a == 0:
                row.append(TRANSPARENT)
            else:
                row.append((r // a, g // a, b // a, a // n))
        out.append(row)
    return out


def write_png(path, px):
    h = len(px)
    w = len(px[0])
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("BBBB", *px[y][x]) for x in range(w))
        for y in range(h)
    )

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    res = os.path.join(root, "app", "src", "main", "res")
    px = build_rgba()
    targets = [("mipmap-mdpi", 48, 12), ("mipmap-hdpi", 72, 8), ("mipmap-xhdpi", 96, 6),
               ("mipmap-xxhdpi", 144, 4), ("mipmap-xxxhdpi", 192, 3)]
    for folder, size, factor in targets:
        img = downsample(px, factor)
        path = os.path.join(res, folder, "ic_launcher.png")
        write_png(path, img)
        print("wrote", path, f"{size}x{size}")
    # 自适应图标（API 26+）：前景用同图，背景用纯色
    adaptive = os.path.join(res, "mipmap-anydpi-v26", "ic_launcher.xml")
    os.makedirs(os.path.dirname(adaptive), exist_ok=True)
    with open(adaptive, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                '    <background android:drawable="@color/ic_launcher_background" />\n'
                '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
                '</adaptive-icon>\n')
    # 前景图层：单独一张透明底 + 白色指南针（放在 108dp 画布的中间 72dp 安全区）
    fg = [[TRANSPARENT for _ in range(BASE)] for _ in range(BASE)]
    cx = cy = BASE / 2.0
    SS = 3
    for y in range(BASE):
        for x in range(BASE):
            acc = 0.0
            for oy in [(i + 0.5) / SS for i in range(SS)]:
                for ox in [(i + 0.5) / SS for i in range(SS)]:
                    sx, sy = x + ox, y + oy
                    v = max(
                        ring_alpha(sx, sy, cx, cy, BASE * 0.19, BASE * 0.04),
                        needle_alpha(sx, sy, cx, cy, BASE * 0.19, BASE * 0.05, -50),
                        clamp01(BASE * 0.025 + 0.5 - ((sx - cx) ** 2 + (sy - cy) ** 2) ** 0.5),
                    )
                    acc += v
            a = clamp01(acc / (SS * SS))
            fg[y][x] = (255, 255, 255, int(round(a * 255)))
    for folder, _, factor in targets:
        write_png(os.path.join(res, folder, "ic_launcher_foreground.png"), downsample(fg, factor))
    with open(os.path.join(res, "values", "colors.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                '    <color name="ic_launcher_background">#0F6F4F</color>\n</resources>\n')
    print("done")


if __name__ == "__main__":
    main()
