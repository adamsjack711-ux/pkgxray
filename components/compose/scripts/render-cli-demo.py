"""Render paced playback of actual CLI output. Optional tooling: Pillow + Node.

Usage: python3 scripts/render-cli-demo.py /path/to/trusted/pkgxray
The selected scanner is executable code; target fixture programs stay inert.
"""
import os
from pathlib import Path
import subprocess
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    raise SystemExit(__doc__)
scanner = str(Path(sys.argv[1]).resolve())
result = subprocess.run(
    ["node", "examples/together.mjs", scanner], cwd=ROOT,
    text=True, capture_output=True, timeout=45, check=True,
)
fonts = [os.environ.get("COMPOSE_RAY_DEMO_FONT", ""),
         "/System/Library/Fonts/Menlo.ttc",
         "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
font_path = next((p for p in fonts if p and Path(p).is_file()), None)
if not font_path:
    raise SystemExit("Set COMPOSE_RAY_DEMO_FONT to a monospace TTF font.")
font = ImageFont.truetype(font_path, 16)
small = ImageFont.truetype(font_path, 13)
width, height, rows = 1080, 660, 22
frames, durations = [], []
poster = None
command = '$ node examples/together.mjs "$PKGXRAY_CHECKOUT"'


def frame(lines, duration):
    im = Image.new("RGB", (width, height), "#080f1d")
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((14, 14, width-14, height-14), 16, fill="#0d1728", outline="#29384f")
    d.rounded_rectangle((15, 15, width-15, 62), 15, fill="#18243a")
    d.rectangle((15, 45, width-15, 62), fill="#18243a")
    for x, color in [(37, "#ff6b70"), (59, "#f7c66a"), (81, "#67e8c2")]:
        d.ellipse((x, 31, x+10, 41), fill=color)
    d.text((115, 27), "compose-ray  /  pkgxray integration", font=font, fill="#d7e3f5")
    for i, line in enumerate(lines[-rows:]):
        color = "#b8c8df"
        if line.startswith("$") or "All four" in line: color = "#67e8c2"
        elif "decision=block" in line: color = "#ff8792"
        elif "REVIEW" in line or "incomplete" in line: color = "#f7c66a"
        elif any(word in line for word in ["source:", "sink:", "CROSS-PACKAGE", "CONTROL CASES"]): color = "#67e8c2"
        elif "return:" in line or "call:" in line: color = "#99b7ff"
        d.text((34, 82+i*24), line, font=font, fill=color)
    d.line((34, 621, width-34, 621), fill="#29384f")
    d.text((34, 629), "REAL CLI OUTPUT  /  paced playback  /  synthetic packages, no target code executed", font=small, fill="#8ca2bd")
    frames.append(im)
    durations.append(duration)


frame(["$ ▌"], 700)
for n in range(4, len(command)+4, 4):
    frame([command[:n] + (" ▌" if n < len(command) else "")], 65)
lines = [command, ""]
frame(lines, 700)
output = []
for line in result.stdout.splitlines():
    output.extend(textwrap.wrap(line, width=103, replace_whitespace=False,
                               drop_whitespace=False, subsequent_indent="      ") or [""])
for start in range(0, len(output), 3):
    chunk = output[start:start+3]
    lines.extend(chunk)
    hold = 1500 if any("sink:" in line or "CONTROL CASES" in line for line in chunk) else 550
    frame(lines, hold)
    if any("Destination:" in line for line in chunk):
        poster = frames[-1]
durations[-1] = 4500
destination = ROOT / "docs/assets/cli-demo.gif"
destination.parent.mkdir(parents=True, exist_ok=True)
frames[0].save(destination, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
(poster or frames[-1]).save(destination.with_suffix(".png"))
print(f"{destination}: {len(frames)} frames, {sum(durations)/1000:.1f}s, {destination.stat().st_size//1024} KiB")
