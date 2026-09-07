#!/usr/bin/env python3
"""Real Linux PTY/daemon tests; all sessions and sockets are isolated in /tmp.
No existing user daemon, shell configuration, SSH connection or session is touched.
"""
import fcntl, json, os, pathlib, pty, select, shutil, struct, subprocess, tempfile, termios, time

binary = os.environ.get('SHPOOL_TEST_BINARY') or str(pathlib.Path(__file__).resolve().parents[1] / 'vendor/linux-x64/shpool')
assert pathlib.Path(binary).is_file(), 'Run npm run runtime:fetch or set SHPOOL_TEST_BINARY'

def wait_for(fn, timeout=10):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        result=fn()
        if result: return result
        time.sleep(.1)
    raise AssertionError('condition timed out')

with tempfile.TemporaryDirectory(prefix='vscode-shpool-pty-') as root:
    root=pathlib.Path(root)
    config=root/'config.toml'; config.write_text('shell = "/bin/bash"\nnorc = true\nprompt_prefix = ""\n')
    socket=str(root/'daemon.sock')
    args=[binary,'--socket',socket,'--config-file',str(config)]
    daemon=None; clients=[]
    log=open(root/'daemon.log','w')
    def start():
        global daemon
        daemon=subprocess.Popen(args+['daemon'],stdout=log,stderr=log,start_new_session=True)
        wait_for(lambda: pathlib.Path(socket).exists())
    def cli(*cmd,check=True):
        return subprocess.run(args+list(cmd),text=True,capture_output=True,timeout=10,check=check)
    def sessions(): return json.loads(cli('list','--json').stdout)['sessions']
    def session(name): return next((s for s in sessions() if s['name']==name),None)
    def attach(name,force=False):
        master,slave=pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
        p=subprocess.Popen(args+['attach']+(['--force'] if force else [])+['--dir',str(root),name],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,env={**os.environ,'TERM':'xterm-256color'})
        os.close(slave); clients.append((p,master));return p,master
    def send(fd,s): os.write(fd,s.encode()+b'\n')
    def read(fd):
        data=b''
        while select.select([fd],[],[],.1)[0]:
            try: data+=os.read(fd,65536)
            except OSError: break
        return data
    try:
        start()
        terminals={}
        for n in range(1,4):
            name=f'test-project-{n}';p,fd=attach(name);terminals[name]=(p,fd)
            wait_for(lambda: session(name) and session(name)['status']=='Attached')
        assert {s['name'] for s in sessions()}==set(terminals)
        print('PASS: 3 direct attach processes create 3 distinct named sessions')
        p,fd=terminals['test-project-1']
        send(fd,'echo $$ > shell.pid; while true; do date +%s >> heartbeat; sleep 0.2; done')
        wait_for(lambda: (root/'shell.pid').exists() and (root/'heartbeat').exists())
        shell_pid=int((root/'shell.pid').read_text());generation=session('test-project-1')['started_at_unix_ms']
        count=len((root/'heartbeat').read_text().splitlines())
        p.kill();p.wait(timeout=5);os.close(fd)
        wait_for(lambda: session('test-project-1')['status']=='Disconnected')
        time.sleep(.8)
        assert len((root/'heartbeat').read_text().splitlines())>count
        os.kill(shell_pid,0)
        p,fd=attach('test-project-1');terminals['test-project-1']=(p,fd)
        wait_for(lambda: session('test-project-1')['status']=='Attached')
        assert session('test-project-1')['started_at_unix_ms']==generation
        print('PASS: SIGKILL of backing client preserves loop and shell PID; reattach resumes same generation')
        busy,other=attach('test-project-1');wait_for(lambda: busy.poll() is not None)
        assert p.poll() is None
        assert any(a['pid']==p.pid for a in session('test-project-1')['attachments'])
        assert b'already has a terminal attached' in read(other)
        forced,newfd=attach('test-project-1',True)
        wait_for(lambda: any(a['pid']==forced.pid for a in session('test-project-1')['attachments']))
        assert session('test-project-1')['started_at_unix_ms']==generation
        print('PASS: normal attach refuses occupied session; explicit force displaces client only')
        p2,fd2=terminals['test-project-2']
        send(fd2,'echo $$ > shell2.pid; while true; do sleep 1; done')
        wait_for(lambda: (root/'shell2.pid').exists())
        pid2=int((root/'shell2.pid').read_text())
        p2.terminate();p2.wait(timeout=5)
        cli('kill','test-project-2')
        wait_for(lambda: session('test-project-2') is None)
        def dead():
            try:
                state=pathlib.Path(f'/proc/{pid2}/stat').read_text().split(') ')[1][0]
                return state=='Z'
            except FileNotFoundError: return True
        wait_for(dead)
        assert {s['name'] for s in sessions()}=={'test-project-1','test-project-3'}
        print('PASS: independent kill after client termination kills only session 2 and its shell')
        p3,fd3=terminals['test-project-3'];send(fd3,'exit')
        wait_for(lambda: session('test-project-3') is None)
        wait_for(lambda: p3.poll() is not None)
        print('PASS: inner shell exit removes its session without another kill')
        cli('kill','test-project-1')
        daemon.terminate();daemon.wait(timeout=5)
        pathlib.Path(socket).unlink(missing_ok=True)
        start();assert sessions()==[]
        fresh,freshfd=attach('test-project-1')
        wait_for(lambda: session('test-project-1'))
        assert session('test-project-1')['started_at_unix_ms']!=generation
        print('PASS: empty restarted daemon accepts a fresh shell under saved name (reboot simulation)')
    finally:
        if daemon and daemon.poll() is None:
            try:
                for s in sessions(): cli('kill',s['name'],check=False)
            except Exception: pass
            daemon.terminate()
            try:daemon.wait(timeout=5)
            except subprocess.TimeoutExpired:daemon.kill()
        for p,fd in clients:
            if p.poll() is None: p.kill();p.wait()
            try:os.close(fd)
            except OSError:pass
        log.close()
