"""docker-compose.compete.yml embeds enclave/server.py verbatim with the limits in the measured environment,
uses the board's image and pip pins, protocol strings are unchanged, weights_sha256 agrees with the board's
pinned digests, no remote code, and shared verifier files are byte-identical to sealed-eval-board's."""
import re, filecmp, subprocess, tempfile
from _mocks import *

BOARD = '/mnt/project-files/sealed-eval-board'  # read only


def embedded(compose, marker):
    s = open(os.path.join(ROOT, compose)).read()
    body = s.split(f"<<'{marker}'\n", 1)[1].split(f'        {marker}\n', 1)[0]
    return ''.join(l[8:] if l.strip() else l for l in body.splitlines(True))


server_src = open(os.path.join(ROOT, 'enclave', 'server.py')).read()
compose = open(os.path.join(ROOT, 'docker-compose.compete.yml')).read()
check('$' not in server_src, 'server.py has no $')
check(embedded('docker-compose.compete.yml', 'TESSERA_EOF') == server_src, 'compose embeds enclave/server.py verbatim')
sys.path.insert(0, ROOT)
import make_compose_compete as mcc
check(mcc.build(server_src) == compose, 'docker-compose.compete.yml is exactly what make_compose_compete.py builds')
for k, v in mcc.ENV:
    check(f'      - {k}={v}\n' in compose, f'measured env {k}={v}')
check('BOARD_FILE' not in compose and 'models.json' not in compose and 'GPU_ATTESTATION' not in compose, 'no board file, CPU-only')
try:
    import yaml
    y = yaml.safe_load(compose)
    check(y['services']['tessera']['command'][2].count('cat > /') == 1, 'compose parses as YAML')
except ImportError:
    print('  (pyyaml not installed; YAML parse skipped)')

for s in ('tessera:keyrelease:v1', 'tessera:score:v1', "'v': 'tessera-score-1'"):
    check(s in server_src, f'protocol string {s} unchanged')
check('trust_remote_code=True' not in server_src and server_src.count('trust_remote_code=False') == 2, 'trust_remote_code=False on tokenizer and model, never True')
check('snapshot_download' not in server_src and 'use_safetensors=True' in server_src, 'only the requested safetensors files are fetched')

os.environ['WORK_DIR'] = tempfile.mkdtemp()
sys.path.insert(0, os.path.join(ROOT, 'enclave'))
import server
check(server.LIMITS['allowed_hosts'] == ('huggingface.co',) and server.LIMITS['max_weights_bytes'] == 20 * 10 ** 9,
      'defaults: huggingface.co only, 20 GB of weights')
for k, bad in (('MAX_WEIGHTS_BYTES', '0'), ('MAX_WEIGHTS_BYTES', 'lots'), ('ALLOWED_HOSTS', 'http://x'), ('ALLOWED_HOSTS', ' ')):
    r = subprocess.run([sys.executable, '-c', 'import server'], cwd=os.path.join(ROOT, 'enclave'),
                       env=dict(os.environ, **{k: bad}), capture_output=True, text=True)
    check(r.returncode != 0, f'enclave refuses to start with {k}={bad!r}')

if os.path.isdir(BOARD):
    bc = open(os.path.join(BOARD, 'docker-compose.board.yml')).read()
    head = lambda t: [l for l in t.splitlines() if l.strip().startswith(('image:', 'pip install'))]
    check(head(bc) == head(compose), 'same image line and pip pins as docker-compose.board.yml')
    board = json.load(open(os.path.join(BOARD, 'models.json')))
    check(all(server.weights_digest(e['shards']) == e['weights_sha256'] for e in board),
          'weights_sha256 agrees with every pinned digest in the board models.json (1- and 2-shard)')
    bsrc = open(os.path.join(BOARD, 'enclave', 'server.py')).read()
    grab = lambda src: src.split('def weights_digest(shards):', 1)[1].split('\n\n\n', 1)[0].split('"""')[-1]
    check(grab(bsrc) == grab(server_src), 'weights_digest body is the board enclave\'s, character for character')
    for f in ('tdxq.py', 'gpuq.py', 'verify_bundle.py', 'tessera_eval.py', 'gen_suite.py', 'requirements.txt',
              'tests/_mocks.py', 'tests/test_tdx_fixture.py', 'tests/run_all.py'):
        check(filecmp.cmp(os.path.join(ROOT, f), os.path.join(BOARD, f), shallow=False), f'{f} is byte-identical to sealed-eval-board/{f}')
else:
    print('  (sealed-eval-board not mounted; cross-checks skipped)')
print('PASS test_compete_compose')
