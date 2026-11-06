import serial, sys, time
port = sys.argv[1] if len(sys.argv) > 1 else 'COM4'
dur = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
try:
    s = serial.Serial(port, 115200, timeout=1)
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
