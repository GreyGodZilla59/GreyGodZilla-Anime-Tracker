"""Generate Windows ICO + Android launcher icons from greygodzilla_logo.png."""
from pathlib import Path
import shutil

from PIL import Image

ROOT = Path(__file__).resolve().parent
logo_path = ROOT / "greygodzilla_logo.png"
ico_path = ROOT / "greygodzilla_icon.ico"
android_res = ROOT.parent / "mobile" / "android" / "app" / "src" / "main" / "res"
www_assets = ROOT.parent / "mobile" / "www" / "assets"


def square_pad(im: Image.Image, size: int) -> Image.Image:
    im = im.copy()
    im.thumbnail((size, size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (10, 10, 10, 255))
    x = (size - im.width) // 2
    y = (size - im.height) // 2
    canvas.paste(im, (x, y), im)
    return canvas


def main():
    img = Image.open(logo_path).convert("RGBA")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    icons = [square_pad(img, s) for s in sizes]
    icons[-1].save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"Wrote {ico_path} ({ico_path.stat().st_size} bytes)")

    mipmap_sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in mipmap_sizes.items():
        d = android_res / folder
        d.mkdir(parents=True, exist_ok=True)
        icon = square_pad(img, size)
        for name in ("ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"):
            icon.save(d / name, format="PNG")
        print(f"Android {folder} {size}px")

    www_assets.mkdir(parents=True, exist_ok=True)
    shutil.copy2(logo_path, www_assets / "greygodzilla_logo.png")
    shutil.copy2(ico_path, www_assets / "greygodzilla_icon.ico")
    print("www assets updated")


if __name__ == "__main__":
    main()
