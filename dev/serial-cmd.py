"""Serial console helper for the race-tracker board.

Reads the panel for a while, optionally sends one console key half-way, then
prints the ANSI-stripped log so it can be grepped. Used by the bring-up
checklist in docs/BASELINE.md.

  python dev/serial-cmd.py COM4 25            # just read 25 s
  python dev/serial-cmd.py COM4 30 x 4        # read, send 'x' at 4 s (reboot)
  python dev/serial-cmd.py COM4 20 z          # re-zero the ACS712
  python dev/serial-cmd.py COM4 60 t 5        # history self-test

Keys are the firmware ones: g raw nmea | v verbose | c colours | p panel |
r yaw=0 | z acs zero | t history self-test | x reboot | ? help
"""
import re
import sys
import time

import serial

port = sys.argv[1] if len(sys.argv) > 1 else 'COM4'
dur = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
key = sys.argv[3] if len(sys.argv) > 3 else ''
at = float(sys.argv[4]) if len(sys.argv) > 4 else 3.0

ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')

try:
    s = serial.Serial()
    s.port = port
    s.baudrate = 115200
    s.timeout = 0.5
    s.dsrdtr = False            # do not use the ESP32 auto-reset lines
    s.rtscts = False
    s.open()
    s.dtr = False               # CP210x: opening the port can pulse EN and
    s.rts = False               # reboot the board; drop both lines immediately
except Exception as e:
    print('OPEN FAIL:', e)
    sys.exit(1)

sys.stdout.reconfigure(errors='replace')
start = time.time()
sent = not key
buf = b''
while time.time() - start < dur:
    if not sent and time.time() - start >= at:
        s.write(key.encode())
        sent = True
        print('--- sent %r at %.1fs ---' % (key, time.time() - start))
    chunk = s.read(256)
    if chunk:
        buf += chunk
        text = ANSI.sub('', chunk.decode('utf-8', 'replace'))
        sys.stdout.write(text)
        sys.stdout.flush()
s.close()
print('\n=== SERIAL %s done, %d bytes ===' % (port, len(buf)))
