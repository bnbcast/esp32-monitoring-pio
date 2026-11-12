# -*- coding: utf-8 -*-
"""
Replace cursor declarations in tokens.css with kawaii mascot cursors.
"""

# Read the generated cursor CSS
import subprocess
result = subprocess.run(['python', 'dev/make-mascot-cursors.py'], capture_output=True, text=True, cwd=r'C:\Users\User\Documents\PlatformIO\Projects\esp32')
cursor_css = result.stdout

# Read tokens.css
with open(r'C:\Users\User\Documents\PlatformIO\Projects\esp32\web\css\tokens.css', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the cursor section and replace it
import re

# The cursor section starts with "/* Custom cursors" and ends before "/* Light (default) */"
# We'll replace from line 8 to line 25 (the closing brace of :root)
old_pattern = r'(/\* Custom cursors.*?\n:root \{).*?(\n\})'
# Use DOTALL to match across lines

# Let's find the exact boundaries
start_marker = '/* Custom cursors'
end_marker = '/* Light (default) */'

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx != -1 and end_idx != -1:
    # Find the closing brace of :root before end_marker
    root_end = content.rfind('\n}', start_idx, end_idx)
    if root_end != -1:
        # Include the brace and newline
        root_end += 2
        
        # Extract the new cursor declarations from the generated output
        # The output starts with ":root {" and ends with "}"
        new_root_start = cursor_css.find(':root {')
        new_root_end = cursor_css.rfind('}') + 1
        new_cursors = cursor_css[new_root_start:new_root_end]
        
        # Replace
        new_content = content[:start_idx] + new_cursors + '\n\n' + content[end_idx:]
        
        with open(r'C:\Users\User\Documents\PlatformIO\Projects\esp32\web\css\tokens.css', 'w', encoding='utf-8') as f:
            f.write(new_content)
        
        print("Successfully replaced cursor declarations!")
    else:
        print("Could not find root closing brace")
else:
    print("Could not find markers")
    print(f"start_idx: {start_idx}, end_idx: {end_idx}")