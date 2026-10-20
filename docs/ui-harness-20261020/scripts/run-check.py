import datetime, json, os, pathlib, subprocess, sys

task = pathlib.Path(__file__).resolve().parent.parent
name, cwd, *command = sys.argv[1:]
log = task / 'evidence' / 'logs' / (name + '.log')
state = task / 'checks-state' / name
state.mkdir(parents=True, exist_ok=True)
env = {'PATH':'/opt/homebrew/bin:/Users/geb/.local/bin:/usr/bin:/bin', 'TMPDIR':'/tmp',
       'QI_AGENT_HOME':str(state / 'qi-home'), 'QI_AGENT_PRESET_USER_ROOT':str(state / 'presets'),
       'QI_AGENT_BIN':str(task / 'qi-agent/apps/tui-rs/target/debug/qi-agent'),
       'QI_AGENT_BROWSER_CHANNEL':'chrome', 'DSH_TELEMETRY_DISABLED':'1', 'QI_AGENT_E2E_ARTIFACTS':str(task / 'evidence/after/e2e'),
       'QI_AGENT_BROWSER_ARTIFACTS':str(task / 'evidence/after/regressions')}
for key in ('QI_AGENT_E2E_ARTIFACTS', 'QI_AGENT_BROWSER_ARTIFACTS'):
    pathlib.Path(env[key]).mkdir(parents=True, exist_ok=True)
start = datetime.datetime.now(datetime.timezone.utc).isoformat()
meta = {'command':command,'cwd':str(task/cwd),'start':start,'end':None,'exit_code':None,
        'status':'running','runner_pid':os.getpid(),
        'isolation':'tools/isolation.sb; whitelisted environment',
        'platform':os.uname().sysname+' '+os.uname().release+' '+os.uname().machine}
# Replace any earlier receipt before execution: a disconnected runner cannot leave a stale pass.
(log.with_suffix('.json')).write_text(json.dumps(meta,indent=2)+'\n')
with log.open('wb') as output:
    result = subprocess.run(['/usr/bin/sandbox-exec','-f',str(task/'tools/isolation.sb'),*command],
                            cwd=task/cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
meta.update({'end':datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'exit_code':result.returncode,'status':'completed'})
(log.with_suffix('.json')).write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps(meta))
print(log.read_text()[-1400:])
sys.exit(result.returncode)
