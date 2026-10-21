'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');

const runtimePath = path.resolve(__dirname, '../tv/launcher-startup.py');
const prelude = String.raw`
import importlib.util, json, os, shutil, tempfile
spec = importlib.util.spec_from_file_location('startup', ${JSON.stringify(runtimePath)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Clock:
    def __init__(self): self.value = 0.0
    def __call__(self): return self.value
    def sleep(self, seconds): self.value += seconds

class Stream:
    def __init__(self, clock, events): self.clock, self.events = clock, list(events)
    def read(self, timeout):
        end = self.clock() + timeout
        if self.events and self.events[0][0] <= end:
            at, event = self.events.pop(0)
            self.clock.value = max(self.clock(), at)
            if isinstance(event, Exception): raise event
            if callable(event): return event()
            return {'returnValue': True, 'state': event}
        self.clock.value = end
        return None

class Client:
    def __init__(self, clock):
        self.clock = clock
        self.events = [[(0, 'Active')]]
        self.calls = []
        self.closed = False
        self.subscriptions = 0
        self.foreground = 'com.webos.app.livetv'
        self.defaults = {'home': m.APP_ID, 'browser': 'current.browser'}
        self.failure = False
    def subscribe(self):
        self.subscriptions += 1
        return Stream(self.clock, self.events.pop(0) if self.events else [])
    def close_stream(self, stream): pass
    def close(self): self.closed = True
    def call(self, uri, params=None, timeout=4):
        self.calls.append((uri, params, self.clock(), timeout))
        if self.failure: raise m.TransportError('Service not ready')
        if uri == m.FOREGROUND: return {'returnValue': True, 'appId': self.foreground}
        if uri == m.LAUNCH:
            self.foreground = m.APP_ID
            return {'returnValue': True}
        if uri.endswith('getSystemSettings'):
            return {'returnValue': True, 'settings': {'defaultApps': self.defaults.copy()}}
        if uri.endswith('setSystemSettings'):
            self.defaults = params['settings']['defaultApps'].copy()
            return {'returnValue': True}
        if uri == m.POWER: return {'returnValue': True, 'state': 'Active'}
        raise AssertionError(uri)

folder = tempfile.mkdtemp(prefix='lg-gate-runtime-')
enabled = os.path.join(folder, 'enabled')
manifest = os.path.join(folder, 'appinfo.json')
backup = os.path.join(folder, 'home-original.json')
def write_json(file, value):
    with open(file, 'w', encoding='utf-8') as output: json.dump(value, output)
def install():
    open(enabled, 'w').close()
    write_json(manifest, {'id': m.APP_ID})
    write_json(backup, {'version': 1, 'appId': m.APP_ID, 'settings': {
        'defaultApps': {'home': 'com.webos.app.fullhome', 'browser': 'old.browser'},
        'homeAutoLaunch': 'on'}})
install()
clock = Clock()
client = Client(clock)
messages = []
session_path = os.path.join(folder, 'session.json')
session = m.PowerSession(session_path, boot_id='12345678-1234-5678-90ab-1234567890ab')
runtime = m.Runtime(client, enabled, manifest, backup, clock, clock.sleep, messages.append, session)
def launches(): return [call for call in client.calls if call[0] == m.LAUNCH]
`;

function python(source) {
  const result = cp.spawnSync(process.env.PYTHON || 'python', ['-B', '-c', prelude + '\ntry:\n' + source.split('\n').map(line => '    ' + line).join('\n') + '\nfinally:\n    shutil.rmtree(folder)\n'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('Автозапуск: первый Active запускает LG Gate после задержки и проверяет устойчивый foreground', () => python(`
assert runtime.run(once=True) is True
assert len(launches()) == 1
assert launches()[0][2] >= 3
assert launches()[0][1] == {'id': m.APP_ID, 'params': {'lgGateStartup': True}}
foreground_checks = [call for call in client.calls if call[0] == m.FOREGROUND]
assert len(foreground_checks) >= 3
assert foreground_checks[-1][2] - foreground_checks[-2][2] >= 0.29
assert client.closed
assert os.path.isfile(enabled)
`));

test('TV session публикуется до launch; повторный Active, reconnect и выключение экрана не меняют ID', () => python(`
original_call = client.call
published = []
def checked_call(uri, params=None, timeout=4):
    if uri == m.LAUNCH:
        marker = m.read_json(session_path, 512)
        assert marker['sleeping'] is False
        assert marker['bootId'] == session.boot_id
        published.append(marker['sessionId'])
    return original_call(uri, params, timeout)
client.call = checked_call
assert runtime.run(once=True) is True
assert len(published) == 1
before = open(session_path, 'rb').read()
for state in ['Active', 'Screen Saver', 'Active', 'Screen Off', 'Transition', 'Active']:
    assert session.observe(state) is False
assert open(session_path, 'rb').read() == before
assert not [name for name in os.listdir(folder) if '.new.' in name]
`));

test('TV session меняется после настоящего standby, переживает промежуточные состояния и сохраняется при рестарте daemon', () => python(`
assert session.observe('Active') is True
initial = m.read_json(session_path, 512)['sessionId']
restarted = m.PowerSession(session_path, boot_id=session.boot_id)
assert restarted.observe('Active') is False
assert restarted.record['sessionId'] == initial
assert restarted.observe(' Active   Standby ') is True
assert restarted.record['sessionId'] == initial and restarted.record['sleeping'] is True
assert restarted.observe('Suspend') is False
assert restarted.observe('Screen Off') is False
assert restarted.observe('Transition') is False
sleep_restart = m.PowerSession(session_path, boot_id=session.boot_id)
assert sleep_restart.observe('Active') is True
awake = sleep_restart.record['sessionId']
assert awake != initial and sleep_restart.record['sleeping'] is False
assert sleep_restart.observe('Active') is False
another_boot = m.PowerSession(session_path, boot_id='abcdef01-2345-6789-abcd-0123456789ab')
assert another_boot.observe('Active') is True
assert another_boot.record['sessionId'] != awake
assert another_boot.record['bootId'] != session.boot_id
`));

test('TV session игнорирует повреждённый или чрезмерный marker и читает boot ID с ограничением', () => python(`
boot_path = os.path.join(folder, 'boot-id')
with open(boot_path, 'w') as target: target.write(session.boot_id + '\\n')
for data in ['{broken', 'x' * 513, json.dumps({'version':1, 'bootId':session.boot_id,
            'sessionId':'../../unexpected', 'sleeping':False})]:
    with open(session_path, 'w') as target: target.write(data)
    checked = m.PowerSession(session_path, boot_path=boot_path)
    assert checked.observe('Active') is True
    marker = m.read_json(session_path, 512)
    assert len(marker['sessionId']) == 24 and marker['sleeping'] is False
    assert os.path.getsize(session_path) <= 512
with open(boot_path, 'w') as target: target.write(session.boot_id + 'x' * 100)
before = open(session_path, 'rb').read()
assert m.PowerSession(session_path, boot_path=boot_path).observe('Active') is False
assert open(session_path, 'rb').read() == before
assert not [name for name in os.listdir(folder) if '.new.' in name]
`));

test('Ошибка публикации session marker не нарушает Home/Back и проверенный автозапуск', () => python(`
runtime.session = m.PowerSession(os.path.join(folder, 'missing', 'session.json'), boot_id=session.boot_id)
assert runtime.run(once=True) is True
assert len(launches()) == 1
assert any('Power session publication:' in message for message in messages)
assert not [call for call in client.calls if call[0].endswith('setSystemSettings')]
assert os.path.isfile(enabled)
`));

test('Автозапуск не перенаправляет чужое приложение после успешного старта', () => python(`
def user_app(): client.foreground = 'youtube.leanback.v4'
def disable(): os.unlink(enabled)
client.events = [[(0, 'Active'), (10, user_app), (30, disable)]]
assert runtime.run() is True
assert len(launches()) == 1
assert client.foreground == 'youtube.leanback.v4'
assert not [call for call in client.calls if call[0] == m.FOREGROUND and call[2] >= 10]
`));

test('Пробуждение запускает LG Gate, а повторный Active после reconnect не считается пробуждением', () => python(`
def standby():
    client.foreground = 'com.webos.app.livetv'
    return {'returnValue': True, 'state': 'Suspend'}
def disable(): os.unlink(enabled)
client.events = [
    [(0, 'Active'), (6, m.TransportError('disconnected'))],
    [(7, 'Active'), (10, standby), (11, 'Active'), (18, 'Active'), (25, disable)]
]
assert runtime.run() is True
assert client.subscriptions == 2
assert len(launches()) == 2
assert launches()[0][2] >= 3 and launches()[1][2] >= 14
assert len([text for text in messages if 'verified (wake)' in text]) == 1
`));

test('Переход в standby отменяет ещё не выполненный запуск', () => python(`
client.events = [[(0, 'Active'), (1, 'Suspend'), (6, lambda: os.unlink(enabled))]]
assert runtime.run() is True
assert not launches()
assert not client.calls
`));

test('Заставка и выключение панели не возвращают Home, а настоящий сон переживает промежуточные состояния', () => python(`
def user_app(): client.foreground = 'youtube.leanback.v4'
def disable(): os.unlink(enabled)
client.events = [[
    (0, 'Active'), (6, user_app),
    (10, ' Screen   Saver '), (15, 'Active'),
    (20, 'Screen Off'), (25, 'Active'),
    (30, '  aCTive   sTAndBy  '), (31, 'Unknown'), (32, 'Active'),
    (40, disable)
]]
assert runtime.run() is True
assert len(launches()) == 2
assert launches()[0][2] >= 3 and launches()[1][2] >= 35
assert not [call for call in client.calls if call[0] == m.FOREGROUND and 6 <= call[2] < 35]
for sleep_state in ['Suspend', 'Power Off', 'Standby', 'Active Standby']:
    schedule = m.PowerSchedule()
    schedule.observe(sleep_state, 0)
    schedule.observe('Transition', 1)
    schedule.observe('Active', 2)
    assert schedule.reason == 'boot', 'first Active must always be boot'
    schedule.clear()
    schedule.observe(sleep_state, 10)
    schedule.observe('Screen Off', 11)
    schedule.observe('Active', 12)
    assert schedule.reason == 'wake' and schedule.due == 15
`));

test('Подписка без начального снимка переподключается по ограниченному тайм-ауту', () => python(`
client.events = [[], [(5, 'Active')]]
assert runtime.run(once=True) is True
assert client.subscriptions == 2
assert len(launches()) == 1 and launches()[0][2] >= 8
assert any('snapshot timed out' in message for message in messages)
`));

test('Выключенный sentinel запрещает запуск и изменения настроек', () => python(`
os.unlink(enabled)
assert runtime.run(once=True) is True
assert runtime.launch_attempt(60) == 'disabled'
assert not client.calls and client.subscriptions == 0
`));

test('Ошибки LS2 ограничены дедлайном и не отключают интеграцию Home', () => python(`
client.failure = True
assert runtime.run(once=True) is False
assert 60 <= clock() <= 66
assert os.path.isfile(enabled)
assert not [call for call in client.calls if call[0].endswith('setSystemSettings')]
assert 1 <= len(client.calls) <= 22
assert all(call[3] <= 4 for call in client.calls)
`));

test('Временное исчезновение приложения при обновлении не откатывает Home', () => python(`
os.unlink(manifest)
def reinstalled(): write_json(manifest, {'id': m.APP_ID})
client.events = [[(0, 'Active'), (20, reinstalled)]]
assert runtime.run(once=True) is True
assert len(launches()) == 1 and launches()[0][2] >= 20
assert os.path.isfile(enabled)
assert not [call for call in client.calls if call[0].endswith('setSystemSettings')]
assert runtime.missing_since is None
`));

test('Подтверждённое отсутствие приложения восстанавливает только исходный Home', () => python(`
os.unlink(manifest)
assert runtime.run(once=True) is True
assert clock() >= 60
assert not launches()
assert not os.path.exists(enabled)
assert client.defaults == {'home': 'com.webos.app.fullhome', 'browser': 'current.browser'}
writes = [call for call in client.calls if call[0].endswith('setSystemSettings')]
assert len(writes) == 1
assert list(writes[0][1]['settings']) == ['defaultApps']
assert m.read_json(backup)['settings']['defaultApps']['home'] == 'com.webos.app.fullhome'
`));

test('Отсутствующее приложение не меняет Home, переназначенный пользователем', () => python(`
os.unlink(manifest)
client.defaults['home'] = 'another.launcher'
assert runtime.run(once=True) is True
assert client.defaults['home'] == 'another.launcher'
assert not os.path.exists(enabled)
assert not [call for call in client.calls if call[0].endswith('setSystemSettings')]
`));

test('Ошибка восстановления сохраняет sentinel для повторного восстановления', () => python(`
os.unlink(manifest)
client.failure = True
assert runtime.run(once=True) is False
assert os.path.isfile(enabled)
assert not launches()
assert any('recovery failed' in message for message in messages)
`));

test('Неполный успешный ответ настроек Home не отключает последующее восстановление', () => python(`
os.unlink(manifest)
for settings in [{}, {'defaultApps': None}, {'defaultApps': []}, {'defaultApps': {}},
                 {'defaultApps': {'home': ''}}, {'defaultApps': {'home': '  '}},
                 {'defaultApps': {'home': 42}}]:
    calls = []
    def incomplete(uri, params=None, timeout=4):
        calls.append(uri)
        assert uri.endswith('getSystemSettings'), 'incomplete response caused a write'
        return {'returnValue': True, 'settings': settings}
    client.call = incomplete
    assert runtime.recover_missing_app() is False
    assert os.path.isfile(enabled)
    assert len(calls) == 1
assert any('Current Home settings are incomplete' in message for message in messages)
`));

test('Grace отсутствия манифеста начинается заново после возвращения приложения', () => python(`
os.unlink(manifest)
assert runtime.check_manifest(0) == 'waiting'
assert runtime.check_manifest(59) == 'waiting'
write_json(manifest, {'id': m.APP_ID})
assert runtime.check_manifest(59.5) == 'present'
os.unlink(manifest)
assert runtime.check_manifest(60) == 'waiting'
assert runtime.check_manifest(119) == 'waiting'
assert not client.calls
assert runtime.check_manifest(120) == 'missing'
`));

test('Диагностика --inspect читает состояние и не запускает приложение', () => python(`
info = runtime.inspect()
assert info['enabled'] is True and info['manifestPresent'] is True
assert info['foreground']['appId'] == 'com.webos.app.livetv'
assert not launches()
assert os.path.exists(enabled)
assert len(client.calls) == 3
assert all(not call[0].endswith('setSystemSettings') for call in client.calls)
`));

test('JSON transport собирает pretty JSON, разделённый UTF-8, и несколько событий', () => python(`
decoder = m.JsonFrames()
data = (' {\\n"state":"Active","title":"Зона"}\\n' + '{"state":"Suspend"}').encode('utf-8')
events = []
for byte in data: events.extend(decoder.feed(bytes([byte])))
assert len(events) == 2
assert events[0]['title'] == 'Зона' and events[1]['state'] == 'Suspend'
assert not decoder.buffer.strip()
`));

test('Пробуждение уже открытого LG Gate всё равно отправляет событие relaunch', () => python(`
client.foreground = m.APP_ID
assert runtime.run(once=True) is True
assert len(launches()) == 1
`));

const transportFixture = String.raw`
class Pipe:
    def __init__(self, number): self.number, self.closed = number, False
    def fileno(self): return self.number
    def close(self): self.closed = True
class Process:
    def __init__(self):
        self.stdin, self.stdout, self.stderr = Pipe(0), Pipe(1), Pipe(2)
        self.returncode, self.terminations = None, 0
    def poll(self): return self.returncode
    def terminate(self): self.terminations += 1; self.returncode = -15
    def kill(self): self.returncode = -9
process = Process()
captured = []
chunks = []
def popen(command, **kwargs): captured.append((command, kwargs)); return process
def ready(readers, writers, errors, timeout):
    if chunks: return [process.stdout], [], []
    clock.sleep(timeout)
    return [], [], []
m.subprocess.Popen = popen
m.select.select = ready
m.os.read = lambda fd, maximum: chunks.pop(0)
m.monotonic = clock
`;

test('Luna RPC держит stdin открытым до ответа и завершает дочерний процесс', () => python(transportFixture + `
chunks.extend([b'{\\n"returnValue":', b'true,"appId":"org.lggate.launcher"}'])
rpc = m.LunaClient()
assert rpc.call(m.FOREGROUND)['appId'] == m.APP_ID
command, options = captured[0]
assert command == ['luna-send', '-n', '1', '-f', m.FOREGROUND, '{}']
assert options['stdin'] == m.subprocess.PIPE and options['close_fds'] is True
assert process.terminations == 1
assert process.stdin.closed and process.stdout.closed and process.stderr.closed
assert not rpc.children
`));

test('Luna RPC ограничивает зависший ответ четырьмя секундами и убирает процесс', () => python(transportFixture + `
rpc = m.LunaClient()
try:
    rpc.call(m.FOREGROUND, timeout=20)
    raise AssertionError('timeout accepted')
except m.TransportError as error:
    assert 'timed out' in str(error)
assert 4 <= clock() <= 4.1
assert process.terminations == 1 and process.stdin.closed
assert not rpc.children
`));

test('Отмена Luna RPC прекращает чтение и убирает дочерний процесс', () => python(transportFixture + `
rpc = m.LunaClient(cancelled=lambda: True)
try:
    rpc.call(m.FOREGROUND)
    raise AssertionError('cancellation ignored')
except m.Cancelled: pass
assert clock() == 0
assert process.terminations == 1 and process.stdin.closed
assert not rpc.children
`));

test('JSON transport отклоняет слишком большой, не UTF-8 и не объектный ответ', () => python(`
for decoder, chunk in [(m.JsonFrames(8), b'{"123456789":'), (m.JsonFrames(), b'\\xff'), (m.JsonFrames(), b'[1]')]:
    try:
        decoder.feed(chunk)
        raise AssertionError('invalid response accepted')
    except m.TransportError: pass
`));

test('Неполный или чужой backup не используется для аварийной записи Home', () => python(`
for value in [{}, {'version': 1, 'appId': 'other'}, {'version': 1, 'appId': m.APP_ID, 'settings': {'defaultApps': {'home': m.APP_ID}}}]:
    write_json(backup, value)
    assert not runtime.recover_missing_app()
assert not client.calls
assert os.path.exists(enabled)
`));

test('Минимальный CLI отклоняет пустые, неизвестные и смешанные режимы до запуска runtime', () => python(`
def forbidden_runtime(): raise AssertionError('invalid CLI created runtime')
m.Runtime = forbidden_runtime
for args in [[], ['--help'], ['--other'], ['--run', '--once'], ['--inspect', 'extra']]:
    assert m.main(args) == 2
`));

test('Минимальный CLI --inspect не берёт lock и не запускает приложение', () => python(`
class InspectRuntime:
    def __init__(self): self.client = client
    def inspect(self): return {'enabled': True}
m.Runtime = InspectRuntime
m.InstanceLock = lambda: (_ for _ in ()).throw(AssertionError('inspect locked runtime'))
assert m.main(['--inspect']) == 0
assert client.closed and not client.calls
`));

test('Минимальный CLI выбирает once/run и освобождает lock после завершения', () => python(`
events = []
class FakeRuntime:
    stopped = False
    def __init__(self): self.client = client
    def enabled(self): return True
    def run(self, once=False): events.append(('run', once)); return True
class FakeLock:
    def acquire(self): events.append('acquire'); return True
    def close(self): events.append('release')
m.Runtime, m.InstanceLock = FakeRuntime, FakeLock
m.signal.signal = lambda *args: None
assert m.main(['--once']) == 0
assert events == ['acquire', ('run', True), 'release']
events[:] = []
assert m.main(['--run']) == 0
assert events == ['acquire', ('run', False), 'release']
`));
