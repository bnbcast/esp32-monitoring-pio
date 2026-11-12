#!/usr/bin/env python3
"""
Generate a set of kawaii mascot cursors with emotional reactions.
Each cursor is a 32x32 SVG with a cute character showing different expressions.
Brutalist palette: black (#000), yellow (#ffe600), white (#fff), pink (#ff7ad9), blue (#2447ff).
"""

import urllib.parse

# Base character template - a cute round mascot
def make_mascot_svg(expression, accent_color="#ffe600", extra_elements=""):
    """Generate a kawaii mascot SVG with the given expression."""
    
    expressions = {
        "default": {
            "eyes": [
                # Left eye - gentle, slightly closed
                '<ellipse cx="11" cy="15" rx="3.5" ry="2.8" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.5" cy="15.5" rx="1.3" ry="1.1" fill="#000"/>',
                # Right eye
                '<ellipse cx="21" cy="15" rx="3.5" ry="2.8" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.5" cy="15.5" rx="1.3" ry="1.1" fill="#000"/>',
            ],
            "mouth": '<ellipse cx="16" cy="21.5" rx="2.5" ry="1" fill="none" stroke="#000" stroke-width="2"/>',
            "eyebrows": [
                '<path d="M8 11 Q11 10.5 14 11" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
                '<path d="M18 11 Q21 10.5 24 11" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
            ],
            "blush": True,
        },
        "pointer": {
            "eyes": [
                # Left eye - bright, looking up/forward
                '<ellipse cx="11" cy="14.5" rx="3.5" ry="2.5" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.5" cy="14.8" rx="1.4" ry="1.2" fill="#000"/>',
                # Right eye - slightly wider (excited)
                '<ellipse cx="21" cy="14.5" rx="3.8" ry="2.8" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.8" cy="15" rx="1.5" ry="1.3" fill="#000"/>',
            ],
            "mouth": '<path d="M13 21.5 Q16 19.5 19 21.5" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',  # smile
            "eyebrows": [
                '<path d="M7.5 10.5 Q11 9.5 14.5 10.5" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
                '<path d="M17.5 10.5 Q21 9.5 24.5 10.5" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
            ],
            "blush": True,
            "sparkle": True,
        },
        "active": {
            "eyes": [
                # Wide surprised eyes
                '<ellipse cx="11" cy="14.5" rx="4" ry="3.5" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.8" cy="14.8" rx="1.8" ry="1.6" fill="#000"/>',
                '<ellipse cx="21" cy="14.5" rx="4" ry="3.5" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.2" cy="14.8" rx="1.8" ry="1.6" fill="#000"/>',
            ],
            "mouth": '<ellipse cx="16" cy="22" rx="3" ry="2.5" fill="none" stroke="#000" stroke-width="2"/>',  # O shape
            "eyebrows": [
                '<path d="M7 10 Q11 8.5 15 10" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',
                '<path d="M17 10 Q21 8.5 25 10" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',
            ],
            "blush": True,
            "sweat": True,
        },
        "grab": {
            "eyes": [
                # Happy, ready to help
                '<ellipse cx="11" cy="15" rx="3.2" ry="3" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.5" cy="15.3" rx="1.2" ry="1" fill="#000"/>',
                '<ellipse cx="21" cy="15" rx="3.2" ry="3" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.5" cy="15.3" rx="1.2" ry="1" fill="#000"/>',
            ],
            "mouth": '<path d="M12 21 Q16 19 20 21" stroke="#000" stroke-width="2.5" fill="none" stroke-linecap="round"/>',  # big smile
            "eyebrows": [
                '<path d="M8 11.5 Q11 11 14 11.5" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
                '<path d="M18 11.5 Q21 11 24 11.5" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
            ],
            "blush": True,
            "heart": True,
        },
        "grabbing": {
            "eyes": [
                # Determined, holding tight
                '<ellipse cx="11" cy="15" rx="3" ry="2.5" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.3" cy="15.2" rx="1.1" ry="0.9" fill="#000"/>',
                '<ellipse cx="21" cy="15" rx="3" ry="2.5" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.7" cy="15.2" rx="1.1" ry="0.9" fill="#000"/>',
            ],
            "mouth": '<path d="M13 21.5 Q16 22.5 19 21.5" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',  # slight grimace
            "eyebrows": [
                '<path d="M7.5 10 Q11 9 14.5 10" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',
                '<path d="M17.5 10 Q21 9 24.5 10" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',
            ],
            "blush": False,
            "sweat": True,
        },
        "zoom-in": {
            "eyes": [
                # One eye looking through imaginary magnifier
                '<ellipse cx="11" cy="15" rx="3.5" ry="2.5" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.5" cy="15.3" rx="1.3" ry="1.1" fill="#000"/>',
                '<ellipse cx="21" cy="15" rx="3.5" ry="2.5" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.5" cy="15.3" rx="1.3" ry="1.1" fill="#000"/>',
            ],
            "mouth": '<path d="M13.5 21 Q16 19.5 18.5 21" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',  # curious smile
            "eyebrows": [
                '<path d="M8 11 Q11 10 14 11" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
                '<path d="M18 10.5 Q21 9.5 24 10.5" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',  # one raised
            ],
            "blush": True,
            "magnifier": True,
        },
        "zoom-out": {
            "eyes": [
                # Wide view, both eyes open
                '<ellipse cx="11" cy="15" rx="3.8" ry="2.8" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.5" cy="15.3" rx="1.4" ry="1.2" fill="#000"/>',
                '<ellipse cx="21" cy="15" rx="3.8" ry="2.8" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.5" cy="15.3" rx="1.4" ry="1.2" fill="#000"/>',
            ],
            "mouth": '<path d="M12 21.5 Q16 20 20 21.5" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',  # gentle smile
            "eyebrows": [
                '<path d="M7.5 11 Q11 10.5 14.5 11" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
                '<path d="M17.5 11 Q21 10.5 24.5 11" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
            ],
            "blush": True,
        },
        "crosshair": {
            "eyes": [
                # Focused, targeting
                '<ellipse cx="11" cy="14.5" rx="3" ry="2.2" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.2" cy="14.8" rx="1" ry="0.8" fill="#000"/>',
                '<ellipse cx="21" cy="14.5" rx="3" ry="2.2" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.8" cy="14.8" rx="1" ry="0.8" fill="#000"/>',
            ],
            "mouth": '<path d="M14 21.5 Q16 22 18 21.5" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',  # slight determined line
            "eyebrows": [
                '<path d="M7.5 10 Q11 9 14.5 10" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',
                '<path d="M17.5 10 Q21 9 24.5 10" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',
            ],
            "blush": False,
            "target": True,
        },
        "cell": {
            "eyes": [
                # Organizing, neat
                '<ellipse cx="11" cy="15" rx="3.5" ry="2.5" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.5" cy="15.3" rx="1.3" ry="1.1" fill="#000"/>',
                '<ellipse cx="21" cy="15" rx="3.5" ry="2.5" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.5" cy="15.3" rx="1.3" ry="1.1" fill="#000"/>',
            ],
            "mouth": '<path d="M13 21.5 Q16 20.5 19 21.5" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',
            "eyebrows": [
                '<path d="M8 11.5 Q11 11 14 11.5" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
                '<path d="M18 11.5 Q21 11 24 11.5" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
            ],
            "blush": True,
            "grid": True,
        },
        "wait": {
            "eyes": [
                # Sleepy/patient, half-closed
                '<ellipse cx="11" cy="15.5" rx="3.5" ry="1.8" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.5" cy="15.7" rx="1.2" ry="0.8" fill="#000"/>',
                '<ellipse cx="21" cy="15.5" rx="3.5" ry="1.8" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.5" cy="15.7" rx="1.2" ry="0.8" fill="#000"/>',
            ],
            "mouth": '<path d="M14 22 Q16 22.5 18 22" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',  # tiny content
            "eyebrows": [
                '<path d="M8 12.5 Q11 12 14 12.5" stroke="#000" stroke-width="1" fill="none" stroke-linecap="round"/>',
                '<path d="M18 12.5 Q21 12 24 12.5" stroke="#000" stroke-width="1" fill="none" stroke-linecap="round"/>',
            ],
            "blush": True,
            "zzz": True,
        },
        "help": {
            "eyes": [
                # Confused/asking - one raised brow, tilted
                '<ellipse cx="11" cy="14.5" rx="3.5" ry="2.8" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="10.5" cy="15" rx="1.4" ry="1.2" fill="#000"/>',
                '<ellipse cx="21" cy="15.5" rx="3.5" ry="2.8" fill="#fff" stroke="#000" stroke-width="1.5"/>',
                '<ellipse cx="21.5" cy="16" rx="1.4" ry="1.2" fill="#000"/>',
            ],
            "mouth": '<ellipse cx="16" cy="21.5" rx="2" ry="1.3" fill="none" stroke="#000" stroke-width="2"/>',  # small O
            "eyebrows": [
                '<path d="M7 10.5 Q11 9 14.5 11.5" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>',  # raised
                '<path d="M17.5 11.5 Q21 11 24.5 11.5" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>',  # normal
            ],
            "blush": True,
            "question": True,
            "sweat": True,
            "tilt": True,
        },
    }
    
    expr = expressions.get(expression, expressions["default"])
    
    # Build SVG
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
        f'  <rect x="1" y="1" width="30" height="30" fill="{accent_color}" stroke="#000" stroke-width="2"/>',
        '  <circle cx="16" cy="17" r="11" fill="#fff" stroke="#000" stroke-width="1.5"/>',
    ]
    
    # Apply tilt for help cursor
    if expr.get("tilt"):
        parts.append('  <g transform="rotate(-5, 16, 17)">')
    
    # Eyes
    for eye in expr["eyes"]:
        parts.append(f'  {eye}')
    
    # Eyebrows
    for brow in expr["eyebrows"]:
        parts.append(f'  {brow}')
    
    # Mouth
    parts.append(f'  {expr["mouth"]}')
    
    # Blush
    if expr.get("blush"):
        parts.append('  <ellipse cx="6.5" cy="19.5" rx="2.2" ry="1.2" fill="#ff7ad9" opacity="0.7"/>')
        parts.append('  <ellipse cx="25.5" cy="19.5" rx="2.2" ry="1.2" fill="#ff7ad9" opacity="0.7"/>')
    
    # Extra elements
    if expr.get("sparkle"):
        parts.append('  <g fill="#ffe600">')
        parts.append('    <circle cx="8" cy="10" r="1.5"/>')
        parts.append('    <circle cx="24" cy="11" r="1"/>')
        parts.append('    <circle cx="5" cy="16" r="0.8"/>')
        parts.append('  </g>')
    
    if expr.get("heart"):
        parts.append('  <path d="M16 10.5 C14 9 11 10 11 12.5 C11 14.5 14 16 16 18.5 C18 16 21 14.5 21 12.5 C21 10 18 9 16 10.5 Z" fill="#ff3b1f" stroke="#000" stroke-width="1"/>')
    
    if expr.get("sweat"):
        parts.append('  <path d="M23 9 Q25 10.5 23 13 Q21 10.5 23 9" fill="#87ceeb" stroke="#000" stroke-width="0.5"/>')
    
    if expr.get("magnifier"):
        parts.append('  <g transform="translate(22, 8)">')
        parts.append('    <circle cx="0" cy="0" r="5" fill="none" stroke="#000" stroke-width="2"/>')
        parts.append('    <path d="M3 3 L6 6" stroke="#000" stroke-width="2" stroke-linecap="round"/>')
        parts.append('    <circle cx="0" cy="0" r="3" fill="#fff" opacity="0.3"/>')
        parts.append('  </g>')
    
    if expr.get("target"):
        parts.append('  <g transform="translate(16, 4)" fill="none" stroke="#ff3b1f" stroke-width="2">')
        parts.append('    <circle cx="0" cy="0" r="5"/>')
        parts.append('    <circle cx="0" cy="0" r="3"/>')
        parts.append('    <line x1="0" y1="-7" x2="0" y2="-5"/>')
        parts.append('    <line x1="0" y1="5" x2="0" y2="7"/>')
        parts.append('    <line x1="-7" y1="0" x2="-5" y2="0"/>')
        parts.append('    <line x1="5" y1="0" x2="7" y2="0"/>')
        parts.append('  </g>')
    
    if expr.get("grid"):
        parts.append('  <g transform="translate(16, 4)" stroke="#2447ff" stroke-width="1.5" fill="none">')
        parts.append('    <rect x="-6" y="-6" width="12" height="12"/>')
        parts.append('    <line x1="-6" y1="-2" x2="6" y2="-2"/>')
        parts.append('    <line x1="-6" y1="2" x2="6" y2="2"/>')
        parts.append('    <line x1="-2" y1="-6" x2="-2" y2="6"/>')
        parts.append('    <line x1="2" y1="-6" x2="2" y2="6"/>')
        parts.append('  </g>')
    
    if expr.get("zzz"):
        parts.append('  <text x="26" y="8" font-size="6" fill="#000" font-family="monospace">z</text>')
        parts.append('  <text x="27.5" y="13" font-size="7" fill="#000" font-family="monospace">z</text>')
        parts.append('  <text x="25.5" y="19" font-size="8" fill="#000" font-family="monospace">z</text>')
    
    if expr.get("question"):
        parts.append('  <g transform="translate(16, 3)">')
        parts.append('    <circle cx="0" cy="-2" r="5" fill="#000"/>')
        parts.append('    <path d="M0 -5 Q3 -5 3 -3 Q3 -1 1 -1 Q0 -1 0 1" stroke="#ffe600" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        parts.append('    <circle cx="0" cy="3" r="1" fill="#ffe600"/>')
        parts.append('  </g>')
    
    if expr.get("tilt"):
        parts.append('  </g>')  # close rotate transform
    
    parts.append('</svg>')
    
    svg = "\n".join(parts)
    encoded = urllib.parse.quote(svg)
    return f'url("data:image/svg+xml,{encoded}") 16 16, {("help" if expression == "help" else "auto" if expression in ["default", "active"] else expression)}'

# Generate all cursors
cursors = ["default", "pointer", "active", "grab", "grabbing", "zoom-in", "zoom-out", "crosshair", "cell", "wait", "help"]

print(":root {")
for c in cursors:
    accent = "#ffe600"
    if c in ["pointer", "active"]:
        accent = "#ff7ad9"  # pink for excited states
    elif c in ["grab", "grabbing"]:
        accent = "#00e676"  # green for helpful states
    elif c in ["zoom-in", "zoom-out", "crosshair", "cell"]:
        accent = "#2447ff"  # blue for precision states
    elif c == "wait":
        accent = "#ff7ad9"  # pink for sleepy
    elif c == "help":
        accent = "#ffe600"  # yellow for questioning
    
    css = make_mascot_svg(c, accent)
    print(f"  --cur-{c}: {css};")
print("}")