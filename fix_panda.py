import sys
import re

file_path = "extension/webview/main.js"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# Define the new bipedal standing SVG definitions with purple branding
new_content = """  // ── Standing buddy panda SVGs (viewBox 0 0 100 120) ────
  // Panda is standing bipedal, facing slightly right or forward, looking very cute.

  var BUDDY_BASE_DEFS = '<defs><radialGradient id="pd-blsh" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ff9999" stop-opacity="0.6"/><stop offset="100%" stop-color="#ff9999" stop-opacity="0"/></radialGradient></defs>';

  var BUDDY_IDLE = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 60 C 15 75, 10 90, 20 95 C 28 98, 30 80, 32 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 60 C 85 75, 90 90, 80 95 C 72 98, 70 80, 68 70 Z" fill="#7B8EC8"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8"/><circle cx="80" cy="30" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<circle cx="33" cy="50" r="6" fill="#fff"/><circle cx="67" cy="50" r="6" fill="#fff"/>' +
    '<circle cx="34" cy="50" r="3.5" fill="#3B4A7A"/><circle cx="66" cy="50" r="3.5" fill="#3B4A7A"/>' +
    '<circle cx="35" cy="48" r="1.5" fill="#fff"/><circle cx="65" cy="48" r="1.5" fill="#fff"/>' +
    '<path d="M 46 60 Q 50 57, 54 60 Q 55 62, 50 64 Q 45 62, 46 60 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 64 L 50 69" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M 45 69 Q 50 73, 55 69" stroke="#3B4A7A" stroke-width="1.5" fill="none" stroke-linecap="round"/>' +
    '<circle cx="20" cy="62" r="8" fill="url(#pd-blsh)"/><circle cx="80" cy="62" r="8" fill="url(#pd-blsh)"/>' +
    '</svg>';

  var BUDDY_THINKING = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 60 C 15 75, 10 90, 20 95 C 28 98, 30 80, 32 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 60 C 85 70, 80 50, 72 50 C 68 50, 65 55, 62 65 Z" fill="#7B8EC8"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8"/><circle cx="80" cy="30" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<circle cx="33" cy="50" r="6" fill="#fff"/><circle cx="67" cy="50" r="6" fill="#fff"/>' +
    '<circle cx="36" cy="46" r="3.5" fill="#3B4A7A"/><circle cx="70" cy="46" r="3.5" fill="#3B4A7A"/>' +
    '<circle cx="37" cy="44" r="1.5" fill="#fff"/><circle cx="71" cy="44" r="1.5" fill="#fff"/>' +
    '<path d="M 46 60 Q 50 57, 54 60 Q 55 62, 50 64 Q 45 62, 46 60 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 64 L 50 67" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="20" cy="62" r="8" fill="url(#pd-blsh)"/><circle cx="80" cy="62" r="8" fill="url(#pd-blsh)"/>' +
    '<circle cx="88" cy="20" r="3" fill="#888" opacity="0.4"/>' +
    '<circle cx="95" cy="14" r="2" fill="#888" opacity="0.3"/>' +
    '<text x="82" y="10" font-size="20" fill="#888" font-family="sans-serif" opacity="0.6">?</text>' +
    '</svg>';

  var BUDDY_WORKING = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 60 C 10 70, 20 85, 38 82 C 32 75, 25 70, 28 65 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 60 C 90 70, 80 85, 62 82 C 68 75, 75 70, 72 65 Z" fill="#7B8EC8"/>' +
    '<rect x="30" y="80" width="40" height="10" rx="3" fill="#4a5568"/>' +
    '<rect x="33" y="82" width="34" height="6" rx="1" fill="#a0aec0"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8"/><circle cx="80" cy="30" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<rect x="23" y="42" width="22" height="16" rx="6" fill="#fff" stroke="#3B4A7A" stroke-width="2.5"/>' +
    '<rect x="55" y="42" width="22" height="16" rx="6" fill="#fff" stroke="#3B4A7A" stroke-width="2.5"/>' +
    '<path d="M 45 50 L 55 50" stroke="#3B4A7A" stroke-width="2.5"/>' +
    '<circle cx="34" cy="50" r="3.5" fill="#3B4A7A"/><circle cx="66" cy="50" r="3.5" fill="#3B4A7A"/>' +
    '<circle cx="35" cy="48" r="1.5" fill="#fff"/><circle cx="67" cy="48" r="1.5" fill="#fff"/>' +
    '<path d="M 46 60 Q 50 57, 54 60 Q 55 62, 50 64 Q 45 62, 46 60 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 64 L 50 67" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M 45 67 Q 50 71, 55 67" stroke="#3B4A7A" stroke-width="1.5" fill="none" stroke-linecap="round"/>' +
    '<circle cx="20" cy="62" r="8" fill="url(#pd-blsh)"/><circle cx="80" cy="62" r="8" fill="url(#pd-blsh)"/>' +
    '<path d="M 20 80 L 25 75 M 80 80 L 75 75 M 25 90 L 20 95 M 75 90 L 80 95" stroke="#3498db" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  var BUDDY_HAPPY = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<g transform="translate(0, -5)">' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 55 C 10 35, 5 20, 20 20 C 30 20, 35 45, 30 55 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 55 C 90 35, 95 20, 80 20 C 70 20, 65 45, 70 55 Z" fill="#7B8EC8"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8"/><circle cx="80" cy="30" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<path d="M 28 50 Q 33 42, 38 50" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>' +
    '<path d="M 62 50 Q 67 42, 72 50" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>' +
    '<path d="M 45 61 Q 50 78, 55 61 Z" fill="#ff7675"/>' +
    '<circle cx="20" cy="60" r="10" fill="url(#pd-blsh)"/><circle cx="80" cy="60" r="10" fill="url(#pd-blsh)"/>' +
    '</g>' +
    '<path d="M 15 35 L 20 40 M 85 35 L 80 40 M 15 20 L 25 25 M 85 20 L 75 25" stroke="#f1c40f" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  var BUDDY_SAD = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 60 C 15 75, 15 95, 20 100 C 28 100, 30 80, 28 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 60 C 85 75, 85 95, 80 100 C 72 100, 70 80, 72 70 Z" fill="#7B8EC8"/>' +
    '<circle cx="15" cy="45" r="14" fill="#7B8EC8"/><circle cx="85" cy="45" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<path d="M 28 48 Q 33 43, 38 52" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M 62 52 Q 67 43, 72 48" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M 33 55 Q 36 62, 33 65 Q 30 62, 33 55 Z" fill="#74b9ff"/>' +
    '<path d="M 46 62 Q 50 59, 54 62 Q 55 64, 50 66 Q 45 64, 46 62 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 66 L 50 69" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M 45 73 Q 50 69, 55 73" stroke="#3B4A7A" stroke-width="1.5" fill="none" stroke-linecap="round"/>' +
    '</svg>';

  var BUDDY_SLEEPING = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<g transform="translate(0, 15)">' +
    '<path d="M 25 100 C 15 100, 15 90, 25 85 C 40 85, 45 95, 35 100 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 100 C 85 100, 85 90, 75 85 C 60 85, 55 95, 65 100 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="75" rx="36" ry="28" fill="#fff"/>' +
    '<path d="M 12 70 C 50 95, 88 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<circle cx="20" cy="40" r="14" fill="#7B8EC8"/><circle cx="80" cy="40" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 55 C 10 25, 90 25, 90 55 C 90 80, 70 85, 50 85 C 30 85, 10 80, 10 55 Z" fill="#fff"/>' +
    '<path d="M 25 45 C 15 60, 25 70, 38 65 C 48 61, 45 40, 35 37 C 30 35, 28 35, 25 45 Z" fill="#7B8EC8" transform="rotate(-20 32 51)"/>' +
    '<path d="M 75 45 C 85 60, 75 70, 62 65 C 52 61, 55 40, 65 37 C 70 35, 72 35, 75 45 Z" fill="#7B8EC8" transform="rotate(20 68 51)"/>' +
    '<path d="M 28 55 Q 33 60, 38 55" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M 62 55 Q 67 60, 72 55" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M 46 64 Q 50 61, 54 64 Q 55 66, 50 68 Q 45 66, 46 64 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 68 L 50 71" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="56" cy="74" r="5" fill="#81ecec" opacity="0.6"/>' +
    '<circle cx="20" cy="65" r="8" fill="url(#pd-blsh)"/><circle cx="80" cy="65" r="8" fill="url(#pd-blsh)"/>' +
    '</g>' +
    '<text x="82" y="30" font-size="16" fill="#888" font-family="sans-serif" font-weight="bold">Z</text>' +
    '<text x="92" y="15" font-size="12" fill="#888" font-family="sans-serif" font-weight="bold">z</text>' +
    '</svg>\\n\\n'
"""

start_marker = r'// \u2500\u2500 Standing buddy panda SVGs'
end_marker = r'  function triggerConfetti\(\)'

pattern = re.compile(rf'({start_marker}.*?)(\n\s*{end_marker})', re.DOTALL)

match = pattern.search(text)
if match:
    new_text = text[:match.start(1)] + new_content + text[match.start(2):]
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("Successfully replaced SVGs with purple and removed duplicate remnants.")
else:
    print("Could not find the start or end marker in main.js")
