'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');

const runtimePath = path.resolve(__dirname, '../tv/launcher-startup.py');
const prelude = String.raw`
import importlib.util, json, os, shutil, tempfile, errno
spec = importlib.util.spec_from_file_location('startup', ${JSON.stringify(runtimePath)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
YT = 'youtube.leanback.v4'
OTHER = 'rutube'
TV = 'com.webos.app.livetv'
HDMI = 'com.webos.app.hdmi7'
def front(app, overlay=False):
    rows = [{'appId':app,'windowType':'_WEBOS_WINDOW_TYPE_CARD'}]
    if overlay: rows.append({'appId':'com.webos.app.inputpicker','windowType':'_WEBOS_WINDOW_TYPE_POPUP'})
    return {'returnValue':True,'foregroundAppInfo':rows}
catalog = {'launchPoints':[{'id':YT},{'id':OTHER},{'id':m.APP_ID},{'id':'com.palm.app.settings'},{'id':HDMI}]}
inputs = {'devices':[{'id':'HDMI_7','appId':HDMI}]}
p = m.BackPolicy()
p.discover(catalog, inputs)
p.power('Active')
p.observe_foreground(front(YT), 0)
folder = tempfile.mkdtemp(prefix='lg-gate-back-')
enabled = os.path.join(folder,'enabled')
back_enabled = os.path.join(folder,'back-enabled')
manifest = os.path.join(folder,'appinfo.json')
open(enabled,'w').close()
open(back_enabled,'w').close()
with open(manifest,'w') as out: json.dump({'id':m.APP_ID},out)

class Clock:
    def __init__(self): self.value=0.0
    def __call__(self): return self.value
class Stream:
    def __init__(self, events): self.events=list(events); self.closed=False
    def read(self, timeout):
        if not self.events: return None
        value=self.events.pop(0)
        if isinstance(value,Exception): raise value
        return value
class Keys:
    def __init__(self): self.events=[]; self.closed=False
    def read(self, now): value=self.events; self.events=[]; return value
    def close(self): self.closed=True
class Client:
    def __init__(self):
        self.calls=[]; self.streams={}; self.front=front(YT); self.state='Active'; self.home=m.APP_ID; self.action=None
    def subscribe_uri(self, uri, params):
        stream=Stream([self.front] if uri==m.FOREGROUND else [{'returnValue':True,'subscribed':True}])
        self.streams[uri]=stream
        return stream
    def close_stream(self, stream): stream.closed=True
    def call(self, uri, params=None, timeout=4):
        self.calls.append((uri,params,timeout))
        if self.action: self.action(uri)
        if uri==m.CATALOG: return catalog
        if uri==m.INPUTS: return inputs
        if uri==m.POWER: return {'returnValue':True,'state':self.state}
        if uri==m.FOREGROUND: return self.front
        if uri==m.LAUNCH: self.front=front(m.APP_ID); return {'returnValue':True}
        if uri.endswith('getSystemSettings'): return {'returnValue':True,'settings':{'defaultApps':{'home':self.home}}}
        raise AssertionError(uri)
class Runtime:
    def __init__(self):
        self.clock=Clock(); self.client=Client(); self.stopped=False; self.manifest_path=manifest; self.messages=[]
    def enabled(self): return os.path.isfile(enabled)
    def log(self, message): self.messages.append(message)
r=Runtime()
keys=Keys()
monitor=m.BackMonitor(r,back_enabled,keys)
monitor.power('Active')
def start(): monitor.tick()
def exit_to(app=TV):
    keys.events=[(412,1),(412,0)]
    monitor.tick()
    r.clock.value+=0.1
    r.client.front=front(app)
    r.client.streams[m.FOREGROUND].events.append(r.client.front)
    monitor.tick()
    r.clock.value+=0.3
def launches(): return [call for call in r.client.calls if call[0]==m.LAUNCH]
`;
function python(source) {
  const wrapped = prelude + '\ntry:\n' + source.split('\n').map(line => '    ' + line).join('\n') + '\nfinally:\n    monitor.close()\n    shutil.rmtree(folder)\n';
  const result = cp.spawnSync(process.env.PYTHON || 'python', ['-B', '-c', wrapped], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('Back сохраняет навигацию внутри приложения и возвращает только после устойчивого выхода', () => python(`
p.key(412,1,1)
assert not p.ready(2)
assert not p.ready(30) and p.source==YT
p.observe_foreground(front(TV),31)
assert not p.ready(31.2)
assert p.ready(31.3)
`));
test('Удержание, повтор и отпускание Back не превращаются в отдельные выходы', () => python(`
p.key(412,1,1)
p.key(412,2,2)
p.key(412,0,3)
assert p.source==YT and p.expires==62
p.observe_foreground(front(TV),4)
assert p.ready(4.3)
assert not p.ready(63)
`));
test('Стрелки и OK сохраняют намерение через диалог подтверждения выхода', () => python(`
p.key(412,1,1)
for code in [28,103,105,106,108,272]: p.key(code,1,2)
p.observe_foreground(front(TV),3)
assert p.ready(3.3)
`));
test('Input, Home, канал или другая команда отменяют Back и последующее обычное закрытие', () => python(`
for code in [102,139,358,402,403,114]:
    p.observe_foreground(front(YT),10)
    p.key(412,1,11)
    p.key(code,1,12)
    p.observe_foreground(front(HDMI),12.1)
    p.life({'appId':YT,'event':'close','reason':'normal'},12.2)
    assert not p.ready(12.6),code
`));
test('Back внутри LG Gate и настроек не создаёт возврат', () => python(`
for app in [m.APP_ID,'com.palm.app.settings','unknown.application']:
    p.observe_foreground(front(app),1)
    p.key(412,1,2)
    p.observe_foreground(front(TV),3)
    assert not p.ready(3.3)
`));
test('Преднамеренный выбор входа из LG Gate остаётся на выбранном входе', () => python(`
p.observe_foreground(front(m.APP_ID),1)
p.observe_foreground(front(HDMI),2)
assert not p.ready(3)
assert HDMI in p.inputs and HDMI not in p.apps
assert 'com.webos.app.hdmi1' not in p.inputs
`));
test('Обычное закрытие приложения даёт короткое окно возврата без перехвата кнопки', () => python(`
p.life({'appId':YT,'event':'close','reason':'undefined'},1)
p.observe_foreground(front(TV),1.1)
assert p.ready(1.4)
assert not p.ready(4.1)
`));
test('Асинхронная доставка foreground перед Back или обычным close допускается в том же переходе', () => python(`
p.observe_foreground(front(TV),1)
p.key(412,1,1.1)
assert p.ready(1.4)
p.clear()
p.observe_foreground(front(YT),2)
p.observe_foreground(front(TV),3)
p.life({'appId':YT,'event':'stop','status':'normal'},3.1)
assert p.ready(3.4)
p.clear()
p.key(412,1,4)
assert not p.ready(4.3)
`));
test('Memory reclaim, системные причины и последующий normal stop не вызывают возврат', () => python(`
for reason in ['memoryReclaim','powerSuspend','recent','systemUI','userTimeout']:
    p.observe_foreground(front(YT),10)
    p.key(412,1,11)
    p.life({'appId':YT,'event':'close','reason':reason},12)
    p.life({'appId':YT,'event':'stop','reason':'normal'},12.1)
    p.observe_foreground(front(TV),12.2)
    assert not p.ready(12.6),reason
`));
test('Переход к другому приложению или splash отменяет возврат, launch Live TV его сохраняет', () => python(`
p.key(412,1,1)
p.life({'appId':TV,'event':'launch','reason':'undefined'},2)
p.observe_foreground(front(TV),2.1)
assert p.ready(2.4)
for action in ['launch','splash','foreground']:
    p.observe_foreground(front(YT),3)
    p.key(412,1,4)
    p.life({'appId':OTHER,'event':action},5)
    p.life({'appId':YT,'event':'close','reason':'normal'},5.1)
    p.observe_foreground(front(TV),5.2)
    assert not p.ready(5.6)
`));
test('Системный overlay, неоднозначный foreground и потеря подписки отменяют возврат', () => python(`
for payload in [front(YT,True), {'returnValue':True,'foregroundAppInfo':[]},
                {'foregroundAppInfo':[{'appId':YT,'windowType':'_WEBOS_WINDOW_TYPE_CARD'},{'appId':OTHER,'windowType':'_WEBOS_WINDOW_TYPE_CARD'}]}]:
    p.observe_foreground(front(YT),1)
    p.key(412,1,2)
    p.observe_foreground(payload,3)
    p.observe_foreground(front(TV),4)
    assert not p.ready(4.3)
p.observe_foreground(front(YT),5)
p.key(412,1,6)
p.disconnect()
p.observe_foreground(front(TV),7)
assert not p.ready(7.3)
`));
test('Standby и заставка отменяют старый Back; обычный Active его не создаёт', () => python(`
for state in ['Active Standby','Screen Saver','Screen Off',None]:
    p.power('Active'); p.observe_foreground(front(YT),1); p.key(412,1,2)
    p.power(state); p.power('Active'); p.observe_foreground(front(TV),3)
    assert not p.ready(3.3)
`));
test('Обновление каталога убирает удалённые приложения и обнаруживает новые входы без номера порта в коде', () => python(`
p.key(412,1,1)
p.discover({'launchPoints':[{'id':OTHER}]},{'devices':[{'appId':'vendor.input.9'}]})
assert not p.source and p.apps==set([OTHER])
assert 'vendor.input.9' in p.inputs
try: p.discover({},inputs)
except m.TransportError: pass
else: raise AssertionError('missing catalog accepted')
`));
test('evdev выбирается по имени устройства и безопасным обработчикам eventN', () => python(`
inventory='''I: Bus=0001
N: Name="LGE RCU"
H: Handlers=kbd event2

N: Name="LGE M-RCU Builtin Sensor"
H: Handlers=event8

N: Name="LGE M-RCU - Builtin [0]"
H: Handlers=event0

N: Name="LGE M-RCU - Builtin [1]"
H: Handlers=event1

N: Name="Smart Remote RCU Input"
H: Handlers=event6 ../event9 eventbad

N: Name="Unrelated Keyboard"
H: Handlers=event3
'''
assert m.RemoteKeys.paths(inventory.replace('    ',''))==set(['/dev/input/event0','/dev/input/event1','/dev/input/event2','/dev/input/event8','/dev/input/event6'])
assert m.RemoteKeys.recognized('LGE Network Input')
assert not m.RemoteKeys.recognized('Unrelated LGE RCU')
`));
test('evdev читает фрагменты без захвата устройства, отбрасывает старые события и закрывает fd', () => python(`
inventory=os.path.join(folder,'devices')
with open(inventory,'w') as out: out.write('N: Name="Smart Remote RCU Input"'+chr(10)+'H: Handlers=event6'+chr(10))
reader=m.RemoteKeys(inventory,'/fake/input',lambda:100.0)
opened=[]; closed=[]
fresh=reader.event.pack(100,0,1,412,1)
stale=reader.event.pack(90,0,1,412,1)
chunks=[fresh[:3],fresh[3:]+stale]
old_open,old_read,old_close=m.os.open,m.os.read,m.os.close
old_nonblock=getattr(m.os,'O_NONBLOCK',None)
m.os.O_NONBLOCK=2048
def opened_file(path, flags): opened.append((path,flags)); return 123
def read_file(fd,size):
    if chunks: return chunks.pop(0)
    raise OSError(errno.EAGAIN,'no more data')
try:
    m.os.open=opened_file; m.os.read=read_file; m.os.close=closed.append
    assert reader.read(0)==[(412,1),(None,1)]
    assert len(opened)==1 and opened[0][0]=='/fake/input/event6'
    assert opened[0][1]==m.os.O_RDONLY|m.os.O_NONBLOCK
    reader.close()
    assert closed==[123]
finally:
    m.os.open,m.os.read,m.os.close=old_open,old_read,old_close
    if old_nonblock is None: del m.os.O_NONBLOCK
    else: m.os.O_NONBLOCK=old_nonblock
`));
test('Наблюдатель проверяет свежие питание, foreground и Home, затем делает один возврат', () => python(`
start(); exit_to(); monitor.tick()
assert len(launches())==1
assert launches()[0][1]=={'id':m.APP_ID,'params':{'lgGateBack':True}}
assert all(call[2]<=1 for call in r.client.calls if call[0] in [m.POWER,m.FOREGROUND] or call[0].endswith('getSystemSettings'))
assert launches()[0][2]<=3
for unused in range(10): r.clock.value+=0.5; monitor.tick()
assert len(launches())==1
`));
test('Наблюдатель не опрашивает foreground на каждом Back или в покое', () => python(`
start()
keys.events=[(412,1)]; monitor.tick()
for unused in range(10): r.clock.value+=0.5; monitor.tick()
assert not [call for call in r.client.calls if call[0] in [m.FOREGROUND,m.POWER,m.LAUNCH]]
`));
test('Тайм-аут обновления каталога сохраняет подписки, evdev и Back, поступивший во время RPC', () => python(`
start()
streams=list(monitor.streams.values())
r.clock.value=30
keys.events=[(412,1)]
def slow_catalog(uri):
    if uri==m.CATALOG:
        r.clock.value+=0.5
        raise m.TransportError('Luna request timed out')
r.client.action=slow_catalog
monitor.tick()
assert monitor.policy.source==YT and monitor.discovered
assert list(monitor.streams.values())==streams and not keys.closed
assert not any(stream.closed for stream in streams)
assert r.client.calls[-1][0]==m.CATALOG and r.client.calls[-1][2]==0.5
assert any('refresh' in message and m.CATALOG in message for message in r.messages)
r.client.front=front(TV)
r.client.streams[m.FOREGROUND].events.append(r.client.front)
monitor.tick()
r.clock.value+=0.3; monitor.tick()
assert len(launches())==1
`));
test('Обновление метаданных откладывается на время уже начатого Back', () => python(`
start(); keys.events=[(412,1)]; monitor.tick()
calls=len(r.client.calls)
r.clock.value=30
def unexpected(uri):
    if uri in [m.CATALOG,m.INPUTS]: raise AssertionError('refresh during Back')
r.client.action=unexpected
monitor.tick()
assert monitor.policy.source==YT and len(r.client.calls)==calls
assert monitor.next_discovery==31
r.client.front=front(TV)
r.client.streams[m.FOREGROUND].events.append(r.client.front)
monitor.tick()
r.clock.value+=0.3; monitor.tick()
assert len(launches())==1
`));
test('Частично неудачное обновление входов сохраняет последнюю полную пару каталогов', () => python(`
start()
catalog['launchPoints']=[{'id':OTHER}]
r.clock.value=30
def unavailable(uri):
    if uri==m.INPUTS: raise m.TransportError('input service busy')
r.client.action=unavailable
monitor.tick()
assert YT in monitor.policy.apps and HDMI in monitor.policy.inputs
assert monitor.discovered and not keys.closed
assert any(m.INPUTS in message and 'refresh' in message for message in r.messages)
`));
test('Неудачное первое определение каталога закрывает наблюдатель и не разрешает выход', () => python(`
def unavailable(uri):
    if uri==m.CATALOG: raise m.TransportError('catalog unavailable')
r.client.action=unavailable
start()
assert not monitor.discovered and not monitor.streams and keys.closed
assert not monitor.policy.source and not launches()
assert r.client.calls[-1][2]==4.0
assert any('initial' in message and m.CATALOG in message for message in r.messages)
`));
test('Свежие настройки другого Home отменяют возврат без изменения настроек', () => python(`
start(); exit_to(); r.client.home='another.launcher'; monitor.tick()
assert not launches()
assert not [call for call in r.client.calls if call[0].endswith('setSystemSettings')]
`));
test('Новый foreground или overlay во время проверки отменяет возврат', () => python(`
start(); exit_to()
r.client.front=front(OTHER)
monitor.tick()
assert not launches()
monitor.policy.observe_foreground(front(YT),1)
r.clock.value=1
exit_to()
r.client.front=front(TV,True)
monitor.tick()
assert not launches()
`));
test('Input в очереди, standby или выключенный sentinel во время проверки запрещают запуск', () => python(`
start(); exit_to()
def cancel(uri):
    if uri==m.POWER: keys.events=[(358,1)]
r.client.action=cancel
monitor.tick()
assert not launches()
r.client.action=None
monitor.policy.observe_foreground(front(YT),1); r.clock.value=1; exit_to()
r.client.state='Active Standby'; monitor.tick()
assert not launches()
r.client.state='Active'; monitor.power('Active')
monitor.policy.observe_foreground(front(YT),2); r.clock.value=2; exit_to()
os.unlink(back_enabled); monitor.tick()
assert not launches() and keys.closed and not monitor.streams
assert os.path.isfile(enabled)
`));
test('Сбой подписки очищает намерение, закрывает evdev и ограничивает reconnect', () => python(`
start(); keys.events=[(412,1)]; monitor.tick()
old=list(monitor.streams.values())
r.client.streams[m.FOREGROUND].events.append(m.TransportError('stream lost'))
monitor.tick()
assert not monitor.policy.source and not monitor.streams and keys.closed
assert all(stream.closed for stream in old)
before=len(r.client.calls); monitor.tick()
assert len(r.client.calls)==before
assert monitor.next_connect>=r.clock()+1
`));
test('LS2 сбой возврата ограничен одной попыткой и очищает старый Back', () => python(`
start(); exit_to()
def fail(uri):
    if uri==m.LAUNCH: raise m.TransportError('launch rejected')
r.client.action=fail
monitor.tick()
assert len(launches())==1 and not monitor.policy.source
assert any('Back return ('+m.LAUNCH+')' in message for message in r.messages)
r.clock.value+=2; r.client.action=None; monitor.tick()
r.clock.value+=1; monitor.tick()
assert len(launches())==1
`));
test('Задержанный ответ запуска WAM не обрывает наблюдатель и не повторяет принятый запуск', () => python(`
start(); exit_to()
streams=list(monitor.streams.values())
def cold_launch(uri):
    if uri==m.LAUNCH:
        if r.client.calls[-1][2]<1.5: raise m.TransportError('Luna request timed out')
        r.clock.value+=1.5
r.client.action=cold_launch
monitor.tick()
assert len(launches())==1 and 1.5<=launches()[0][2]<=3
assert list(monitor.streams.values())==streams and not keys.closed
assert not any(stream.closed for stream in streams)
assert not any('reconnect' in message for message in r.messages)
assert any('return requested' in message for message in r.messages)
for unused in range(10): r.clock.value+=0.5; monitor.tick()
assert len(launches())==1
`));
test('Зависшие проверки не оставляют разрешение на запоздалый запуск', () => python(`
start(); exit_to()
def slow(uri):
    if uri not in [m.CATALOG,m.INPUTS]: r.clock.value+=1.3
r.client.action=slow
monitor.tick()
assert not launches() and not monitor.policy.source
assert any('deadline' in message for message in r.messages)
`));
test('Повторное открытие LG Gate самим приложением не вызывает второй запуск наблюдателя', () => python(`
start(); keys.events=[(412,1)]; monitor.tick()
r.client.front=front(m.APP_ID)
r.client.streams[m.LIFE].events.extend([{'returnValue':True,'appId':m.APP_ID,'event':'launch','reason':'hotKey'}, {'returnValue':True,'appId':YT,'event':'stop','reason':'memoryReclaim'}])
r.client.streams[m.FOREGROUND].events.append(r.client.front)
monitor.tick()
assert not launches() and not monitor.policy.source
`));
