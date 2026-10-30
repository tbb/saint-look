"""Opt-in replay of the recorded concurrent HTTP/encoder memory experiment.

Only existing loopback fixtures are called; no paid services. Run inside a private
systemd user unit with MemoryMax and MemorySwapMax=0. Paths are parameters; workload,
ordering, one encoder thread, two HTTP clients and counter sampling match the
2026-10-29 measurement. This is a resource experiment, not application acceptance.
"""
import argparse
import subprocess, os, json, pathlib, time, threading, uuid, base64, urllib.request, concurrent.futures
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--backend-repo', required=True, type=pathlib.Path)
parser.add_argument('--assets', required=True, type=pathlib.Path)
parser.add_argument('--dataset', required=True, type=pathlib.Path)
parser.add_argument('--png-directory', required=True, type=pathlib.Path)
parser.add_argument('--output', required=True, type=pathlib.Path)
parser.add_argument('--data-dir', required=True, type=pathlib.Path)
parser.add_argument('--node', required=True, type=pathlib.Path)
parser.add_argument('--python', required=True, type=pathlib.Path)
parser.add_argument('--memory-mib', required=True, type=int, choices=[1024, 2048])
args = parser.parse_args()
for key, value in vars(args).items():
    if isinstance(value, pathlib.Path):
        setattr(args, key, value.absolute())
if args.data_dir.exists():
    parser.error('--data-dir must be a new directory, so previous jobs cannot affect the run')
for executable in (args.node, args.python):
    if not executable.is_file() or not os.access(executable, os.X_OK):
        parser.error('Both --node and --python must be absolute executable paths')
cgroup_path = pathlib.Path('/sys/fs/cgroup') / pathlib.Path('/proc/self/cgroup').read_text().strip().split('::')[1].lstrip('/')
if (cgroup_path / 'memory.max').read_text().strip() != str(args.memory_mib * 1024 * 1024):
    parser.error('Current cgroup MemoryMax does not match --memory-mib')
if (cgroup_path / 'memory.swap.max').read_text().strip() != '0':
    parser.error('Current cgroup must have MemorySwapMax=0')
args.output.parent.mkdir(parents=True, exist_ok=True)
worker_path = pathlib.Path(__file__).with_name('worker.py').resolve()
repo = args.backend_repo
out = args.output.parent
assets = args.assets
node = str(args.node)
manifest_path = args.dataset
items = json.loads(manifest_path.read_text())['items']
if len(items) != 16:
    parser.error('The recorded workload requires the pinned sixteen-photo manifest')
control_token = 'controlled-public-memory-token'
owner_token = 'controlled-public-memory-measurement-token'
env = {**os.environ, 'NODE_ENV': 'test', 'SAINT_LOOK_UI_PROVIDER_PORT': '0', 'SAINT_LOOK_UI_PROVIDER_CONTROL_TOKEN': control_token, 'TYPESAFE_API_KEY': 'fixture-typesafe-key', 'PHOTOROOM_API_KEY': 'sandbox_fixture', 'PHOTOROOM_SANDBOX_API_KEY': 'sandbox_fixture', 'GEMINI_API_KEY': 'fixture'}
children = []
try:
    fixture = subprocess.Popen([node, 'backend/test/providers/ui-server.mjs'], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    children.append(fixture)
    origin = json.loads(fixture.stdout.readline())['url']

    def req(url, payload=None, token=owner_token):
        request = urllib.request.Request(url, data=None if payload is None else json.dumps(payload).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return (response.status, json.loads(raw) if response.headers.get_content_type() == 'application/json' else len(raw))
    req(origin + '/__control', {'illustrationMode': 'success'}, control_token)
    env.update({'SAINT_LOOK_OWNER_TOKEN': owner_token, 'SAINT_LOOK_PROVIDER': 'live', 'SAINT_LOOK_PROVIDER_PREFLIGHT_CONFIRMED': 'true', 'SAINT_LOOK_TEST_PROVIDER_ORIGIN': origin, 'SAINT_LOOK_STAGE_DELAY_MS': '100', 'SAINT_LOOK_DATA_DIR': str(args.data_dir), 'HOST': '127.0.0.1', 'PORT': '0', 'SAINT_LOOK_ILLUSTRATIONS_ENABLED': 'true', 'SAINT_LOOK_ILLUSTRATION_TEST_ORIGIN': origin, 'SAINT_LOOK_ILLUSTRATION_TEST_CONTROLLED': 'true'})
    backend = subprocess.Popen([node, 'backend/src/server.mjs'], cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    children.append(backend)
    backend_url = json.loads(backend.stdout.readline())['url']
    print('backend health', req(backend_url + '/health')[1], flush=True)
    worker = subprocess.Popen([str(args.python), str(worker_path), '--assets', str(assets), '--threads', '1'], cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=(out / 'pipeline-model.log').open('w'), text=True)
    children.append(worker)
    cg = pathlib.Path('/sys/fs/cgroup') / pathlib.Path('/proc/self/cgroup').read_text().strip().split('::')[1].lstrip('/')

    def memory():
        return {n: (cg / n).read_text().strip() for n in ['memory.current', 'memory.peak', 'memory.events', 'memory.max', 'memory.swap.max']}
    peak_rss = 0
    stop = False

    def monitor():
        global peak_rss
        while not stop:
            rss = 0
            for p in [os.getpid(), fixture.pid, backend.pid, worker.pid]:
                try:
                    rss += next((int(x.split()[1]) for x in pathlib.Path(f'/proc/{p}/status').read_text().splitlines() if x.startswith('VmRSS:')))
                except (FileNotFoundError, StopIteration, ProcessLookupError):
                    pass
            peak_rss = max(peak_rss, rss)
            time.sleep(0.02)
    threading.Thread(target=monitor, daemon=True).start()

    def prepare(item):
        started = time.perf_counter()
        worker.stdin.write(json.dumps({'id': item['id'], 'operation': 'prepare', 'imagePath': str(manifest_path.parent / item['image']), 'photoVersionID': 'public-source-v1', 'type': item['type'], 'colors': item['colors']}) + '\n')
        worker.stdin.flush()
        answer = json.loads(worker.stdout.readline())
        assert 'result' in answer, answer
        return {'id': item['id'], 'seconds': time.perf_counter() - started}

    def poll(path):
        for _ in range(600):
            _, value = req(backend_url + path)
            if value['status'] == 'ready':
                return value
            if value['status'] == 'failed':
                raise RuntimeError(value)
            time.sleep(0.05)
        raise RuntimeError('HTTP processing timeout')

    def pipeline(item):
        started = time.perf_counter()
        itemid = str(uuid.uuid4())
        photoid = str(uuid.uuid4())
        operation = str(uuid.uuid4())
        photo = {'itemId': itemid, 'operationId': operation, 'photoVersionId': photoid, 'imageBase64': base64.b64encode((args.png_directory / (item['id'] + '.png')).read_bytes()).decode()}
        assert req(backend_url + '/v1/items', photo)[0] == 202
        ready = poll('/v1/items/' + itemid)
        assert req(backend_url + ready['resultPath'])[0] == 200
        illustration = {'operationId': str(uuid.uuid4()), 'photoVersionId': photoid, 'sourceSetVersionId': str(uuid.uuid4()), 'revision': 1, 'photos': [{'id': photoid, 'role': 'front', 'imageBase64': photo['imageBase64']}]}
        assert req(backend_url + '/v1/items/' + itemid + '/illustrations', illustration)[0] == 202
        ready = poll('/v1/items/' + itemid + '/illustrations/' + illustration['operationId'])
        status, length = req(backend_url + ready['resultPath'])
        assert status == 200
        return {'id': item['id'], 'seconds': time.perf_counter() - started, 'illustrationBytes': length}
    start = time.perf_counter()
    prepares = [prepare(items[0])]
    print('first encoder prepared', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(pipeline, item) for item in items]
        for item in items[1:]:
            prepares.append(prepare(item))
        http_results = [f.result() for f in futures]
    result = {'cgroup': str(cg), 'memory': memory(), 'summedProcessPeakRSSKiB': peak_rss, 'elapsedSeconds': time.perf_counter() - start, 'prepares': prepares, 'http': http_results, 'backendAlive': backend.poll() is None, 'workerAlive': worker.poll() is None, 'fixtureCounters': req(origin + '/__control', {}, control_token)[1], 'conditions': '1torch thread; real16encoder; two concurrent HTTP ingestion+illustration pipelines on controlled providers; reused asset files/pages; local not Fly; no paid APIs'}
    args.output.write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k not in ['prepares', 'http']}, indent=2), flush=True)
    stop = True
    worker.stdin.close()
    worker.wait(timeout=10)
    for process in [backend, fixture]:
        process.terminate()
    for process in [backend, fixture]:
        process.wait(timeout=10)
finally:
    for process in children:
        if process.poll() is None:
            process.terminate()
    for process in children:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
