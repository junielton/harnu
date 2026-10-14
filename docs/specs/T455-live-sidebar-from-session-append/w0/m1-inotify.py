#!/usr/bin/env python3
"""T455 W0, A-M1 / B1: record every IN_OPEN and IN_MODIFY on the top-level transcripts of ONE
project dir, with wall-clock time, until SIGTERM/SIGINT or DURATION seconds. Writes JSON
[{t, kind, name}] to OUT (t = seconds since the epoch, kind 'o' or 'm'). The same clock as
`strace -tt`, so m1-units.py can match each open to the process that made it.

Usage: m1-inotify.py <project-dir> <out.json> <duration-s>
"""
import ctypes, ctypes.util, json, os, select, signal, struct, sys, time

DIR, OUT, DUR = sys.argv[1], sys.argv[2], float(sys.argv[3])
libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK)
if libc.inotify_add_watch(fd, DIR.encode(), 0x2 | 0x20) < 0:  # IN_MODIFY | IN_OPEN
    sys.exit('watch failed')
events = []
stop = False


def done(*_):
    global stop
    stop = True


signal.signal(signal.SIGTERM, done)
signal.signal(signal.SIGINT, done)
end = time.time() + DUR
while not stop and time.time() < end:
    select.select([fd], [], [], 0.25)
    try:
        buf = os.read(fd, 1 << 16)
    except BlockingIOError:
        continue
    now = time.time()
    i = 0
    while i < len(buf):
        wd, mask, _, ln = struct.unpack_from('iIII', buf, i)
        name = buf[i + 16:i + 16 + ln].rstrip(b'\0').decode(errors='replace')
        i += 16 + ln
        if not name.endswith('.jsonl'):
            continue
        if mask & 0x20:
            events.append({'t': now, 'kind': 'o', 'name': name})
        if mask & 0x2:
            events.append({'t': now, 'kind': 'm', 'name': name})
json.dump(events, open(OUT, 'w'))
print(len(events))
