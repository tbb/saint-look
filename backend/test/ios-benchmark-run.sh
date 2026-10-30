#!/usr/bin/env bash
# Explicit same-runner benchmark only. No tunnel, production token, API or provider.
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${SAINT_LOOK_BENCHMARK:-0}" == 1 ]] || { echo 'Explicit manual benchmark required.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Benchmark requires the existing ARM Mac runner.' >&2; exit 1; }
private_directory="$(mktemp -d /tmp/saint-look-benchmark-controller-XXXXXX)"
chmod 700 "$private_directory"
benchmark_pid=''
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$benchmark_pid" ]]; then
    kill -TERM "$benchmark_pid" 2>/dev/null || true
    wait "$benchmark_pid" 2>/dev/null || true
  fi
  if [[ -f "$private_directory/config" ]]; then
    python3 - "$private_directory/config" <<'PY'
import json,shutil,sys
from pathlib import Path
config=json.loads(Path(sys.argv[1]).read_text())
result=Path(config['directory'])/'result.json'
if result.is_file():
    Path('client-ios/build/benchmark/backend-model.json').write_text(json.dumps(json.loads(result.read_text()),indent=2)+'\n')
owned=result.parent
if owned.parent.resolve()==Path('/tmp').resolve() and owned.name.startswith('saint-look-benchmark-'):
    shutil.rmtree(owned)
p=Path('client-ios/build/benchmark/disk.json')
if p.is_file():
    value=json.loads(p.read_text());value['afterCatalogFreeBytes']=shutil.disk_usage('/tmp').free;p.write_text(json.dumps(value,indent=2)+'\n')
PY
  fi
  rm -rf -- "$private_directory"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p client-ios/build/benchmark
python3 - client-ios/build/benchmark/disk.json <<'PY'
import json, shutil, sys
from pathlib import Path
usage = shutil.disk_usage('/tmp')
# Budget: 1.95GB assets + <0.8GB runtime + ~1GB catalog + Xcode/temp margin.
if usage.free < 6 * 1024**3:
    raise SystemExit('Benchmark needs at least 6GiB free before model download; no cleanup of unrelated data.')
Path(sys.argv[1]).write_text(json.dumps({'scope':'runner volume free space, separate from Simulator catalog logical bytes',
    'minimumFreeBytes':6*1024**3,'beforeSetupFreeBytes':usage.free},indent=2)+'\n')
PY
python3.12 -m venv "$private_directory/venv"
model_python="$private_directory/venv/bin/python"
"$model_python" -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: -r backend/ml/requirements.txt
"$model_python" - "$private_directory/assets" <<'PY'
import runpy, socket, sys
socket.setdefaulttimeout(120)
sys.argv = ['backend/ml/fetch_assets.py', sys.argv[1]]
runpy.run_path('backend/ml/fetch_assets.py', run_name='__main__')
PY
"$model_python" backend/test/ios-benchmark-public.py --assets "$private_directory/assets" --output "$private_directory/public-sources"
"$model_python" - "$private_directory/public-sources/sources.json" <<'PY'
import json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text())
Path('client-ios/build/benchmark/encoder-preparation.json').write_text(json.dumps(m,indent=2)+'\n')
PY
"$model_python" - "$private_directory/nonce" <<'PY'
import os, secrets, sys
value = 'bench-' + secrets.token_hex(32)
with open(os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:
    stream.write(value)
# GitHub masks the nonce if XCTest happens to include launch metadata in logs.
print('::add-mask::' + value)
PY
node backend/test/ios-benchmark.mjs --source "$private_directory/public-sources" --python "$model_python" \
  --assets "$private_directory/assets" --token-file "$private_directory/nonce" --count 300 --ttl-seconds 3600 \
  > "$private_directory/service.log" 2>&1 &
benchmark_pid=$!
ready=0
for attempt in {1..190}; do
  if [[ -s "$private_directory/service.log" ]]; then
    if "$model_python" - "$private_directory/service.log" "$private_directory/config" <<'PY'
import json,sys
from pathlib import Path
for line in Path(sys.argv[1]).read_text().splitlines():
    value=json.loads(line)
    if value.get('ready'):
        Path(sys.argv[2]).write_text(json.dumps(value))
        raise SystemExit(0)
raise SystemExit(1)
PY
    then ready=1; break; fi
  fi
  kill -0 "$benchmark_pid" 2>/dev/null || { echo 'Isolated benchmark failed before readiness.' >&2; exit 1; }
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'Bounded benchmark readiness expired.' >&2; exit 1; }
export SAINT_LOOK_BENCHMARK_TOKEN="$(cat "$private_directory/nonce")"
export SAINT_LOOK_BENCHMARK_ORIGIN="$("$model_python" -c 'import json,sys;print(json.load(open(sys.argv[1]))["origin"])' "$private_directory/config")"
export SAINT_LOOK_BENCHMARK_MANIFEST_SHA256="$("$model_python" -c 'import json,sys;print(json.load(open(sys.argv[1]))["manifestSHA256"])' "$private_directory/config")"
export SAINT_LOOK_BENCHMARK_REVISION="$(git rev-parse HEAD)"
"$model_python" - "$private_directory/config" client-ios/build/benchmark/disk.json <<'PY'
import json,shutil,sys
from pathlib import Path
config=json.loads(Path(sys.argv[1]).read_text())
Path('client-ios/build/benchmark/startup.json').write_text(json.dumps({k:config[k] for k in ['count','uniqueSources','modelSpaceID','benchmarkRevision','startupMilliseconds']},indent=2)+'\n')
p=Path(sys.argv[2]);v=json.loads(p.read_text());v['afterAssetsAndSourcesFreeBytes']=shutil.disk_usage('/tmp').free;p.write_text(json.dumps(v,indent=2)+'\n')
PY
SAINT_LOOK_UI_TEST_ONLY=SaintLookUITests/OutfitFlowTests/testCachedRealBenchmarkFirstObservedResult \
  bash client-ios/scripts/test-simulator.sh
"$model_python" - client-ios/build/benchmark/disk.json <<'PY'
import json,shutil,sys
from pathlib import Path
p=Path(sys.argv[1]);v=json.loads(p.read_text());v['afterCatalogFreeBytes']=shutil.disk_usage('/tmp').free;p.write_text(json.dumps(v,indent=2)+'\n')
PY
kill -TERM "$benchmark_pid"
wait "$benchmark_pid"
benchmark_pid=''
