"""Pure filesystem/output tests; never container observations or candidate imports."""
import importlib.util,json,pathlib,tempfile,unittest
spec=importlib.util.spec_from_file_location('controller',pathlib.Path(__file__).parents[1]/'controller.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
class CollectionTests(unittest.TestCase):
    def output(self,root,status='PASS'):
        for name in c.FILES:
            (root/name).write_text('{}' if name.endswith('.json') else '')
        (root/'controller.json').write_text(json.dumps({'status':status,'complete':True}))
        (root/'result.json').write_text(json.dumps({'status':status,'complete':True,'ledger':[],'expectedLedger':[],'violations':[],'cleanup':{'disposed':True,'ownedChildrenRemaining':[]}}))
    def test_complete_success_is_collected(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d);self.output(p);self.assertEqual(c.collect(p)['resultStatus'],'PASS')
    def test_missing_success_evidence_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d);self.output(p);(p/'canary.json').unlink()
            with self.assertRaises(ValueError):c.collect(p)
    def test_truncated_result_or_unexpected_fetch_is_rejected(self):
        for raw in ['{',json.dumps({'status':'PASS','complete':True,'ledger':[{'url':'https://other.invalid/'}],'expectedLedger':[],'violations':[],'cleanup':{'disposed':True,'ownedChildrenRemaining':[]}})]:
            with tempfile.TemporaryDirectory() as d:
                p=pathlib.Path(d);self.output(p);(p/'result.json').write_text(raw)
                with self.assertRaises(ValueError):c.collect(p)
    def test_symlink_unknown_file_and_oversize_are_rejected(self):
        for kind in ['symlink','unknown','oversize']:
            with tempfile.TemporaryDirectory() as d:
                p=pathlib.Path(d);self.output(p)
                if kind=='symlink':(p/'stdout.log').unlink();(p/'stdout.log').symlink_to('result.json')
                if kind=='unknown':(p/'private-source.txt').write_text('synthetic')
                if kind=='oversize':(p/'stdout.log').write_bytes(b'x'*262145)
                with self.assertRaises(ValueError):c.collect(p)
    def test_partial_failure_is_labelled_failure(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d);(p/'controller.json').write_text('{"status":"FAIL","complete":true}');(p/'stdout.log').write_text('');(p/'stderr.log').write_text('failed')
            x=c.collect(p);self.assertEqual(x['resultStatus'],'FAIL');self.assertFalse(x['runtimeEvidenceComplete'])
class StageTests(unittest.TestCase):
    def source(self,root):
        p=root/'probe/personal-event';p.mkdir(parents=True);(p/'a.txt').write_text('abc')
        workflow=root/'.github/workflows/personal-event-worker-probe.yml';workflow.parent.mkdir(parents=True);workflow.write_text('synthetic')
        (p/'source-manifest.json').write_text(json.dumps({'sha256':{'probe/personal-event/a.txt':'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad','.github/workflows/personal-event-worker-probe.yml':c.digest(b'synthetic')}}))
        return p
    def test_exact_payload_is_staged_without_git_or_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);source=root/'source';source.mkdir();self.source(source);(source/'.git').mkdir();(source/'.env').write_text('synthetic-secret')
            context=root/'context';context.mkdir();c.stage(source,context)
            self.assertEqual(sorted(p.name for p in context.iterdir()),['a.txt','source-manifest.json'])
    def test_changed_unknown_and_symlinked_inputs_are_rejected(self):
        for kind in ['changed','unknown','symlink-directory']:
            with tempfile.TemporaryDirectory() as d:
                root=pathlib.Path(d);source=root/'source';source.mkdir();p=self.source(source);context=root/'context';context.mkdir()
                if kind=='changed':(p/'a.txt').write_text('abd')
                if kind=='unknown':(p/'extra').write_text('abc')
                if kind=='symlink-directory':(p/'outside').symlink_to(root,target_is_directory=True)
                with self.assertRaises(ValueError):c.stage(source,context)
class WorkflowContractTests(unittest.TestCase):
    def test_only_root_selected_artifact_action_and_bounded_zip_settings(self):
        text=(pathlib.Path(__file__).parents[3]/'.github/workflows/personal-event-worker-probe.yml').read_text()
        import re
        self.assertEqual(re.findall(r'uses:\s*(\S+)',text),['actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9'])
        for key,value in [('archive','true'),('include-hidden-files','false'),('overwrite','false'),('retention-days','1'),('if-no-files-found','error')]:
            self.assertRegex(text,r'(?m)^          '+key+': '+value+r'$')
        self.assertIn('branches: [codex/cloudflare-personal-event-probe]',text)
        self.assertNotRegex(text,r'(?m)^  (pull_request|pull_request_target|workflow_dispatch):')
class PublicationTests(unittest.TestCase):
    def output(self,root,status='PASS'):CollectionTests.output(self,root,status)
    def test_rejected_bytes_never_enter_upload_directory(self):
        for kind in ['unknown','oversize','aggregate','symlink','incomplete','malformed-json']:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as d:
                root=pathlib.Path(d);raw=root/'raw';raw.mkdir();upload=root/'upload';self.output(raw)
                if kind=='unknown':(raw/'private-source.txt').write_text('REJECTED_SECRET')
                if kind=='oversize':(raw/'stdout.log').write_bytes(b'x'*262145)
                if kind=='aggregate':(raw/'stdout.log').write_bytes(b'x'*250000);(raw/'stderr.log').write_bytes(b'y'*250000)
                if kind=='symlink':(raw/'stdout.log').unlink();(raw/'stdout.log').symlink_to('result.json')
                if kind=='incomplete':(raw/'canary.json').unlink()
                if kind=='malformed-json':(raw/'canary.json').write_text('{truncated')
                self.assertFalse(c.finalize_publication(raw,upload))
                manifest=c.verify_upload(upload);self.assertEqual(manifest['resultStatus'],'FAIL')
                self.assertFalse((upload/'private-source.txt').exists())
                self.assertLessEqual(sum(p.stat().st_size for p in upload.iterdir()),524288)
                self.assertIn('collectionError',json.loads((upload/'controller.json').read_text()))
    def test_failure_after_staging_manifest_cannot_expose_stale_pass(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);raw=root/'raw';raw.mkdir();upload=root/'upload';self.output(raw)
            original=c.write_json;injected=False
            def write(path,value):
                nonlocal injected
                original(path,value)
                if path.name=='manifest.json' and not injected:
                    injected=True;(path.parent/'controller.json').write_text('{"status":"PASS","complete":false}')
            with patch.object(c,'write_json',side_effect=write):self.assertFalse(c.finalize_publication(raw,upload))
            self.assertEqual(c.verify_upload(upload)['resultStatus'],'FAIL')
    def test_changed_published_bytes_are_not_upload_ready(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);raw=root/'raw';raw.mkdir();upload=root/'upload';self.output(raw)
            self.assertTrue(c.finalize_publication(raw,upload));(upload/'stdout.log').write_text('changed after manifest')
            with self.assertRaises(ValueError):c.verify_upload(upload)
    def test_failure_case_diagnostics_and_canary_ledger_survive_validated_bundle(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);raw=root/'raw';raw.mkdir();upload=root/'upload';self.output(raw,'FAIL')
            result={'status':'FAIL','complete':True,'cases':[{'terminal':{'status':'FAIL','error':'synthetic native error','cleanup':{'disposed':False,'error':'synthetic disposal error'}}},{'terminal':None,'stdoutDiagnostic':'D0_CASE {truncated','parseError':'synthetic malformed terminal'}]}
            (raw/'result.json').write_text(json.dumps(result));(raw/'canary.json').write_text(json.dumps({'runtimeReceipts':[{'kind':'udp','bytes':42}],'liveAfterError':'synthetic offline failure'}))
            self.assertFalse(c.finalize_publication(raw,upload));self.assertEqual(c.verify_upload(upload)['resultStatus'],'FAIL')
            self.assertEqual(json.loads((upload/'result.json').read_text()),result)
            self.assertEqual(json.loads((upload/'canary.json').read_text())['runtimeReceipts'],[{'kind':'udp','bytes':42}])
    def test_canary_failure_snapshot_is_saved_even_when_liveness_raises(self):
        class PureCanary:
            receipts=[{'kind':'udp','bytes':42}];receipt_count=1
            def live(self):raise RuntimeError('synthetic runtime failed')
        with tempfile.TemporaryDirectory() as d:
            path=pathlib.Path(d)/'canary.json';self.assertFalse(c.preserve_canary(PureCanary(),{'tcp':True},path))
            record=json.loads(path.read_text());self.assertEqual(record['runtimeReceipts'],PureCanary.receipts);self.assertIn('synthetic runtime failed',record['liveAfterError'])
    def test_actual_prepare_entrypoint_sets_ready_only_for_verified_target(self):
        from unittest.mock import patch
        for rejected in [False,True]:
            with self.subTest(rejected=rejected),tempfile.TemporaryDirectory() as d:
                root=pathlib.Path(d);raw=root/'personal-event-d0-raw';raw.mkdir();self.output(raw)
                if rejected:(raw/'private.txt').write_text('REJECTED')
                output=root/'github-output';output.write_text('')
                with patch.dict(c.os.environ,{'RUNNER_TEMP':str(root),'GITHUB_OUTPUT':str(output)}),patch.object(c,'require_ci'):
                    with self.assertRaises(SystemExit) as end:c.prepare_upload()
                self.assertEqual(end.exception.code,1 if rejected else 0);self.assertEqual(output.read_text(),'ready=true\n')
                self.assertEqual(c.verify_upload(root/'personal-event-d0-upload')['resultStatus'],'FAIL' if rejected else 'PASS')
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);raw=root/'personal-event-d0-raw';raw.mkdir();self.output(raw);output=root/'github-output';output.write_text('')
            with patch.dict(c.os.environ,{'RUNNER_TEMP':str(root),'GITHUB_OUTPUT':str(output)}),patch.object(c,'require_ci'),patch.object(c,'verify_upload',side_effect=ValueError('synthetic post-manifest rejection')):
                with self.assertRaises(ValueError):c.prepare_upload()
            self.assertEqual(output.read_text(),'');self.assertFalse((root/'personal-event-d0-upload').exists())
    def test_workflow_upload_is_gated_by_verified_publication(self):
        text=(pathlib.Path(__file__).parents[3]/'.github/workflows/personal-event-worker-probe.yml').read_text()
        self.assertIn('id: evidence',text);self.assertIn('controller.py" --prepare-upload',text)
        self.assertIn("if: always() && steps.evidence.outputs.ready == 'true'",text)
        self.assertIn('path: ${{ runner.temp }}/personal-event-d0-upload/',text)
        self.assertNotIn('path: ${{ runner.temp }}/personal-event-d0-evidence/',text)

class PureDocker:
    """Command-response fixture only: no Docker calls or container observations."""
    def __init__(self,task,fail=None):self.task=task;self.fail=fail;self.calls=[];self.exists=False;self.running=False;self.image=False;self.active=False;self.exit=0;self.cid='a'*64;self.iid='sha256:'+'b'*64
    def __call__(self,argv,**kwargs):
        self.calls.append(argv);a=argv[1:];out=b'';code=0;err=b''
        if a[:2]==['image','inspect']:
            if a[2]==c.BASE:out=json.dumps([{'Id':'sha256:base','RepoDigests':[c.BASE]}]).encode()
            elif self.image:out=json.dumps([{'Id':self.iid,'Config':{'Labels':{'personal-event-d0':self.task}}}]).encode()
            else:code=1;err=b'No such image'
        elif a[0]=='create':self.exists=True;out=self.cid.encode()
        elif a[0]=='inspect':
            if self.exists:out=json.dumps([{'Id':self.cid,'Config':{'Labels':{'personal-event-d0':self.task}},'State':{'Running':self.running,'Status':'running' if self.running else 'exited','ExitCode':self.exit},'ExecIDs':['synthetic-exec'] if self.active else None}]).encode()
            else:code=1;err=b'No such object'
        elif a[0]=='start':self.running=True
        elif a[0]=='exec':
            if self.fail=='after-install' and 'verify' in a:raise RuntimeError('synthetic cache verify failure after npm ci')
            if self.fail=='active-exec' and 'ci' in a:self.active=True;raise TimeoutError('synthetic client interruption')
        elif a[0] in ['stop','kill']:self.running=False;self.active=False;self.exit=137 if a[0]=='kill' else 0
        elif a[0]=='wait':out=str(self.exit).encode()
        elif a[0]=='commit':
            if self.fail=='commit-unknown':raise TimeoutError('synthetic daemon commit completion unknown')
            self.image=True;out=self.iid.encode()
        elif a[0]=='rm':self.exists=False
        elif a[:2]==['image','rm']:self.image=False
        return code,out,err

class AcquisitionLifecycleTests(unittest.TestCase):
    def test_distinct_empty_configs_are_prepared_before_first_npm_command(self):
        runner=PureDocker('task');a=c.OwnedAcquisition(runner,'task','task:sealed');a.acquire(pathlib.Path('/synthetic/context'))
        executions=[v for v in runner.calls if v[1]=='exec']
        setup=[v for v in executions if '--prepare-npm-config' in v]
        self.assertEqual(len(setup),1)
        npm_calls=[v for v in executions if 'npm' in v]
        self.assertGreater(len(npm_calls),0);self.assertLess(executions.index(setup[0]),executions.index(npm_calls[0]))
        for v in executions:
            self.assertIn('env',v);self.assertIn('-i',v)
            self.assertIn('npm_config_userconfig=/acquisition-config/user.npmrc',v)
            self.assertIn('npm_config_globalconfig=/acquisition-config/global.npmrc',v)
            self.assertNotIn('npm_config_userconfig=/dev/null',v);self.assertNotIn('npm_config_globalconfig=/dev/null',v)
        ci=next(v for v in npm_calls if 'ci' in v)
        for flag in ['--ignore-scripts','--no-audit','--no-fund','npm_config_registry=https://registry.npmjs.org']:self.assertIn(flag,ci)
        a.cleanup()

    def test_failure_after_install_reaps_exact_container_with_no_final_tag(self):
        runner=PureDocker('task','after-install');a=c.OwnedAcquisition(runner,'task','task:sealed')
        with self.assertRaises(RuntimeError):a.acquire(pathlib.Path('/synthetic/context'))
        a.cleanup();self.assertFalse(runner.exists);self.assertFalse(runner.image)
        self.assertTrue(a.evidence['containerCompletionVerified']);self.assertTrue(a.evidence['cleanupVerified'])
        self.assertTrue(any(v[1]=='wait' for v in runner.calls));self.assertFalse(any('build' in v or 'prune' in v for v in runner.calls))
        self.assertEqual([v for v in runner.calls if v[1]=='rm'],[['docker','rm',runner.cid]])
    def test_interrupted_active_execution_is_killed_waited_and_removed(self):
        runner=PureDocker('task','active-exec');a=c.OwnedAcquisition(runner,'task','task:sealed')
        with self.assertRaises(TimeoutError):a.acquire(pathlib.Path('/synthetic/context'))
        self.assertTrue(runner.active);a.cleanup();self.assertFalse(runner.active);self.assertFalse(runner.exists)
        kill=next(i for i,v in enumerate(runner.calls) if v[1]=='kill');wait=next(i for i,v in enumerate(runner.calls) if v[1]=='wait');remove=next(i for i,v in enumerate(runner.calls) if v[1]=='rm');self.assertLess(kill,wait);self.assertLess(wait,remove)
    def test_unknown_commit_completion_is_failed_cleanup_even_when_final_tag_absent(self):
        runner=PureDocker('task','commit-unknown');a=c.OwnedAcquisition(runner,'task','task:sealed')
        with self.assertRaises(TimeoutError):a.acquire(pathlib.Path('/synthetic/context'))
        with self.assertRaises(RuntimeError):a.cleanup()
        self.assertFalse(runner.exists);self.assertFalse(a.evidence['cleanupVerified']);self.assertFalse(a.evidence['commitCompletionVerified'])
    def test_success_uses_owned_container_and_one_commit_then_removes_exact_image(self):
        runner=PureDocker('task');a=c.OwnedAcquisition(runner,'task','task:sealed');a.acquire(pathlib.Path('/synthetic/context'));a.cleanup()
        self.assertTrue(a.evidence['cleanupVerified']);self.assertFalse(runner.exists);self.assertFalse(runner.image)
        commits=[v for v in runner.calls if v[1]=='commit'];self.assertEqual(len(commits),1)
        self.assertTrue(any('ENTRYPOINT ["node","/probe/entry.mjs"]' in v for v in commits))
        self.assertFalse(any('prune' in v or 'build' in v for v in runner.calls))
if __name__=='__main__':unittest.main()
