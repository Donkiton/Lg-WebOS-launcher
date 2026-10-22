#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""LG Gate boot/wake launch and intent-scoped return after native app exits."""
from __future__ import print_function, unicode_literals

import codecs
import errno
import json
import os
import select
import signal
import struct
import subprocess
import sys
import time

APP_ID = 'org.lggate.launcher'
ROOT = '/var/lib/lg-gate'
ENABLED = ROOT + '/startup-enabled'
BACK_ENABLED = ROOT + '/back-enabled'
BACKUP = ROOT + '/home-original.json'
MANIFEST = '/media/developer/apps/usr/palm/applications/' + APP_ID + '/appinfo.json'
PID = '/tmp/lg-gate-startup.pid'
LOCK = '/tmp/lg-gate-startup.lock'
SESSION = '/tmp/lg-gate-session.json'
BOOT_ID = '/proc/sys/kernel/random/boot_id'
POWER = 'luna://com.webos.service.tvpower/power/getPowerState'
FOREGROUND = 'luna://com.webos.applicationManager/getForegroundAppInfo'
LAUNCH = 'luna://com.webos.applicationManager/launch'
LIFE = 'luna://com.webos.applicationManager/getAppLifeEvents'
INPUTS = 'luna://com.webos.service.eim/getAllInputStatus'
CATALOG = 'luna://com.webos.applicationManager/listLaunchPoints'
SETTINGS = 'luna://com.webos.settingsservice/'
MAX_RESPONSE = 1024 * 1024
MISSING_GRACE = 60.0
# Python 2 on this Linux TV has no time.monotonic. POSIX elapsed real time is
# independent of clock/calendar adjustments; never infer wake from clock gaps.
monotonic = getattr(time, 'monotonic', lambda: os.times()[4])
try:
    string_types = (basestring,)
    text_type = unicode
except NameError:
    string_types = (str,)
    text_type = str


class TransportError(Exception):
    pass


class Cancelled(TransportError):
    pass


def log(message):
    line = time.strftime('%Y-%m-%d %H:%M:%S') + ' LG Gate: ' + message + '\n'
    sys.stdout.write(line.encode('utf-8') if sys.version_info[0] < 3 else line)
    sys.stdout.flush()


class JsonFrames(object):
    """Decode luna-send -f pretty JSON objects without assuming line framing."""
    def __init__(self, limit=MAX_RESPONSE):
        self.limit = limit
        self.buffer = ''
        self.decoder = codecs.getincrementaldecoder('utf-8')('strict')
        self.json_decoder = json.JSONDecoder()

    def feed(self, chunk):
        try:
            self.buffer += self.decoder.decode(chunk)
        except UnicodeError:
            raise TransportError('Invalid UTF-8 response')
        if len(self.buffer.encode('utf-8')) > self.limit:
            raise TransportError('Response exceeds limit')
        values = []
        while self.buffer.strip():
            self.buffer = self.buffer.lstrip()
            try:
                value, end = self.json_decoder.raw_decode(self.buffer)
            except ValueError:
                break  # A later read may complete this object.
            if not isinstance(value, dict):
                raise TransportError('Expected a JSON object')
            values.append(value)
            self.buffer = self.buffer[end:]
        return values


class LunaProcess(object):
    def __init__(self, command, cancelled=None, clock=None):
        self.cancelled = cancelled or (lambda: False)
        self.clock = clock or monotonic
        self.frames = JsonFrames()
        self.queue = []
        self.error_text = b''
        self.closed = False
        self.stderr_open = True
        self.child = subprocess.Popen(command, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      close_fds=True)
        # Do not call communicate(): this firmware exits luna-send on stdin EOF.

    def read(self, timeout):
        deadline = self.clock() + max(0, timeout)
        polled = False
        while True:
            if self.cancelled():
                raise Cancelled('Stopped')
            if self.queue:
                return self.queue.pop(0)
            remaining = deadline - self.clock()
            if remaining <= 0 and polled:
                return None
            try:
                streams = [self.child.stdout]
                if self.stderr_open:
                    streams.append(self.child.stderr)
                ready, _, _ = select.select(streams, [], [], min(max(0, remaining), 0.5))
                polled = True
            except (IOError, OSError, select.error) as error:
                if getattr(error, 'errno', None) == errno.EINTR:
                    continue
                raise TransportError('Cannot read Luna response: ' + text_type(error))
            for stream in ready:
                chunk = os.read(stream.fileno(), 65536)
                if not chunk:
                    if stream is self.child.stdout:
                        raise TransportError('Luna response stream ended')
                    self.stderr_open = False
                    continue
                if stream is self.child.stderr:
                    self.error_text = (self.error_text + chunk)[:4096]
                else:
                    self.queue.extend(self.frames.feed(chunk))
                    if len(self.queue) > 32:
                        raise TransportError('Too many queued Luna responses')

    def close(self):
        if self.closed:
            return
        self.closed = True
        child = self.child
        if child.poll() is None:
            try:
                child.terminate()
            except OSError:
                pass
            deadline = monotonic() + 0.3
            while child.poll() is None and monotonic() < deadline:
                time.sleep(0.01)
            if child.poll() is None:
                try:
                    child.kill()
                except OSError:
                    pass
        # Reap with a finite deadline, including shutdown during broken services.
        deadline = monotonic() + 0.5
        while child.poll() is None and monotonic() < deadline:
            time.sleep(0.01)
        for stream in (child.stdin, child.stdout, child.stderr):
            try:
                stream.close()
            except (IOError, OSError):
                pass


class LunaClient(object):
    def __init__(self, cancelled=None):
        self.cancelled = cancelled or (lambda: False)
        self.children = set()

    def subscribe(self):
        return self.subscribe_uri(POWER, {'subscribe': True})

    def subscribe_uri(self, uri, params):
        child = LunaProcess(['luna-send', '-i', '-f', uri,
                             json.dumps(params, separators=(',', ':'))], self.cancelled)
        self.children.add(child)
        return child

    def close_stream(self, child):
        if child is not None:
            child.close()
            self.children.discard(child)

    def call(self, uri, params=None, timeout=4.0):
        child = LunaProcess(['luna-send', '-n', '1', '-f', uri,
                             json.dumps(params or {}, separators=(',', ':'))], self.cancelled)
        self.children.add(child)
        try:
            result = child.read(min(4.0, max(0.01, timeout)))
            if result is None:
                raise TransportError('Luna request timed out')
            if result.get('returnValue') is not True:
                raise TransportError('Luna rejected request: ' + text_type(result.get('errorText', 'unknown error'))[:256])
            return result
        finally:
            self.close_stream(child)

    def close(self):
        for child in list(self.children):
            self.close_stream(child)


class PowerSchedule(object):
    """Launch once at boot, then only after an observed genuine power sleep."""
    SLEEP_STATES = frozenset(('active standby', 'suspend', 'power off', 'standby'))

    def __init__(self, delay=3.0, window=60.0, retry=3.0):
        self.delay, self.window, self.retry = delay, window, retry
        self.last_state = None
        self.seen_active = False
        self.wake_pending = False
        self.due = None
        self.deadline = None
        self.reason = None

    def observe(self, state, now):
        if not isinstance(state, string_types) or not state.strip():
            return False
        state = ' '.join(state.lower().split())
        if state == 'active':
            if not self.seen_active or self.wake_pending:
                self.reason = 'wake' if self.seen_active else 'boot'
                self.due = now + self.delay
                self.deadline = self.due + self.window
            self.seen_active = True
            self.wake_pending = False
        else:
            self.clear()
            # Screen saver/panel off and other intermediate states must never
            # steal foreground from a running app when they return to Active.
            # Once sleep is observed, retain it through intermediate states.
            if state in self.SLEEP_STATES:
                self.wake_pending = True
        self.last_state = state
        return self.due is not None

    def ready(self, now):
        return self.due is not None and self.due <= now < self.deadline

    def expired(self, now):
        return self.deadline is not None and now >= self.deadline

    def failed(self, now):
        self.due = now + self.retry

    def clear(self):
        self.due = self.deadline = self.reason = None


def foreground_info(payload):
    """An extraInfo snapshot is usable only without a system overlay on top."""
    rows = payload.get('foregroundAppInfo')
    if not isinstance(rows, list) or not rows:
        return None, True
    cards = []
    for row in rows:
        if not isinstance(row, dict) or row.get('windowType') != '_WEBOS_WINDOW_TYPE_CARD':
            return None, True
        app_id = row.get('appId')
        if not isinstance(app_id, string_types) or not app_id:
            return None, True
        cards.append(app_id)
    # Multiple card owners are ambiguous: never guess behind an input picker.
    return (cards[0], False) if len(set(cards)) == 1 else (None, True)


class BackPolicy(object):
    """Pure state machine. No global Back remapping and no idle app polling."""
    KEEP_KEYS = frozenset((28, 103, 105, 106, 108, 272))  # OK and D-pad only.
    STOCK_FALLBACKS = frozenset(('com.webos.app.livetv', 'com.webos.app.fullhome',
                               'com.webos.app.launcher'))
    EXCLUDED = frozenset((APP_ID, 'com.palm.app.settings', 'com.webos.app.settings',
                          'com.webos.app.inputpicker', 'com.webos.app.inputmgr'))

    def __init__(self):
        self.apps = set()
        self.inputs = set(self.STOCK_FALLBACKS)
        self.active = False
        self.foreground = None
        self.blocked = True
        self.source = None
        self.expires = 0
        self.fallback_since = None
        self.previous_user = None
        self.transition_at = 0
        self.no_close_until = 0

    def clear(self):
        self.source = None
        self.expires = 0
        self.fallback_since = None
        self.previous_user = None

    def disconnect(self):
        self.clear()
        self.foreground = None
        self.blocked = True

    def discover(self, catalog, inputs):
        points, devices = catalog.get('launchPoints'), inputs.get('devices')
        if not isinstance(points, list) or not isinstance(devices, list):
            raise TransportError('Incomplete Back discovery')
        self.inputs = set(self.STOCK_FALLBACKS)
        for device in devices:
            app_id = device.get('appId') if isinstance(device, dict) else None
            if isinstance(app_id, string_types) and app_id:
                self.inputs.add(app_id)
        self.apps = set()
        for point in points:
            app_id = (point.get('appId') or point.get('id')) if isinstance(point, dict) else None
            if isinstance(app_id, string_types) and app_id and app_id not in self.EXCLUDED and app_id not in self.inputs:
                self.apps.add(app_id)
        if self.source not in self.apps:
            self.clear()

    def power(self, state):
        self.active = isinstance(state, string_types) and state.strip().lower() == 'active'
        if not self.active:
            self.clear()

    def observe_foreground(self, payload, now):
        app_id, blocked = foreground_info(payload)
        prior = self.foreground
        self.foreground, self.blocked = app_id, blocked
        if blocked:
            self.clear()
            return
        if app_id in self.apps:
            if app_id != prior:
                self.clear()
            return
        if app_id in self.inputs:
            if prior in self.apps:
                self.previous_user, self.transition_at = prior, now
            if self.source and (prior == self.source or prior in self.inputs):
                if self.fallback_since is None:
                    self.fallback_since = now
            return
        self.clear()

    def key(self, code, value, now):
        if value not in (1, 2):
            return
        if not self.active or self.blocked:
            self.clear()
            return
        if code == 412:
            source = self.foreground if self.foreground in self.apps else None
            # LS2 foreground and evdev have independent queues. A Back read in
            # the same transition batch may follow the resulting input event.
            if (source is None and self.foreground in self.inputs and
                    self.previous_user in self.apps and now - self.transition_at <= 0.35):
                source = self.previous_user
            if source:
                self.source, self.expires = source, now + 60.0
                self.no_close_until = 0
                if self.foreground in self.inputs:
                    self.fallback_since = now
        elif code not in self.KEEP_KEYS:
            self.clear()
            # An explicit Input/Home/channel key can itself close the old app.
            # That close must not recreate the intent just cancelled here.
            self.no_close_until = now + 3.0

    def life(self, event, now):
        app_id, action = event.get('appId'), event.get('event')
        if action in ('launch', 'splash', 'foreground'):
            if app_id != self.source and app_id not in self.inputs:
                self.clear()
                self.no_close_until = now + 3.0
            return
        recent_source = (self.foreground in self.inputs and app_id == self.previous_user and
                         now - self.transition_at <= 0.35)
        if action not in ('close', 'stop') or app_id not in self.apps or (app_id != self.foreground and not recent_source):
            return
        reason = event.get('reason', event.get('status', 'undefined'))
        if reason not in (None, '', 'undefined', 'normal'):
            self.clear()
            self.no_close_until = now + 3.0
            return
        if self.active and not self.blocked and now >= self.no_close_until:
            self.source, self.expires = app_id, now + 3.0
            if recent_source and self.fallback_since is None:
                self.fallback_since = now

    def ready(self, now):
        if self.source and now >= self.expires:
            self.clear()
        return bool(self.active and not self.blocked and self.source and
                    self.foreground in self.inputs and self.fallback_since is not None and
                    now - self.fallback_since >= 0.25 and now < self.expires)


class RemoteKeys(object):
    """Passive evdev reader, selected by device identity rather than event index."""
    NAMES = frozenset(('LGE RCU', 'LGE Simple Premium', 'Smart Remote RCU Input',
                       'LGE Network Input'))

    def __init__(self, devices='/proc/bus/input/devices', root='/dev/input', wall_clock=None):
        self.devices, self.root = devices, root
        self.wall_clock = wall_clock or time.time
        self.files = {}
        self.next_discovery = 0
        # Native timeval layout is 16 bytes on this ARMv7 TV (24 on x86_64).
        self.event = struct.Struct('llHHi')

    @classmethod
    def recognized(cls, name):
        magic = 'LGE M-RCU - Builtin ['
        return (name in cls.NAMES or name.startswith('LGE M-RCU Builtin') or
                (name.startswith(magic) and name.endswith(']') and name[len(magic):-1].isdigit()))

    @classmethod
    def paths(cls, text, root='/dev/input'):
        paths = set()
        for block in text.split('\n\n'):
            name, handlers = '', []
            for line in block.splitlines():
                line = line.strip()
                if line.startswith('N: Name="') and line.endswith('"'):
                    name = line[9:-1]
                if line.startswith('H: Handlers='):
                    handlers = line[12:].split()
            if cls.recognized(name):
                for handler in handlers:
                    if handler.startswith('event') and handler[5:].isdigit():
                        paths.add(root + '/' + handler)
        return paths

    def close(self):
        for descriptor, buffer in list(self.files.values()):
            try:
                os.close(descriptor)
            except OSError:
                pass
        self.files = {}

    def read(self, now):
        if now >= self.next_discovery:
            self.next_discovery = now + 5.0
            try:
                with open(self.devices, 'r') as source:
                    paths = self.paths(source.read(65536), self.root)
            except (IOError, OSError):
                paths = set()
            for path in list(self.files):
                if path not in paths:
                    os.close(self.files.pop(path)[0])
            for path in paths:
                if path not in self.files:
                    try:
                        self.files[path] = [os.open(path, os.O_RDONLY | os.O_NONBLOCK), b'']
                    except (IOError, OSError):
                        pass
        events = []
        for path, state in list(self.files.items()):
            descriptor, buffer = state
            try:
                for unused in range(4):  # Bound bursts; never starve power/LS2.
                    try:
                        chunk = os.read(descriptor, self.event.size * 64)
                    except OSError as error:
                        if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                            break
                        raise
                    if not chunk:
                        raise OSError(errno.ENODEV, 'Remote disconnected')
                    buffer += chunk
                    while len(buffer) >= self.event.size:
                        seconds, micros, kind, code, value = self.event.unpack(buffer[:self.event.size])
                        buffer = buffer[self.event.size:]
                        if kind == 1:
                            age = self.wall_clock() - (seconds + micros / 1000000.0)
                            # Default evdev clock on this firmware is realtime.
                            # Delayed batches after a blocked service cannot
                            # manufacture a new Back intention in a later app.
                            events.append((code, value) if -1.0 <= age <= 2.0 else (None, 1))
                    state[1] = buffer
            except (IOError, OSError):
                os.close(descriptor)
                self.files.pop(path, None)
        return events


class BackMonitor(object):
    def __init__(self, runtime, enabled_path=BACK_ENABLED, keys=None):
        self.runtime, self.client = runtime, runtime.client
        self.enabled_path = enabled_path
        self.keys = keys or RemoteKeys()
        self.policy = BackPolicy()
        self.streams = {}
        self.next_connect = 0
        self.next_discovery = 0
        self.backoff = 1.0
        self.was_enabled = False
        self.discovered = False

    def close(self):
        for stream in list(self.streams.values()):
            self.client.close_stream(stream)
        self.streams = {}
        self.keys.close()
        self.policy.disconnect()
        self.discovered = False

    def power(self, state):
        self.policy.power(state)

    def lost_power(self):
        self.policy.power(None)

    def drain(self):
        now = self.runtime.clock()
        for code, value in self.keys.read(now):
            self.policy.key(code, value, now)
        for name, stream in list(self.streams.items()):
            for unused in range(16):
                event = stream.read(0)
                if event is None:
                    break
                if event.get('returnValue') is not True:
                    raise TransportError('Back subscription rejected')
                if name == 'foreground':
                    self.policy.observe_foreground(event, self.runtime.clock())
                elif name == 'life':
                    self.policy.life(event, self.runtime.clock())

    def refresh_discovery(self):
        initial = not self.discovered
        # Keep servicing the exit first. Catalogue freshness is unrelated to
        # the already validated app/input identity of that exit.
        if not initial and self.policy.source:
            self.next_discovery = self.runtime.clock() + 1.0
            return
        uri = CATALOG
        try:
            timeout = 4.0 if initial else 0.5
            catalog = self.client.call(uri, timeout=timeout)
            uri = INPUTS
            inputs = self.client.call(uri, timeout=timeout)
            self.policy.discover(catalog, inputs)
            self.discovered = True
            self.next_discovery = self.runtime.clock() + 30.0
        except Cancelled:
            raise
        except (TransportError, IOError, OSError, ValueError) as error:
            message = 'Back discovery ' + ('initial' if initial else 'refresh') + ' (' + uri + '): ' + text_type(error)
            if initial:
                raise TransportError(message)
            # An occasional slow metadata service must not drop live evdev or
            # foreground subscriptions. Keep the last complete validated pair.
            self.next_discovery = self.runtime.clock() + 30.0
            self.runtime.log(message + '; retaining validated catalogue')

    def tick(self):
        now = self.runtime.clock()
        enabled = os.path.isfile(self.enabled_path)
        if not enabled:
            if self.was_enabled:
                self.close()
            self.was_enabled = False
            return
        self.was_enabled = True
        try:
            if not self.streams and now >= self.next_connect:
                # Register before the snapshot/discovery so transitions are not
                # missed while the synchronous read-only requests complete.
                self.streams['foreground'] = self.client.subscribe_uri(FOREGROUND, {'subscribe': True, 'extraInfo': True})
                self.streams['life'] = self.client.subscribe_uri(LIFE, {'subscribe': True})
                self.next_discovery = 0
            if not self.streams:
                return
            if now >= self.next_discovery:
                self.refresh_discovery()
            self.drain()
            self.backoff = 1.0
            if self.policy.ready(self.runtime.clock()):
                self.return_attempt()
        except Cancelled:
            self.close()
        except (TransportError, IOError, OSError, ValueError) as error:
            self.runtime.log('Back observer reconnect: ' + text_type(error))
            self.close()
            self.next_connect = self.runtime.clock() + self.backoff
            self.backoff = min(30.0, self.backoff * 2)

    def return_attempt(self):
        deadline = self.runtime.clock() + 5.0
        expected = self.policy.foreground

        def call(uri, params=None):
            remaining = deadline - self.runtime.clock()
            if remaining <= 0:
                raise TransportError('Back return deadline before ' + uri)
            try:
                # Cold WAM startup can acknowledge an accepted launch after
                # more than a second. Keep reads short but let that one launch
                # finish within the finite overall return deadline.
                limit = 3.0 if uri == LAUNCH else 1.0
                return self.client.call(uri, params, timeout=min(limit, remaining))
            except Cancelled:
                raise
            except (TransportError, IOError, OSError) as error:
                raise TransportError('Back return (' + uri + '): ' + text_type(error))

        # A delayed confirmation is never authority to steal a newly opened
        # app, input picker, Settings, standby, or another Home assignment.
        power = call(POWER)
        front = call(FOREGROUND, {'extraInfo': True})
        home = call(SETTINGS + 'getSystemSettings', {'category': 'general', 'keys': ['defaultApps']})
        self.policy.power(power.get('state'))
        self.policy.observe_foreground(front, self.runtime.clock())
        self.drain()
        self.policy.power(call(POWER).get('state'))
        self.drain()  # Include Input/Home events arriving during that last RPC.
        valid = (self.policy.foreground == expected and self.policy.ready(self.runtime.clock()) and
                 home.get('settings', {}).get('defaultApps', {}).get('home') == APP_ID and
                 os.path.isfile(self.enabled_path) and self.runtime.enabled() and
                 manifest_present(self.runtime.manifest_path) and not self.runtime.stopped)
        self.policy.clear()  # One attempt per exit; no foreground launch loops.
        if valid:
            call(LAUNCH, {'id': APP_ID, 'params': {'lgGateBack': True}})
            self.runtime.log('Launcher return requested after native app exit')


def read_json(path, limit=65536):
    with open(path, 'rb') as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError('File exceeds limit')
    return json.loads(data.decode('utf-8'))


def manifest_present(path):
    try:
        return read_json(path).get('id') == APP_ID
    except (IOError, OSError, ValueError, AttributeError):
        return False


def valid_backup(backup):
    if not isinstance(backup, dict) or backup.get('version') != 1 or backup.get('appId') != APP_ID:
        return False
    settings = backup.get('settings')
    defaults = settings.get('defaultApps') if isinstance(settings, dict) else None
    home = defaults.get('home') if isinstance(defaults, dict) else None
    return isinstance(home, string_types) and bool(home.strip()) and home != APP_ID


class PowerSession(object):
    """Publish catalogue freshness, separate from launch policy.

    Quick Start keeps the kernel boot ID across standby; WAM may restart the
    launcher while the TV is still awake. Only a genuine sleep/Active cycle
    rotates the token. A daemon restart reuses its published awake session.
    """
    def __init__(self, path=SESSION, boot_path=BOOT_ID, boot_id=None, make_id=None):
        self.path = path
        self.boot_path = boot_path
        self.boot_id = boot_id
        self.make_id = make_id or (lambda: ''.join('%02x' % byte for byte in bytearray(os.urandom(12))))
        self.loaded = False
        self.record = None

    @staticmethod
    def valid_boot(value):
        if not isinstance(value, string_types):
            return False
        parts = value.lower().split('-')
        return (list(map(len, parts)) == [8, 4, 4, 4, 12] and
                all(char in '0123456789abcdef-' for char in value.lower()))

    @staticmethod
    def valid_id(value):
        return (isinstance(value, string_types) and len(value) == 24 and
                all(char in '0123456789abcdef' for char in value))

    def load(self):
        if self.loaded:
            return bool(self.boot_id)
        if self.boot_id is None:
            try:
                with open(self.boot_path, 'rb') as source:
                    self.boot_id = source.read(81).decode('ascii').strip()
            except (IOError, OSError, UnicodeError):
                return False  # A later power event can retry a transient read.
        if not self.valid_boot(self.boot_id):
            return False
        try:
            saved = read_json(self.path, 512)
            if (isinstance(saved, dict) and saved.get('version') == 1 and
                    saved.get('bootId') == self.boot_id and
                    self.valid_id(saved.get('sessionId')) and
                    isinstance(saved.get('sleeping'), bool)):
                self.record = {'version': 1, 'bootId': saved['bootId'],
                               'sessionId': saved['sessionId'], 'sleeping': saved['sleeping']}
        except (IOError, OSError, ValueError, UnicodeError):
            pass
        self.loaded = True
        return True

    def write(self, record):
        session_id = record['sessionId']
        data = (json.dumps(record, separators=(',', ':')) + '\n').encode('ascii')
        if len(data) > 512:
            raise ValueError('Power session marker exceeds limit')
        temporary = self.path + '.new.' + str(os.getpid()) + '.' + session_id
        descriptor = None
        created = False
        try:
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY |
                                 getattr(os, 'O_NOFOLLOW', 0), 0o644)
            created = True
            offset = 0
            while offset < len(data):
                offset += os.write(descriptor, data[offset:])
            os.close(descriptor)
            descriptor = None
            getattr(os, 'replace', os.rename)(temporary, self.path)
            self.record = record
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if created:
                try:
                    os.unlink(temporary)
                except OSError as error:
                    if error.errno != errno.ENOENT:
                        raise

    def publish(self, sleeping):
        session_id = self.record['sessionId'] if sleeping and self.record else self.make_id()
        if not self.valid_id(session_id):
            raise ValueError('Invalid power session ID')
        record = {'version': 1, 'bootId': self.boot_id,
                  'sessionId': session_id, 'sleeping': sleeping}
        self.write(record)

    def observe(self, state):
        if not isinstance(state, string_types) or not self.load():
            return False
        state = ' '.join(state.lower().split())
        if state == 'active':
            if self.record and not self.record['sleeping']:
                return False
            self.publish(False)
            return True
        if state in PowerSchedule.SLEEP_STATES:
            if self.record and self.record['sleeping']:
                return False
            self.publish(True)
            return True
        return False


class Runtime(object):
    def __init__(self, client=None, enabled=ENABLED, manifest=MANIFEST, backup=BACKUP,
                 clock=None, sleeper=None, logger=None, session=None):
        self.stopped = False
        self.client = client or LunaClient(lambda: self.stopped)
        self.enabled_path, self.manifest_path, self.backup_path = enabled, manifest, backup
        self.clock = clock or monotonic
        self.sleep = sleeper or time.sleep
        self.log = logger or log
        self.schedule = PowerSchedule()
        self.session = session if session is not None else PowerSession()
        self.missing_since = None
        self.next_manifest_check = 0

    def enabled(self):
        return os.path.isfile(self.enabled_path)

    def check_manifest(self, now):
        if manifest_present(self.manifest_path):
            self.missing_since = None
            return 'present'
        if self.missing_since is None:
            self.missing_since = now
            self.log('Application manifest missing; waiting through update grace')
        if now - self.missing_since < MISSING_GRACE:
            return 'waiting'
        return 'missing' if self.recover_missing_app() else 'retry'

    def recover_missing_app(self):
        """Restore only our Home assignment, never another launcher's settings."""
        try:
            backup = read_json(self.backup_path)
            if not valid_backup(backup):
                raise ValueError('Invalid original Home backup')
            response = self.client.call(SETTINGS + 'getSystemSettings',
                                        {'category': 'general', 'keys': ['defaultApps']})
            current = response.get('settings', {}).get('defaultApps')
            if (not isinstance(current, dict) or
                    not isinstance(current.get('home'), string_types) or
                    not current['home'].strip()):
                raise TransportError('Current Home settings are incomplete')
            if current['home'] == APP_ID:
                defaults = dict(current)
                defaults['home'] = backup['settings']['defaultApps']['home']
                self.client.call(SETTINGS + 'setSystemSettings',
                                 {'category': 'general', 'settings': {'defaultApps': defaults}})
                verified = self.client.call(SETTINGS + 'getSystemSettings',
                                            {'category': 'general', 'keys': ['defaultApps']})
                if verified.get('settings', {}).get('defaultApps', {}).get('home') != defaults['home']:
                    raise TransportError('Original Home verification failed')
                self.log('Missing application: original Home restored')
            else:
                self.log('Missing application: another Home assignment preserved')
        except (IOError, OSError, ValueError, TransportError, AttributeError) as error:
            self.log('Missing application recovery failed: ' + text_type(error))
            return False  # Keep enabled so the next boot can retry recovery.
        try:
            os.unlink(self.enabled_path)
        except OSError as error:
            if error.errno != errno.ENOENT:
                self.log('Could not disable startup: ' + text_type(error))
                return False
        return True

    def launch_attempt(self, deadline):
        if self.stopped or not self.enabled():
            return 'disabled'
        if not manifest_present(self.manifest_path):
            return 'missing' if self.check_manifest(self.clock()) == 'missing' else 'retry'
        self.missing_since = None

        def call(uri, params=None):
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise TransportError('Launch deadline reached')
            return self.client.call(uri, params, timeout=min(4.0, remaining))

        try:
            call(FOREGROUND)  # Read-only readiness check, never app-exit polling.
            # Recheck the enable flag immediately before the mutating RPC.
            if self.stopped or not self.enabled():
                return 'disabled'
            if not manifest_present(self.manifest_path):
                return 'retry'
            # Relaunch even an existing LG Gate instance: it may host a portal
            # left open before standby, and must return to its own home screen.
            call(LAUNCH, {'id': APP_ID, 'params': {'lgGateStartup': True}})
            stable = 0
            verify_deadline = min(deadline, self.clock() + 3.0)
            while not self.stopped and self.clock() < verify_deadline:
                if not self.enabled():
                    return 'disabled'
                if call(FOREGROUND).get('appId') == APP_ID:
                    stable += 1
                    if stable >= 2:
                        return 'launched'
                else:
                    stable = 0
                self.sleep(min(0.3, max(0, verify_deadline - self.clock())))
            return 'retry'
        except Cancelled:
            return 'disabled'
        except (TransportError, OSError) as error:
            self.log('Startup attempt: ' + text_type(error))
            return 'retry'

    def run(self, once=False):
        stream = None
        # Legacy test clients and the explicit one-shot startup command remain
        # boot/wake only. The passive observer belongs to the long-lived daemon.
        back = BackMonitor(self) if not once and hasattr(self.client, 'subscribe_uri') else None
        stream_has_snapshot = False
        stream_connected_at = 0
        next_connect, backoff = self.clock(), 1.0
        once_deadline = self.clock() + 65.0
        try:
            while not self.stopped and self.enabled():
                now = self.clock()
                if back is not None:
                    back.tick()
                if once and now >= once_deadline:
                    self.log('One-shot startup deadline reached')
                    return False
                if now >= self.next_manifest_check:
                    manifest_state = self.check_manifest(now)
                    self.next_manifest_check = now + (30.0 if manifest_state == 'retry' else 5.0)
                    if manifest_state == 'missing':
                        return True
                if stream is None and now >= next_connect:
                    try:
                        stream = self.client.subscribe()
                        stream_has_snapshot = False
                        stream_connected_at = self.clock()
                    except (TransportError, OSError) as error:
                        self.log('Power subscription: ' + text_type(error))
                        next_connect = now + backoff
                        backoff = min(30.0, backoff * 2)
                if stream is not None:
                    try:
                        event = stream.read(0.1 if back is not None and back.was_enabled else 0.5)
                        if event is not None:
                            if event.get('returnValue') is not True or not isinstance(event.get('state'), string_types) or not event['state'].strip():
                                raise TransportError('Power service returned no valid state')
                            try:
                                self.session.observe(event['state'])
                            except (IOError, OSError, ValueError) as error:
                                # An optional cache token must never disable
                                # existing Home/Back or boot/wake launching.
                                self.log('Power session publication: ' + text_type(error))
                            self.schedule.observe(event['state'], self.clock())
                            if back is not None:
                                back.power(event['state'])
                            stream_has_snapshot = True
                            backoff = 1.0
                        elif not stream_has_snapshot and self.clock() - stream_connected_at >= 4.0:
                            raise TransportError('Power subscription snapshot timed out')
                    except Cancelled:
                        break
                    except (TransportError, OSError) as error:
                        self.log('Power subscription reconnect: ' + text_type(error))
                        self.client.close_stream(stream)
                        if back is not None:
                            back.lost_power()
                        stream = None
                        next_connect = self.clock() + backoff
                        backoff = min(30.0, backoff * 2)
                        # Retain last_state: a reconnect snapshot is not a wake.
                else:
                    self.sleep(min(0.5, max(0.01, next_connect - self.clock())))
                now = self.clock()
                if self.schedule.expired(now):
                    self.log('Startup launch deadline reached')
                    self.schedule.clear()
                    if once:
                        return False
                if self.schedule.ready(now):
                    reason = self.schedule.reason
                    result = self.launch_attempt(self.schedule.deadline)
                    if result in ('disabled', 'missing'):
                        return result == 'missing'
                    if result == 'launched':
                        self.log('Launcher foreground verified (' + reason + ')')
                        self.schedule.clear()
                        if once:
                            return True
                    else:
                        self.schedule.failed(self.clock())
            return True
        finally:
            if back is not None:
                back.close()
            self.client.close()

    def inspect(self):
        result = {'appId': APP_ID, 'enabled': self.enabled(),
                  'manifestPresent': manifest_present(self.manifest_path),
                  'backSupported': True, 'backEnabled': os.path.isfile(BACK_ENABLED)}
        for key, uri, params in [('power', POWER, {}), ('foreground', FOREGROUND, {}),
                                 ('home', SETTINGS + 'getSystemSettings',
                                  {'category': 'general', 'keys': ['defaultApps']})]:
            try:
                result[key] = self.client.call(uri, params)
            except (TransportError, OSError) as error:
                result[key] = {'error': text_type(error)}
        return result


class InstanceLock(object):
    def __init__(self, lock_path=LOCK, pid_path=PID):
        self.lock_path, self.pid_path = lock_path, pid_path
        self.descriptor = None
        self.pid = str(os.getpid())

    def acquire(self):
        import fcntl  # Linux device only; pure tests remain portable.
        flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
        descriptor = os.open(self.lock_path, flags, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (IOError, OSError):
            os.close(descriptor)
            return False
        self.descriptor = descriptor
        flags = os.O_CREAT | os.O_TRUNC | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0)
        pid_file = os.open(self.pid_path, flags, 0o600)
        try:
            os.write(pid_file, self.pid.encode('ascii'))
        finally:
            os.close(pid_file)
        return True

    def close(self):
        if self.descriptor is None:
            return
        try:
            with open(self.pid_path, 'rb') as source:
                owned = source.read(64).decode('ascii') == self.pid
            if owned:
                os.unlink(self.pid_path)
        except (IOError, OSError, UnicodeError):
            pass
        os.close(self.descriptor)
        self.descriptor = None
        # Do not unlink the flock inode: that would permit parallel owners.


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1 or argv[0] not in ('--run', '--once', '--inspect'):
        sys.stderr.write('Usage: launcher-startup.py --run | --once | --inspect\n')
        return 2
    mode = argv[0]
    runtime = Runtime()
    if mode == '--inspect':
        try:
            print(json.dumps(runtime.inspect(), sort_keys=True))
            return 0
        finally:
            runtime.client.close()
    if not runtime.enabled():
        log('Startup disabled')
        return 0
    lock = InstanceLock()
    if not lock.acquire():
        log('Startup runtime already running')
        return 0

    def stop(signum, frame):
        runtime.stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        return 0 if runtime.run(once=mode == '--once') else 1
    finally:
        runtime.client.close()
        lock.close()


if __name__ == '__main__':
    sys.exit(main())
