"""Package selected CC0 Quaternius glTFs; drop unused clips and binary views.
Inputs are the four original downloads in /tmp; sources recorded in models/README.md.
"""
import base64, json, struct
from pathlib import Path
wanted={'survivor':{'Death','HitReact','Idle_Gun','Run_Gun','Walk_Gun'}, 'shambler':{'Death','HitReact','Idle','Run','Walk','Punch'}, 'runner':{'Death','HitReact','Idle','Run','Walk'}, 'boomer':{'Death','HitReact','Idle','Run','Walk','Punch'}}
for name, clips in wanted.items():
 j=json.loads(Path('/tmp/deadwave-'+name+'.gltf').read_text())
 j['animations']=[a for a in j['animations'] if a['name'] in clips]
 used=set()
 for mesh in j.get('meshes',[]):
  for p in mesh['primitives']:
   used.update(p['attributes'].values())
   if 'indices' in p: used.add(p['indices'])
   for t in p.get('targets',[]):used.update(t.values())
 for skin in j.get('skins',[]):
  if 'inverseBindMatrices' in skin:used.add(skin['inverseBindMatrices'])
 for a in j['animations']:
  for s in a['samplers']:used.update([s['input'],s['output']])
 amap={old:new for new,old in enumerate(sorted(used))}
 for mesh in j.get('meshes',[]):
  for p in mesh['primitives']:
   p['attributes']={k:amap[v] for k,v in p['attributes'].items()}
   if 'indices' in p:p['indices']=amap[p['indices']]
   for t in p.get('targets',[]):
    for k in t:t[k]=amap[t[k]]
 for skin in j.get('skins',[]):
  if 'inverseBindMatrices' in skin:skin['inverseBindMatrices']=amap[skin['inverseBindMatrices']]
 for a in j['animations']:
  for s in a['samplers']:
   s['input']=amap[s['input']];s['output']=amap[s['output']]
 j['accessors']=[j['accessors'][i] for i in sorted(used)]
 views={a['bufferView'] for a in j['accessors'] if 'bufferView' in a}
 views.update(i['bufferView'] for i in j.get('images',[]) if 'bufferView' in i)
 vmap={old:new for new,old in enumerate(sorted(views))}
 data=[base64.b64decode(b['uri'].split(',')[1]) for b in j['buffers']]
 binary=bytearray(); newviews=[]
 for i in sorted(views):
  v=j['bufferViews'][i].copy();start=v.get('byteOffset',0)
  chunk=data[v['buffer']][start:start+v['byteLength']]
  while len(binary)%4:binary.append(0)
  v['byteOffset']=len(binary);v['buffer']=0;binary.extend(chunk);newviews.append(v)
 for a in j['accessors']+j.get('images',[]):
  if 'bufferView' in a:a['bufferView']=vmap[a['bufferView']]
 j['bufferViews']=newviews;j['buffers']=[{'byteLength':len(binary)}]
 while len(binary)%4:binary.append(0)
 raw=json.dumps(j,separators=(',',':')).encode()
 while len(raw)%4:raw+=b' '
 out=struct.pack('<III',0x46546c67,2,28+len(raw)+len(binary))+struct.pack('<II',len(raw),0x4e4f534a)+raw+struct.pack('<II',len(binary),0x004e4942)+binary
 target=Path('public/models')/('survivor.glb' if name=='survivor' else 'zombie-'+name+'.glb')
 target.write_bytes(out);print(target,len(out))
