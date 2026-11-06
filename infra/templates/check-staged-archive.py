#!/usr/bin/env python3
# Treat staged input bytes strictly as data; never extract or execute build scripts on CI.
import hashlib,json,subprocess,sys,tarfile,threading
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());root=Path(sys.argv[2]);errors=[]
p=subprocess.Popen(['zstd','-dc'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
def feed():
 try:
  full=hashlib.sha256();total=0
  for c in m['archive']['chunks']:
   h=hashlib.sha256();n=0
   with (root/'blobs/sha256'/c['sha256']).open('rb') as f:
    while b:=f.read(65536):h.update(b);full.update(b);n+=len(b);p.stdin.write(b)
   if h.hexdigest()!=c['sha256'] or n!=c['sizeBytes']:raise ValueError('staged chunk mismatch')
   total+=n
  if full.hexdigest()!=m['archive']['sha256'] or total!=m['archive']['compressedBytes']:raise ValueError('compressed archive mismatch')
 except Exception as e:errors.append(e)
 finally:p.stdin.close()
class Reader:
 def __init__(self):self.h=hashlib.sha256();self.n=0
 def read(self,n):
  b=p.stdout.read(n);self.h.update(b);self.n+=len(b)
  if self.n>m['archive']['sizeBytes']:raise ValueError('archive exceeds bound')
  return b
reader=Reader();thread=threading.Thread(target=feed);thread.start()
try:
 expected={f['path']:f for f in m['files']};seen=set()
 with tarfile.open(fileobj=reader,mode='r|') as archive:
  for member in archive:
   if member.isdir():continue
   if not member.isreg() or member.name not in expected or member.name in seen:raise ValueError('unexpected staged archive member')
   f=expected[member.name];seen.add(member.name)
   if member.size!=f['sizeBytes'] or member.mode!=f['mode']:raise ValueError('staged member metadata mismatch')
   h=hashlib.sha256()
   with archive.extractfile(member) as content:
    while b:=content.read(65536):h.update(b)
   if h.hexdigest()!=f['sha256']:raise ValueError('staged member hash mismatch')
 while b:=reader.read(65536):
  if any(b):raise ValueError('nonzero trailing archive data')
 if seen!=set(expected) or reader.n!=m['archive']['sizeBytes'] or reader.h.hexdigest()!=m['archive']['rawSha256']:raise ValueError('staged raw archive mismatch')
 thread.join()
 if p.wait()!=0 or errors:raise ValueError('staged decompression/chunk verification failed')
finally:
 p.kill();p.stdout.close();thread.join(timeout=5)
