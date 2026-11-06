import serial, sys, time
port = sys.argv[1] if len(sys.argv) > 1 else 'COM4'
dur = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
try:
    s = serial.Serial()
    s.port = port
    s.baudrate = 115200
    s.timeout = 1
    s.dsrdtr = False            # do not use the ESP32 auto-reset lines
    s.rtscts = False
    s.open()
    s.dtr = False               # CP210x: opening the port can pulse EN and
    s.rts = False               # reboot the board; drop both lines immediately
except Exception as e:
    print('OPEN FAIL:', e); sys.exit(1)
end = time.time() + dur
buf = b''
while time.time() < end:
    chunk = s.read(256)
    if chunk:
        buf += chunk
s.close()
txt = buf.decode('utf-8', 'replace')
print('=== SERIAL %s (%d bytes) ===' % (port, len(buf)))
sys.stdout.reconfigure(errors='replace')
print(txt[-4000:].encode('ascii','replace').decode('ascii'))
