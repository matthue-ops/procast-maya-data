"""Regenerate original Procast icons. Development only: requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parent.parent / 'icons'
root.mkdir(exist_ok=True)
image = Image.new('RGB', (1024, 1024), '#0f172a')
draw = ImageDraw.Draw(image)
draw.ellipse((160, 160, 864, 864), fill='#2563eb')
draw.rounded_rectangle((404, 324, 640, 552), radius=84, fill='white')
draw.rectangle((404, 324, 464, 700), fill='white')
draw.rounded_rectangle((464, 384, 576, 492), radius=32, fill='#2563eb')
for name, size in [('procast-192.png',192), ('procast-512.png',512),
                   ('procast-maskable-512.png',512), ('apple-touch-icon.png',180)]:
    image.resize((size,size), Image.Resampling.LANCZOS).save(root/name, optimize=True)
