#!/usr/bin/env python3
"""Bake Hyphen hero art: background, logos, RSVP chrome, countdown boxes."""

from __future__ import annotations

import math
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
PUBLIC = ROOT / "public" / "brand"
LOGO_SRC = ASSETS / "logo-preview.png"

W, H = 1280, 720
BOLD = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
REGULAR = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
RSVP_URL = "https://events.hyphenonline.com/HyphenFestival2026#/buyTickets"

# Four separate boxes — keep the centres in sync with scripts/stream-countdown.sh
COUNT_X, COUNT_Y, BOX_W, BOX_H, BOX_GAP = 72, 508, 104, 92, 8
COUNT_FONT = 32


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def process_logo(src: Path) -> Image.Image:
    img = Image.open(src).convert("RGBA")
    pixels = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if r < 28 and g < 28 and b < 28:
                pixels[x, y] = (r, g, b, 0)
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    return img


def make_qr(url: str, size: int = 256) -> Image.Image:
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2, box_size=8)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    return img.resize((size, size), Image.Resampling.NEAREST)


def make_hero_bg(size: tuple[int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGB", size, (7, 10, 22))
    px = img.load()
    cx, cy = w * 0.72, h * 0.42
    for y in range(h):
        for x in range(w):
            dx = (x - cx) / w
            dy = (y - cy) / h
            r = math.hypot(dx * 1.15, dy)
            glow = max(0.0, 1.0 - r / 0.62) ** 2
            streak = (math.sin((x * 0.42 - y * 0.78) * 0.045) + 1) * 0.5
            streak *= max(0.0, 1.0 - abs(x / w - 0.62) * 1.2)
            r8 = int(lerp(7, 78, glow * 0.55 + streak * 0.12))
            g8 = int(lerp(10, 62, glow * 0.4 + streak * 0.1))
            b8 = int(lerp(22, 118, glow * 0.7 + streak * 0.18))
            px[x, y] = (r8, g8, b8)

    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for i in range(-8, 28):
        offset = i * 46
        alpha = 18 if i % 3 else 28
        draw.line(
            (-200 + offset, h + 40, w * 0.35 + offset, -80),
            fill=(210, 190, 230, alpha),
            width=2 if i % 2 else 1,
        )
    overlay = overlay.filter(ImageFilter.GaussianBlur(radius=1.2))
    img = Image.alpha_composite(img.convert("RGBA"), overlay)
    bar = ImageDraw.Draw(img)
    bar.rectangle((0, h - 5, w, h), fill=(255, 74, 26, 255))
    return img.convert("RGBA")


def rounded_rect(draw: ImageDraw.ImageDraw, box, radius, fill=None, outline=None, width=1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_icon_calendar(draw: ImageDraw.ImageDraw, x: float, y: float, size: float, fill) -> None:
    s = size
    draw.rounded_rectangle((x, y + s * 0.12, x + s, y + s), radius=s * 0.12, outline=fill, width=2)
    draw.line((x, y + s * 0.38, x + s, y + s * 0.38), fill=fill, width=2)
    draw.line((x + s * 0.28, y, x + s * 0.28, y + s * 0.28), fill=fill, width=2)
    draw.line((x + s * 0.72, y, x + s * 0.72, y + s * 0.28), fill=fill, width=2)


def draw_icon_clock(draw: ImageDraw.ImageDraw, x: float, y: float, size: float, fill) -> None:
    cx, cy, r = x + size / 2, y + size / 2, size * 0.46
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=fill, width=2)
    draw.line((cx, cy, cx, cy - r * 0.55), fill=fill, width=2)
    draw.line((cx, cy, cx + r * 0.42, cy + r * 0.2), fill=fill, width=2)


def draw_icon_pin(draw: ImageDraw.ImageDraw, x: float, y: float, size: float, fill) -> None:
    cx = x + size / 2
    draw.ellipse((x + size * 0.18, y, x + size * 0.82, y + size * 0.64), outline=fill, width=2)
    draw.line((cx, y + size * 0.64, cx, y + size), fill=fill, width=2)
    draw.ellipse((cx - size * 0.12, y + size * 0.22, cx + size * 0.12, y + size * 0.46), outline=fill, width=2)


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: float) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        trial = f"{current} {word}".strip()
        if draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [text]


def make_slate(bg: Image.Image, logo: Image.Image, qr: Image.Image) -> Image.Image:
    img = bg.copy()
    draw = ImageDraw.Draw(img)
    h1 = ImageFont.truetype(str(BOLD), 56)
    h4 = ImageFont.truetype(str(REGULAR), 24)
    rsvp_font = ImageFont.truetype(str(BOLD), 13)
    unit_font = ImageFont.truetype(str(REGULAR), 11)

    pad_x = 72
    y = 52
    badge = ImageFont.truetype(str(BOLD), 11)
    badge_box = (pad_x, y, pad_x + 148, y + 28)
    rounded_rect(draw, badge_box, 14, fill=(255, 255, 255, 255))
    draw.text((pad_x + 74, y + 14), "LIVE COUNTDOWN", font=badge, fill=(0, 0, 0, 255), anchor="mm")
    meta = ImageFont.truetype(str(REGULAR), 12)
    draw.text((pad_x + 164, y + 8), "2026-11-04    EUROPE/LONDON", font=meta, fill=(255, 255, 255, 110))

    y = 98
    draw.text((pad_x, y), "Hyphen Festival 2026", font=h1, fill=(255, 255, 255, 255))

    y = 186
    icon = 22
    rows = [
        (draw_icon_calendar, "Wed, 04 Nov, 2026"),
        (draw_icon_clock, "09:30 – 16:15"),
        (draw_icon_pin, "One Great George Street, London, United Kingdom"),
    ]
    for icon_fn, label in rows:
        icon_fn(draw, pad_x, y + 2, icon, (255, 255, 255, 255))
        lines = wrap_text(draw, label, h4, 620)
        ty = y
        for line in lines:
            draw.text((pad_x + 34, ty), line, font=h4, fill=(245, 245, 245, 255))
            ty += 28
        y = ty + 6

    btn = (pad_x, 392, pad_x + 148, 436)
    rounded_rect(draw, btn, 7, fill=(255, 60, 0, 255))
    draw.text((pad_x + 74, 414), "RSVP - Open", font=rsvp_font, fill=(255, 255, 255, 255), anchor="mm")

    qr_size = 62
    qr_x, qr_y = pad_x + 166, 386
    img.paste(qr.resize((qr_size, qr_size), Image.Resampling.NEAREST), (qr_x, qr_y))
    scan = ImageFont.truetype(str(BOLD), 9)
    draw.text((qr_x + qr_size / 2, qr_y + qr_size + 12), "SCAN TO JOIN", font=scan, fill=(255, 255, 255, 230), anchor="mm")

    labels = ("DAYS", "HOURS", "MINUTES", "SECONDS")
    for i, label in enumerate(labels):
        x = COUNT_X + i * (BOX_W + BOX_GAP)
        rounded_rect(draw, (x, COUNT_Y, x + BOX_W, COUNT_Y + BOX_H), 8, outline=(255, 255, 255, 230), width=2)
        draw.text((x + BOX_W / 2, COUNT_Y + BOX_H - 18), label, font=unit_font, fill=(220, 220, 220, 255), anchor="mm")

    for i, colour in enumerate(((0, 0, 0), (59, 89, 152), (10, 102, 194), (225, 48, 108), (255, 0, 51))):
        cx = pad_x + 16 + i * 36
        cy = 640
        draw.ellipse((cx - 14, cy - 14, cx + 14, cy + 14), outline=(255, 255, 255, 255), width=2)
        draw.ellipse((cx - 12, cy - 12, cx + 12, cy + 12), fill=colour + (255,))

    logo_w = 430
    ratio = logo_w / logo.size[0]
    logo_h = int(logo.size[1] * ratio)
    logo_fit = logo.resize((logo_w, logo_h), Image.Resampling.LANCZOS)
    lx = W - 56 - logo_w
    ly = (H - logo_h) // 2
    img.paste(logo_fit, (lx, ly), logo_fit)
    return img


def save_rgb(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(path, "PNG", optimize=True)
    print(f"Wrote {path} ({path.stat().st_size} bytes)")


def save_rgba(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"Wrote {path} ({path.stat().st_size} bytes)")


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    logo = process_logo(LOGO_SRC)
    save_rgba(logo, ASSETS / "hyphen-emerald.png")
    save_rgba(logo, PUBLIC / "hyphen-emerald.png")

    qr = make_qr(RSVP_URL, 256)
    save_rgb(qr, ASSETS / "rsvp-qr.png")
    save_rgb(qr, PUBLIC / "rsvp-qr.png")

    bg = make_hero_bg((W, H))
    save_rgb(bg, ASSETS / "hero-bg.png")
    save_rgb(bg, PUBLIC / "hero-bg.png")

    slate = make_slate(bg, logo, qr)
    save_rgb(slate, ASSETS / "countdown-slate.png")

    centers = [COUNT_X + i * (BOX_W + BOX_GAP) + BOX_W / 2 for i in range(4)]
    print(
        "countdown numbers: "
        + " ".join(f"x={c:.1f}" for c in centers)
        + f" y={COUNT_Y + 14} fontsize={COUNT_FONT}"
    )


if __name__ == "__main__":
    main()
