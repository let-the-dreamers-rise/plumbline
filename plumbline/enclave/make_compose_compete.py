"""Builds docker-compose.compete.yml, which embeds enclave/server.py verbatim (as a heredoc, like
make_compose_board.py). The limits are set as plain environment entries in the compose itself, so the measured
compose (dstack app-compose hash, replayed into RTMR3) covers the code that sees the test set and every limit
it enforces. Image and pip pins are the same as the board's docker-compose.board.yml."""
import sys, hashlib, pathlib
here = pathlib.Path(__file__).parent

IMAGE = 'python:3.11.10-slim'  # same image line as docker-compose.board.yml
# Limits, measured with the compose. Changing one changes the compose hash.
ENV = [
    ('ALLOWED_HOSTS', 'huggingface.co'),
    ('REDIRECT_SUFFIXES', 'huggingface.co,hf.co'),
    ('MAX_WEIGHTS_BYTES', '20000000000'),
    ('MAX_AUX_BYTES', '64000000'),
    ('MAX_SHARDS', '64'),
    ('MAX_BODY_BYTES', '16000000'),
    ('SOCKET_TIMEOUT_S', '60'),
    ('DOWNLOAD_TIMEOUT_S', '10800'),
    ('EVAL_TIMEOUT_S', '14400'),
    ('MAX_REDIRECTS', '5'),
    ('WORK_DIR', '/weights'),
    ('HF_HUB_OFFLINE', '1'),
    ('TRANSFORMERS_OFFLINE', '1'),
    ('PYTHONUNBUFFERED', '1'),
]


def indent(text):
    return ''.join('        ' + l if l.strip() else '\n' for l in text.splitlines(True))


def build(code, env=ENV):
    assert '$' not in code, 'server.py must not contain $ (docker compose interpolation)'
    assert 'TESSERA_EOF' not in code
    envs = ''.join(f'      - {k}={v}\n' for k, v in env)
    return f"""services:
  tessera:
    image: {IMAGE}
    ports:
      - "8080:8080"
    volumes:
      - /var/run/dstack.sock:/var/run/dstack.sock
    environment:
{envs}    restart: "no"
    command:
      - sh
      - -c
      - |
        set -e
        pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu
        pip install --no-cache-dir transformers==4.46.3 pynacl==1.5.0 dstack-sdk
        cat > /server.py <<'TESSERA_EOF'
{indent(code)}        TESSERA_EOF
        python /server.py
"""


if __name__ == '__main__':
    code = (here / 'enclave' / 'server.py').read_text()
    compose = build(code)
    (here / 'docker-compose.compete.yml').write_text(compose)
    print('docker-compose.compete.yml written')
    print('  sha256(docker-compose.compete.yml)', hashlib.sha256(compose.encode()).hexdigest())
    print('  sha256(enclave/server.py)         ', hashlib.sha256(code.encode()).hexdigest())
