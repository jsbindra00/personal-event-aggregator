#!/usr/bin/env python3
"""Hosted-only D0 controller. Importing this module is pure; main requires CI push identity."""
import hashlib,json,os,pathlib,selectors,shutil,socket,subprocess,sys,tempfile,threading,time,uuid
BASE='docker.io/library/node@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600'
BRANCH='refs/heads/codex/cloudflare-personal-event-probe'
PREFIX='probe/personal-event/'
ENV={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp','LANG':'C.UTF-8'}
FILES=('acquisition.json','launch.json','runtime-inspection.json','image.json','canary.json','result.json','controller.json','stdout.log','stderr.log')

def digest(b): return hashlib.sha256(b).hexdigest()
def write_json(path,value): path.write_text(json.dumps(value,separators=(',',':'))+'\n')

def stage(source,context):
    seal=json.loads((source/PREFIX/'source-manifest.json').read_text())
    allowed=set(seal['sha256'])|{PREFIX+'source-manifest.json'}
    paths=list((source/PREFIX).rglob('*'))
    if any(p.is_symlink() for p in paths):raise ValueError('symlinked input')
    actual={str(p.relative_to(source)) for p in paths if not p.is_dir()}
    actual.add('.github/workflows/personal-event-worker-probe.yml')
    if actual!=allowed: raise ValueError('payload allowlist mismatch')
    for relative in sorted(allowed):
        p=source/relative
        if p.is_symlink() or not p.is_file() or source.resolve() not in p.resolve().parents: raise ValueError('unsafe input')
        if relative in seal['sha256'] and digest(p.read_bytes())!=seal['sha256'][relative]: raise ValueError('payload hash mismatch: '+relative)
        if relative.startswith(PREFIX):
            target=context/relative[len(PREFIX):];target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,target)
    return {'sourceCommit':os.environ.get('GITHUB_SHA'),'manifestSha256':digest((source/PREFIX/'source-manifest.json').read_bytes()),'files':sorted(allowed)}

def bundle_snapshot(directory):
    """Read bounded regular bytes once. No output or manifest is written here."""
    blobs={};total=0
    for p in sorted(directory.iterdir()):
        if p.name not in FILES or p.is_symlink() or not p.is_file():raise ValueError('unallowlisted collected output')
        cap=65536 if p.suffix=='.json' else 262144
        if p.stat().st_size>cap:raise ValueError('per-file collection cap')
        b=p.read_bytes()
        if len(b)>cap:raise ValueError('per-file collection cap')
        if p.suffix=='.json' and not isinstance(json.loads(b),dict):raise ValueError('JSON evidence must be an object')
        blobs[p.name]=b;total+=len(b)
    if total>500000:raise ValueError('artifact cap')
    if not {'controller.json','stdout.log','stderr.log'}.issubset(blobs):raise ValueError('incomplete collection')
    controller=json.loads(blobs['controller.json']);status=controller.get('status')
    if status not in ('PASS','FAIL') or controller.get('complete') is not True:raise ValueError('controller terminal incomplete')
    if status=='PASS':
        if set(blobs)!=set(FILES):raise ValueError('missing success evidence')
        result=json.loads(blobs['result.json'])
        if result.get('status')!='PASS' or result.get('complete') is not True or result.get('cleanup')!={'disposed':True,'ownedChildrenRemaining':[]} or result.get('violations')!=[] or result.get('ledger')!=result.get('expectedLedger'):raise ValueError('runtime terminal invalid')
    items=[{'path':name,'bytes':len(b),'sha256':digest(b)} for name,b in sorted(blobs.items())]
    manifest={'schema':1,'collectionComplete':True,'resultStatus':status,'runtimeEvidenceComplete':status=='PASS','totalPayloadBytes':total,'files':items}
    if total+len(json.dumps(manifest,separators=(',',':')).encode())+1>524288:raise ValueError('total artifact cap')
    return blobs,manifest

def collect(directory):return bundle_snapshot(directory)[1]

def verify_upload(directory):
    manifest_path=directory/'manifest.json'
    if manifest_path.is_symlink() or not manifest_path.is_file() or manifest_path.stat().st_size>65536:raise ValueError('invalid upload manifest')
    manifest=json.loads(manifest_path.read_bytes())
    # Validate a snapshot of the ready directory without accepting its manifest as payload.
    blobs={}
    for p in directory.iterdir():
        if p.name=='manifest.json':continue
        if p.name not in FILES or p.is_symlink() or not p.is_file():raise ValueError('unsafe published leaf')
        cap=65536 if p.suffix=='.json' else 262144
        if p.stat().st_size>cap:raise ValueError('published leaf cap')
        b=p.read_bytes()
        if len(b)>cap:raise ValueError('published leaf cap')
        if p.suffix=='.json' and not isinstance(json.loads(b),dict):raise ValueError('published JSON malformed')
        blobs[p.name]=b
    actual=[{'path':name,'bytes':len(b),'sha256':digest(b)} for name,b in sorted(blobs.items())]
    if manifest.get('files')!=actual or manifest.get('totalPayloadBytes')!=sum(map(len,blobs.values())):raise ValueError('published bytes changed after manifest')
    if sum(map(len,blobs.values()))+manifest_path.stat().st_size>524288:raise ValueError('published total cap')
    controller=json.loads(blobs['controller.json'])
    if controller.get('complete') is not True or manifest.get('resultStatus')!=controller.get('status') or manifest.get('collectionComplete') is not True:raise ValueError('published status mismatch')
    if manifest['resultStatus']=='PASS':
        if set(blobs)!=set(FILES):raise ValueError('published success incomplete')
        result=json.loads(blobs['result.json'])
        if result.get('status')!='PASS' or result.get('complete') is not True or result.get('cleanup')!={'disposed':True,'ownedChildrenRemaining':[]} or result.get('violations')!=[] or result.get('ledger')!=result.get('expectedLedger'):raise ValueError('published runtime invalid')
    elif manifest['resultStatus']!='FAIL':raise ValueError('published status invalid')
    return manifest

def publish_snapshot(raw,ready):
    if ready.exists():raise ValueError('upload target already exists')
    blobs,manifest=bundle_snapshot(raw)
    stage_dir=pathlib.Path(tempfile.mkdtemp(prefix='d0-publication-',dir=ready.parent))
    try:
        for name,b in blobs.items():(stage_dir/name).write_bytes(b)
        write_json(stage_dir/'manifest.json',manifest)
        verify_upload(stage_dir)
        os.replace(stage_dir,ready)  # Only a fully validated snapshot becomes visible to upload.
    finally:
        if stage_dir.exists():shutil.rmtree(stage_dir)
    return manifest['resultStatus']=='PASS'

def finalize_publication(raw,ready):
    try:return publish_snapshot(raw,ready)
    except Exception as e:
        if ready.exists():raise  # Never overwrite or trust a pre-existing upload directory.
        failure=pathlib.Path(tempfile.mkdtemp(prefix='d0-failure-bundle-',dir=ready.parent))
        try:
            controller={'schema':1,'status':'FAIL','complete':True}
            discarded=[]
            def safe(name,cap):
                p=raw/name
                if p.is_symlink() or not p.is_file() or p.stat().st_size>cap:return None
                b=p.read_bytes();return b if len(b)<=cap else None
            previous=safe('controller.json',32768)
            if previous:
                try:
                    parsed=json.loads(previous)
                    if isinstance(parsed,dict):controller=parsed
                except (ValueError,TypeError):pass
            controller.update(status='FAIL',complete=True,collectionError=(type(e).__name__+': '+str(e))[:2048])
            retained=0
            for name in ['result.json','canary.json','acquisition.json','launch.json','runtime-inspection.json','image.json','stdout.log','stderr.log']:
                b=safe(name,65536 if name.endswith('.json') else 32768)
                if b is None:discarded.append(name);continue
                try:
                    if name.endswith('.json'):json.loads(b)
                except ValueError:discarded.append(name);continue
                if retained+len(b)>262144:discarded.append(name);continue
                (failure/name).write_bytes(b);retained+=len(b)
            for name in ['stdout.log','stderr.log']:
                if not (failure/name).exists():(failure/name).write_bytes(b'')
            controller['discardedFromRaw']=discarded;write_json(failure/'controller.json',controller)
            publish_snapshot(failure,ready)
        finally:shutil.rmtree(failure)
        return False

def preserve_canary(canary,before,path):
    observation={'liveBefore':before,'liveAfter':None,'runtimeReceipts':list(canary.receipts)[:64],'receiptCount':getattr(canary,'receipt_count',len(canary.receipts)),'scope':'finite owned TCP/HTTP/UDP DNS and Unix sentinel; no universal syscall claim'}
    try:observation['liveAfter']=canary.live()
    except Exception as e:observation['liveAfterError']=(type(e).__name__+': '+str(e))[:2048]
    observation['runtimeReceipts']=list(canary.receipts)[:64]
    observation['receiptCount']=getattr(canary,'receipt_count',len(canary.receipts))
    write_json(path,observation)
    return observation['liveAfter'] is not None and observation['receiptCount']==0

class OwnedAcquisition:
    """One labelled container, then one commit: no daemon build or intermediate images."""
    def __init__(self,run,task,image):
        self.run=run;self.task=task;self.image=image;self.name=task+'-acquire';self.cid=None;self.iid=None
        self.evidence={'containerName':self.name,'basePullAttempted':False,'createAttempted':False,'createCompletionVerified':False,'containerCompletionVerified':False,'commitAttempted':False,'commitCompletionVerified':True,'cleanupVerified':False}
    def query(self,argv):return json.loads(self.run(argv)[1])
    def inspect_container(self):
        code,data,err=self.run(['docker','inspect',self.cid or self.name],check=False)
        if code:
            if b'No such object' in err:return None
            raise RuntimeError('acquisition inspection failed')
        info=json.loads(data)[0]
        if info['Config']['Labels'].get('personal-event-d0')!=self.task:raise RuntimeError('acquisition ownership mismatch')
        if self.cid and info['Id']!=self.cid:raise RuntimeError('acquisition identity changed')
        self.cid=info['Id'];self.evidence['containerId']=self.cid;return info
    def stopped(self):
        wait=self.run(['docker','wait',self.cid])[1].decode().strip();info=self.inspect_container()
        if not info or info['State']['Running'] or info['State']['Status']!='exited' or info.get('ExecIDs'):raise RuntimeError('acquisition work not observed finished')
        if int(wait)!=info['State']['ExitCode']:raise RuntimeError('acquisition wait/state exit mismatch')
        self.evidence['containerExitCode']=int(wait);self.evidence['containerCompletionVerified']=True
        if self.evidence.get('activeCommand'):
            self.evidence['cancelledCommand']=self.evidence['activeCommand'];self.evidence['activeCommand']=None
    def acquire(self,context):
        self.evidence.update(basePullAttempted=True,basePullCompletionVerified=False)
        self.run(['docker','pull','--platform','linux/amd64',BASE]);self.evidence['basePullCompletionVerified']=True
        keeper='process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'
        self.evidence['createAttempted']=True
        self.cid=self.run(['docker','create','--name',self.name,'--label','personal-event-d0='+self.task,'--platform','linux/amd64','--network','bridge','--cpus','2','--memory','2147483648','--pids-limit','256','--entrypoint','node',BASE,'-e',keeper])[1].decode().strip()
        if len(self.cid)!=64:raise RuntimeError('missing acquisition id')
        self.inspect_container();self.evidence['createCompletionVerified']=True;self.run(['docker','cp',str(context)+'/.',self.cid+':/probe']);self.run(['docker','start',self.cid])
        env=['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8','npm_config_userconfig=/dev/null','npm_config_globalconfig=/dev/null','npm_config_registry=https://registry.npmjs.org','npm_config_update_notifier=false']
        for command in [['node','/probe/acquire.mjs','--preflight'],['npm','ci','--ignore-scripts','--include=optional','--no-audit','--no-fund','--cache=/acquisition-cache','--fetch-retries=0','--fetch-timeout=30000'],['npm','cache','verify','--cache=/acquisition-cache'],['node','/probe/acquire.mjs']]:
            self.evidence['activeCommand']=command;self.run(['docker','exec','--workdir','/probe/tooling',self.cid,'env','-i',*env,*command]);self.evidence['activeCommand']=None
        self.run(['docker','stop','--timeout','5',self.cid]);self.stopped()
        if self.evidence['containerExitCode']!=0:raise RuntimeError('acquisition keeper did not stop cleanly')
        self.evidence.update(commitAttempted=True,commitCompletionVerified=False)
        changes=['USER 10001:10001','WORKDIR /probe','ENTRYPOINT ["node","/probe/entry.mjs"]','CMD []','ENV PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 NODE_ENV=test WORKERD_BINARY_PATH=/probe/tooling/node_modules/@cloudflare/workerd-linux-64/bin/workerd','LABEL personal-event-d0='+self.task]
        argv=['docker','commit']
        for change in changes:argv+=['--change',change]
        self.iid=self.run([*argv,self.cid,self.image])[1].decode().strip()
        if not self.iid.startswith('sha256:'):raise RuntimeError('missing committed image id')
        self.evidence.update(imageId=self.iid,commitCompletionVerified=True)
    def cleanup(self):
        errors=[]
        try:
            info=self.inspect_container()
            if info:
                self.evidence['createCompletionVerified']=True
                if info['State']['Status']=='created' and not info.get('ExecIDs'):
                    self.evidence['containerCompletionVerified']=True
                else:
                    if info['State']['Running']:self.run(['docker','kill',self.cid])
                    self.stopped()
                self.run(['docker','rm',self.cid])
                if self.inspect_container() is not None:raise RuntimeError('acquisition container remains')
            elif self.cid and not self.evidence['containerCompletionVerified']:raise RuntimeError('acquisition completion unobserved')
        except Exception as e:errors.append(str(e))
        try:
            code,data,err=self.run(['docker','image','inspect',self.iid or self.image],check=False)
            if code:
                if b'No such image' not in err:raise RuntimeError('acquisition image inspection failed')
            else:
                info=json.loads(data)[0]
                if info['Config']['Labels'].get('personal-event-d0')!=self.task:raise RuntimeError('acquisition image ownership mismatch')
                self.run(['docker','image','rm',info['Id']])
                code,_,err=self.run(['docker','image','inspect',info['Id']],check=False)
                if code==0 or b'No such image' not in err:raise RuntimeError('acquisition image removal unverified')
        except Exception as e:errors.append(str(e))
        if self.evidence['basePullAttempted'] and not self.evidence.get('basePullCompletionVerified',False):errors.append('base pull completion unknown; shared base preserved')
        if self.evidence['createAttempted'] and not self.evidence['createCompletionVerified']:errors.append('daemon create completion unknown')
        if not self.evidence['commitCompletionVerified']:errors.append('daemon commit completion unknown; final-tag absence is not cleanup proof')
        self.evidence['cleanupVerified']=not errors;self.evidence['cleanupErrors']=errors
        if errors:raise RuntimeError('; '.join(errors))

class Canary:
    def __init__(self,root,host):
        self.token='d0'+uuid.uuid4().hex;self.stop=threading.Event();self.receipts=[];self.receipt_count=0;self.threads=[]
        self.tcp=socket.socket();self.tcp.bind(('0.0.0.0',0));self.tcp.listen(4);self.tcp.settimeout(.1)
        self.udp=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);self.udp.bind(('0.0.0.0',0));self.udp.settimeout(.1)
        self.unix=socket.socket(socket.AF_UNIX);self.path=str(root/'sentinel.sock');self.unix.bind(self.path);self.unix.listen(2);self.unix.settimeout(.1)
        self.control={'host':host,'tcpPort':self.tcp.getsockname()[1],'udpPort':self.udp.getsockname()[1],'token':self.token,'unixSentinel':self.path}
        for kind,s in [('tcp',self.tcp),('udp',self.udp),('unix',self.unix)]:
            t=threading.Thread(target=self.serve,args=(kind,s),daemon=True);self.threads.append(t);t.start()
    def record(self,receipt):
        self.receipt_count+=1
        if len(self.receipts)<64:self.receipts.append(receipt)
    def serve(self,kind,s):
        while not self.stop.is_set():
            try:
                if kind=='udp':
                    data,peer=s.recvfrom(512)
                    if self.token.encode() in data:self.record({'kind':kind,'bytes':len(data)})
                    s.sendto(data,peer)
                else:
                    c,_=s.accept()
                    with c:
                        c.settimeout(.4);data=c.recv(512)
                        if self.token.encode() in data:self.record({'kind':kind,'bytes':len(data)})
                        c.sendall(b'HTTP/1.0 200 OK\r\nContent-Length:4\r\n\r\nlive' if kind=='tcp' else b'live')
            except (TimeoutError,socket.timeout):pass
            except OSError:
                if not self.stop.is_set():self.record({'kind':kind,'serverError':True})
    def live(self):
        with socket.create_connection((self.control['host'],self.control['tcpPort']),timeout=1) as s:
            s.sendall(b'GET /live HTTP/1.0\r\n\r\n');reply=b''
            while True:
                chunk=s.recv(512)
                if not chunk:break
                reply+=chunk
                if len(reply)>512:raise RuntimeError('canary liveness output cap')
            assert reply.endswith(b'live')
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
            s.settimeout(1);s.sendto(b'live',(self.control['host'],self.control['udpPort']));assert s.recv(512)==b'live'
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(1);s.connect(self.path);s.sendall(b'live');assert s.recv(512)==b'live'
        return {'tcp':True,'udp':True,'unix':True}
    def close(self):
        self.stop.set()
        for s in (self.tcp,self.udp,self.unix):s.close()
        for t in self.threads:t.join(1)
        if any(t.is_alive() for t in self.threads):raise RuntimeError('canary thread cleanup')
        pathlib.Path(self.path).unlink(missing_ok=True)

def require_ci():
    if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('GITHUB_EVENT_NAME')!='push' or os.environ.get('GITHUB_REF')!=BRANCH or os.environ.get('GITHUB_REPOSITORY')!='jsbindra00/personal-event-aggregator':raise SystemExit('Hosted reviewed diagnostic push only')

def main():
    require_ci()
    source=pathlib.Path(__file__).resolve().parents[2];out=pathlib.Path(os.environ['RUNNER_TEMP'])/'personal-event-d0-raw'
    if out.exists():raise SystemExit('Evidence path already exists')
    out.mkdir(mode=0o700);scratch=pathlib.Path(tempfile.mkdtemp(prefix='personal-event-d0-',dir=os.environ['RUNNER_TEMP']));context=scratch/'context';context.mkdir()
    task='personal-event-d0-'+uuid.uuid4().hex;image=task+':sealed';cid=None;canary=None;live_before=None;used=0;logs={'stdout':bytearray(),'stderr':bytearray()};deadline=time.monotonic()+300;in_cleanup=False
    report={'schema':1,'status':'FAIL','phase':'acquisition','complete':False,'cleanup':{},'commands':[],'scope':'synthetic D0, zero application imports/migration increment'}
    def run(argv,timeout=None,hook=None,check=True):
        nonlocal used
        limit=min(deadline-time.monotonic(),timeout or 10000)
        if limit<=0:raise RuntimeError('phase watchdog')
        report['commands'].append(argv)
        # No inherited canary socket, sentinel socket, SSH agent, cloud env or token FD.
        p=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=ENV,close_fds=True)
        sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ,'stdout');sel.register(p.stderr,selectors.EVENT_READ,'stderr');capture={'stdout':bytearray(),'stderr':bytearray()};started=time.monotonic()
        try:
            if hook:hook()
            while sel.get_map():
                if time.monotonic()-started>limit:raise RuntimeError('command watchdog')
                for key,_ in sel.select(.1):
                    b=os.read(key.fileobj.fileno(),16384)
                    if not b:sel.unregister(key.fileobj);continue
                    capture[key.data].extend(b)
                    if len(capture['stdout'])+len(capture['stderr'])>262144:raise RuntimeError('command output cap')
                    if not in_cleanup:
                        used+=len(b)
                        room=max(0,262144-sum(len(v) for v in logs.values()));logs[key.data].extend(b[:room])
                        if used>262144:raise RuntimeError('combined output cap')
            code=p.wait(timeout=max(.1,limit-(time.monotonic()-started)))
            if check and code:raise RuntimeError('command exit '+str(code)+': '+argv[0])
            return code,bytes(capture['stdout']),bytes(capture['stderr'])
        except BaseException:
            p.kill();p.wait(timeout=5);raise
        finally:sel.close();p.stdout.close();p.stderr.close()
    def query(argv):return json.loads(run(argv)[1])
    acquisition=OwnedAcquisition(run,task,image)
    try:
        report['source']=stage(source,context)
        if shutil.disk_usage(scratch).free<1610612736:raise RuntimeError('free space below 1536 MiB')
        acquisition.acquire(context)
        base_info=query(['docker','image','inspect',BASE])[0];assert any(d.endswith(BASE.split('@')[1]) for d in base_info['RepoDigests'])
        image_info=query(['docker','image','inspect',image])[0];write_json(out/'image.json',{'base':{'selector':BASE,'Id':base_info['Id'],'RepoDigests':base_info['RepoDigests']},'derived':{'Id':image_info['Id'],'RepoDigests':image_info['RepoDigests'],'Architecture':image_info['Architecture'],'Os':image_info['Os'],'Config':image_info['Config']}})
        assert image_info['Architecture']=='amd64' and image_info['Os']=='linux'
        report['phase']='offline';deadline=time.monotonic()+720
        gateway=query(['docker','network','inspect','bridge'])[0]['IPAM']['Config'][0]['Gateway']
        canary=Canary(scratch,gateway);live_before=canary.live();control=dict(canary.control)
        control['hostNamespaces']={n:os.readlink('/proc/self/ns/'+n) for n in ('net','mnt','pid','user','ipc')};control['started']=False
        controlpath=scratch/'control.json';write_json(controlpath,control);controlpath.chmod(0o644)
        argv=['docker','create','--name',task,'--label','personal-event-d0='+task,'--platform','linux/amd64','--network','none','--user','10001:10001','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','2','--memory','2147483648','--memory-swap','2147483648','--pids-limit','256','--ipc','private','--cgroupns','private','--log-driver','none','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777','--tmpfs','/run:rw,noexec,nosuid,nodev,size=16777216,mode=755','--mount','type=bind,src='+str(controlpath)+',dst=/control.json,readonly','--hostname','d0-offline','--env','NODE_VERSION','--env','YARN_VERSION']
        for value in ('PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8','HOSTNAME=d0-offline','NODE_ENV=test','WORKERD_BINARY_PATH=/probe/tooling/node_modules/@cloudflare/workerd-linux-64/bin/workerd'):argv+=['--env',value]
        argv.append(image);cid=run(argv)[1].decode().strip();assert len(cid)==64
        control['inspection']=query(['docker','inspect',cid])[0];control['controlPath']=str(controlpath)
        assert control['inspection']['Image']==image_info['Id'];write_json(controlpath,control)
        write_json(out/'launch.json',{'argv':argv,'stdin':'DEVNULL','stdout':'bounded pipe','stderr':'bounded pipe','close_fds':True,'pass_fds':[],'outsideSentinelMounted':False,'imageId':image_info['Id']})
        def started():
            for _ in range(100):
                actual=query(['docker','inspect',cid])[0]
                if actual['State']['Running']:
                    assert actual['Image']==image_info['Id'];control['inspection']=actual;control['started']=True;write_json(controlpath,control);write_json(out/'runtime-inspection.json',actual);return
                time.sleep(.05)
            raise RuntimeError('container startup inspection missing')
        code,stdout,stderr=run(['docker','start','--attach',cid],hook=started,check=False)
        final_state=query(['docker','inspect',cid])[0]['State'];report['runtimeExit']={k:final_state.get(k) for k in ['Running','ExitCode','OOMKilled','Dead','Error']}
        lines=stdout.decode('utf8',errors='strict').splitlines();terminals=[line[10:] for line in lines if line.startswith('D0_RESULT ')]
        if len(terminals)!=1 or not lines[-1].startswith('D0_RESULT '):raise RuntimeError('missing/truncated/nonterminal evidence')
        if len(terminals[0].encode())>65536:raise RuntimeError('terminal JSON cap')
        terminal=json.loads(terminals[0]);write_json(out/'result.json',terminal)
        if terminal.get('acquisition'):write_json(out/'acquisition.json',terminal['acquisition'])
        if final_state['Running'] or final_state['ExitCode']!=0 or final_state['OOMKilled'] or final_state['Dead'] or final_state['Error']:raise RuntimeError('runtime exit/oom failure')
        if code!=0 or terminal.get('status')!='PASS' or terminal.get('complete') is not True or terminal.get('cleanup')!={'disposed':True,'ownedChildrenRemaining':[]}:raise RuntimeError('runtime not accepted')
        report['status']='PASS'
    except BaseException as e:report['error']=type(e).__name__+': '+str(e)
    finally:
        report['phase']='collection';deadline=time.monotonic()+180;in_cleanup=True
        def cleanup_step(key,fn):
            try:fn();report['cleanup'][key]=True
            except BaseException as e:report['status']='FAIL';report['cleanup'][key]=False;report['cleanup'][key+'Error']=type(e).__name__+': '+str(e)
        def remove_container():
            target=cid or task
            code,data,err=run(['docker','inspect',target],check=False)
            if code:
                if b'No such object' in err and cid is None:return
                raise RuntimeError('runtime removal inspection failed')
            info=json.loads(data)[0];assert info['Config']['Labels'].get('personal-event-d0')==task
            run(['docker','rm','--force',info['Id']])
            code,_,err=run(['docker','inspect',info['Id']],check=False)
            if code==0 or b'No such object' not in err:raise RuntimeError('runtime removal unverified')
        cleanup_step('containerRemovedOrNeverCreated',remove_container)
        cleanup_step('acquisitionResourcesRemoved',acquisition.cleanup)
        report['acquisitionLifecycle']=acquisition.evidence
        if canary:
            try:
                if not preserve_canary(canary,live_before,out/'canary.json'):report['status']='FAIL'
            except Exception as e:report['status']='FAIL';report['canaryEvidenceError']=str(e)[:2048]
            cleanup_step('canaryClosed',canary.close)
            # Include receipts queued before shutdown, even when runtime or cleanup failed.
            observation=json.loads((out/'canary.json').read_text()) if (out/'canary.json').exists() else {'liveBefore':live_before,'liveAfter':None}
            observation.update(runtimeReceipts=list(canary.receipts),receiptCount=canary.receipt_count)
            write_json(out/'canary.json',observation)
            if canary.receipt_count:report['status']='FAIL'
        cleanup_step('scratchRemoved',lambda:shutil.rmtree(scratch))
        report['complete']=True;report['combinedLogBytes']=used
        (out/'stdout.log').write_bytes(logs['stdout']);(out/'stderr.log').write_bytes(logs['stderr']);write_json(out/'controller.json',report)
    raise SystemExit(0 if report['status']=='PASS' else 1)

def prepare_upload():
    require_ci()
    root=pathlib.Path(os.environ['RUNNER_TEMP']);ready=root/'personal-event-d0-upload'
    passed=finalize_publication(root/'personal-event-d0-raw',ready)
    verify_upload(ready)  # Recheck final bytes immediately before exposing action readiness.
    with open(os.environ['GITHUB_OUTPUT'],'a',encoding='utf8') as output:output.write('ready=true\n')
    raise SystemExit(0 if passed else 1)

if __name__=='__main__':
    if sys.argv[1:]==['--prepare-upload']:prepare_upload()
    elif sys.argv[1:]:raise SystemExit('unknown controller argv')
    else:main()
