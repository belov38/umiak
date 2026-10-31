#!/usr/bin/env bash
# Run ONLY on a disposable S10 clone via QGA; never bake this debug override into a template.
set -euo pipefail
install -d /etc/systemd/system/sbx-agent.service.d
cat >/etc/systemd/system/sbx-agent.service.d/99-desktop-spike.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/local/lib/sbx-agent/current/sbx-agent run --debug-listen unix:/run/sbx-agent/desktop-spike.sock
UNIT
systemctl daemon-reload
systemctl restart sbx-agent
python3 -I - <<'PY'
import base64, hashlib, json, subprocess, time
sock='/run/sbx-agent/desktop-spike.sock'
def rpc(service, method, body={}):
 p=subprocess.run(['curl','--silent','--show-error','--fail-with-body','--unix-socket',sock,'-H','Content-Type: application/json','-d',json.dumps(body),'http://localhost/sbx.agent.v1.'+service+'/'+method],capture_output=True,text=True)
 if p.returncode: raise RuntimeError(method+': '+p.stdout[:1000]+p.stderr[:200])
 return json.loads(p.stdout)
for _ in range(60):
 try: rpc('System','Info'); break
 except Exception: time.sleep(1)
started=time.monotonic()
rpc('System','Claim',{'sandboxId':'s10-desktop-spike','hostname':'s10-desktop','reason':'CLAIM_REASON_CLAIM','env':{'S10_DESKTOP_PROBE':'ready'}})
rpc('Desktop','Configure',{'authEpoch':'1'})
status={}
for _ in range(90):
 status=rpc('Desktop','Status')
 if status.get('state')=='ready': break
 time.sleep(1)
assert status.get('state')=='ready',status
print('desktop_ready_ms',round((time.monotonic()-started)*1000))
assert status['screen']=={'width':1920,'height':1080}, status
before=rpc('Desktop','Screenshot',{'cursor':False})
png=base64.b64decode(before['data']); assert png.startswith(b'\x89PNG\r\n\x1a\n')
subprocess.Popen(['runuser','-u','user','--','env','DISPLAY=:0','XAUTHORITY=/home/user/.Xauthority','xfce4-terminal','--disable-server'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(2)
before=rpc('Desktop','Screenshot',{'cursor':False})
rpc('Desktop','Act',{'actions':[{'type':'move','x':600,'y':400},{'type':'type','text':"printf '%s' 'S10 desktop Привет 世界' > /tmp/s10-desktop-input"},{'type':'key','keys':['enter']},{'type':'wait','ms':500}]})
after=rpc('Desktop','Screenshot',{'cursor':False})
assert before['data']!=after['data'],'input did not change screen'
assert open('/tmp/s10-desktop-input').read()=='S10 desktop Привет 世界'
print('screenshot_input_diff PASS',hashlib.sha256(png).hexdigest())
text='S10 clipboard Привет 世界 😀'
rpc('Desktop','SetClipboard',{'text':text})
assert rpc('Desktop','GetClipboard').get('text')==text
print('clipboard_roundtrip PASS')
opened=rpc('Desktop','Open')
assert opened.get('hostId') and opened.get('appId'),opened
print('sunshine_moonlight_pairing PASS')
rpc('Desktop','StopStreamer')
print('stop_streamer PASS')
PY
