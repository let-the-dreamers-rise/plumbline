# Plumbline enclave: competition mode

This is the enclave behind a Plumbline bounty. It runs in an Intel TDX CVM on Phala Cloud (dstack). It scores **any entrant's model** on a sealed test suite and returns a `tessera-score-1` statement with one extra field, `payout`, bound into a TDX quote. It started as a copy of `sealed-eval-board`, which is not edited. The protocol is unchanged: `tessera:keyrelease:v1`, `tessera:score:v1`, `v = tessera-score-1`, and the same `report_data` formula. See `../SPEC.md`.

## What changed from the board
- **There is no pinned model list.** `POST /enter` names a model by `(model_id, revision, weights[{file or url, sha256}])`. Hard limits apply, and they are part of the measured compose (see Limits below).
- **The statement is the board's 11 fields plus `payout`.** `payout` is 64 lowercase hex chars: the 32 raw bytes of the entrant's Solana pubkey.
  - `report_data = sha256("tessera:score:v1" || canonical(statement))`, as before, so the payout is covered by the quote.
  - The enclave rejects a missing, malformed or all-zero payout before it fetches anything.
- **`weights_sha256` is computed exactly as the board computes it.** For one shard it is that shard's sha256. For several, it is the sha256 of the manifest `"<sha256>  <file>\n"` per shard, in the order given. A test checks the function against the board's source and against every digest in the board's `models.json`.
- **`/evaluate` and `/load` are removed. `/health` and `/attest` are kept.**
- **Weights are fetched with the enclave's own HTTPS client, not `snapshot_download`.** Every hop is host-checked and every byte is counted and hashed. Only the requested `*.safetensors` files and a fixed list of small config/tokenizer files land on disk. A shard is never loaded unless its sha256 equals the pin.
- **The model is loaded with `trust_remote_code=False`, `use_safetensors=True` and `local_files_only=True`.**
  - Before any weights are downloaded, the enclave refuses a `config.json` or `tokenizer_config.json` that has `auto_map`.
  - It also refuses a `quantization_config`, or a `model_type`/`architectures` pair that is not on the allowlist.
  - After loading, it checks the loaded class too.
- **The suite is decrypted only after the weights are verified and loaded, and it never leaves `evaluate()`.** Errors before decryption are returned with a reason, which only ever holds entrant data and hashes. Any error after decryption returns only the exception type name. Suite contents are never logged or returned.
- **One entry at a time.** A concurrent `/enter` gets `409`. The weights are deleted after every entry, whether it succeeds or fails.

## Endpoints
- `GET /health` returns `{ready, error, mode: "competition", busy, stage, last_error, entries, limits, limits_sha256, enclave_pubkey}`.
- `GET /attest?challenge=<64 hex>` returns `{enclave_pubkey, challenge, report_data, quote, event_log, mode, limits_sha256, ready}`, where `report_data = sha256("tessera:keyrelease:v1" || pk || challenge)`. This is the sponsor's key release.
- `POST /enter` takes this body:
  ```json
  {"challenge": "<64 hex: the challenge of the sponsor's key release>",
   "sealed": "<base64 crypto_box_seal(suite json) to enclave_pubkey>",
   "model_id": "org/name", "revision": "<40-hex commit>",
   "weights": [{"file": "model.safetensors", "sha256": "<64 hex>", "size": 123}],
   "payout": "<64 lowercase hex = 32-byte Solana pubkey>",
   "dtype": "bfloat16", "weights_sha256": "<optional; must equal the computed digest>"}
  ```
  - Each weight item has either `file`, a path in `model_id@revision` on huggingface.co, or `url`, a full https URL on an allowed host. `size` is optional; if you give it, the enclave enforces it.
  - The board's `shards` key is accepted in place of `weights`.
  - `dtype` is `bfloat16` (the default) or `float32`.
  - A single shard must be named `model.safetensors`.
  - Several shards need `model.safetensors.index.json` at the revision, and its `weight_map` must name exactly the shards in the request.
  - `config.json` and the tokenizer files always come from `model_id@revision`. Like the board, they are pinned by the git revision only, not by sha256.
  - The response is `200 {statement, quote, event_log, report_data}`.
  - Error codes:
    - `400`: bad request, bad payout, or a disallowed host.
    - `409`: busy.
    - `413`: over the size limit.
    - `422`: failed a check (sha256, architecture, remote code, missing config, size mismatch).
    - `502`: the fetch failed.
    - `504`: the download timed out.
    - `500`: an error after decryption (type name only).
    - `503`: the enclave is not ready.

**Bundle.** The entrant combines the sponsor's published key release with the `/enter` response into the sealed-eval bundle format: `{statement, statement_sha256, key_release:{quote,event_log,report_data}, score:{quote,event_log,report_data}, measurements}`. The unchanged `verify_bundle.py` accepts it. For that to work, `/enter` must use the same challenge as the key release.

## Limits (env in the measured compose; changing one changes the compose hash)
| env | default | meaning |
|---|---|---|
| `ALLOWED_HOSTS` | `huggingface.co` | hosts a request URL may name (exact match, https, no port, no userinfo) |
| `REDIRECT_SUFFIXES` | `huggingface.co,hf.co` | a redirect may go only to these hosts or their subdomains (HF's LFS/Xet CDNs) |
| `MAX_WEIGHTS_BYTES` | `20000000000` (20 GB) | total weight bytes. Checked against the declared sizes, then Content-Length, then the streamed count |
| `MAX_AUX_BYTES` | `64000000` | each config/tokenizer file |
| `MAX_SHARDS` | `64` | shards per entry |
| `MAX_BODY_BYTES` | `16000000` | request body |
| `SOCKET_TIMEOUT_S` | `60` | per network read |
| `DOWNLOAD_TIMEOUT_S` | `10800` | the whole fetch for one entry |
| `EVAL_TIMEOUT_S` | `14400` | scoring. Checked between items; past it there is no score and no quote |
| `MAX_REDIRECTS` | `5` | redirect hops per file |

These are not set by env:
- Architecture allowlist, by `model_type` → the one accepted class: `llama`, `mistral`, `qwen2`, `gemma`, `gemma2`, `phi3`, `granite`. All of them are built into the pinned `transformers==4.46.3`.
- dtypes `float32` and `bfloat16`.
- At most 200 suite items.

## Compose hash
- `sha256(docker-compose.compete.yml)` = `eb4eba790a10fdd4b3371932135c404b292fa5046d836ad37bd97ed744e023b8`
- `sha256(enclave/server.py)` = `5bbec0abbd3a0fc39d0e02a6e4314b2a16c7961fc2187b7f804b3a7229cf4361`

`make_compose_compete.py` writes `docker-compose.compete.yml`. It embeds `enclave/server.py` verbatim as a heredoc and puts the limits in `environment`.
- The image line and pip pins are byte-for-byte the board's.
- That means the image is pinned exactly like the board's: by the tag `python:3.11.10-slim`, not by an `@sha256:` digest, and `dstack-sdk` is unpinned, as in the board.
- The dstack compose hash that the registry and bounty pin is `sha256(app-compose.json)`. Phala builds that file at deploy time, so it is known only from the `compose-hash` event of a real deploy, the same as for the board.

## Run on Phala (dstack)
1. Go to cloud.phala.com → Deploy → CPU TEE (Intel TDX) → Custom Configuration. Paste `docker-compose.compete.yml` and deploy.
   - Size the CVM for the largest model you will accept. With the default 20 GB limit, the disk needs about 20 GB of weights plus torch, so give it 40 GB or more.
   - RAM needs about the bf16 weight size plus headroom, and about twice that for `float32`.
   - `tdx.large` (8 GB) only fits models up to roughly 3 GB of bf16 weights. Lower `MAX_WEIGHTS_BYTES` in `make_compose_compete.py` to match the machine; doing so changes the compose hash.
   - Wait until `/health` shows `"ready": true`.
2. Copy the public URL for port 8080 (it looks like `https://<app-id>-8080.<node>.phala.network`).
3. **Sponsor** (on their own machine, with their own `suite.json`): run `python compete_client.py seal <url> --out sealed.json`.
   - This verifies the key-release quote to Intel's root and seals the suite.
   - On later runs, pass `--compose-hash <hex>`.
   - Publish `sealed.json`. It holds no questions or answers.
4. **Entrant:** run `python compete_client.py enter <url> sealed.json --model-id org/name --revision <40 hex> --weights weights.json --payout <64 hex> --out bundle.json`.
5. **Anyone:** run `python verify_compete.py bundle.json [--payout <hex>] [--compose-hash <hex>] [--suite-commitment <hex>]`.
   - This runs the unchanged `verify_bundle.verify`.
   - It then checks that `payout` is present, is 64 lowercase hex and is not all zeros.
   - It prints the payout as hex and as base58.

Tests (no GPU, no network, stub quote): `pip install -r requirements.txt`, then `python tests/run_all.py`. Run them from a filesystem that allows exec, for example a copy under /home.
- `test_compete_e2e.py` covers:
  - payout in the statement and in `report_data`;
  - missing or bad payouts (missing, uppercase, wrong length, base58, all zeros, a number, non-hex) rejected before any download;
  - per-shard sha256 mismatch, including one bad shard of two, and a shard set that differs from the index;
  - disallowed hosts: other host, http, port, userinfo, lookalike, file:, a redirect to a metadata IP, and a redirect loop;
  - oversize, by declared size, Content-Length, streamed count and total across shards;
  - the architecture allowlist, `auto_map` and quantization rejected;
  - `trust_remote_code=False` checked through the real `load_weights`;
  - concurrent `/enter` → 409;
  - decryption only after the weights are ready, and no suite leakage on errors after decryption;
  - the eval timeout;
  - `verify_compete` accepting good bundles and rejecting a swapped payout, a wrong expected payout or compose hash, and a validly quoted statement whose payout is missing or malformed.
- `test_compete_compose.py` checks:
  - the verbatim embed, the measured env, YAML parsing and protocol strings;
  - the env validation at boot;
  - the image and pip pins equal the board's;
  - `weights_digest` equals the board's;
  - the shared verifier files are byte-identical to `sealed-eval-board`.
- `test_tdx_fixture.py` is the board's test, unchanged.

## Untested until a real TDX run
- Nothing here has run on Phala. No real compose hash exists, and the quotes in the tests are the real H200-host fixture with the stub `report_data` substitution from `_mocks.py`.
- **Real HuggingFace fetching is untested.** The tests use a fake HTTPS host.
  - It is not yet confirmed that HF's resolve redirects for LFS and Xet files land only on `*.huggingface.co` or `*.hf.co`. A new CDN host would fail closed with 400 and needs `REDIRECT_SUFFIXES` updated.
  - Gated or private repos are not supported, because no token is used.
- **Real model loading and generation are untested** (torch and transformers are stubbed). That covers:
  - the architecture allowlist against real configs;
  - the chat-template requirement;
  - memory fit on a given CVM;
  - CPU speed, and whether the 4 h eval timeout is enough.
- **A synchronous `/enter` can take hours.** Whether Phala's gateway holds the HTTP connection that long is unknown. The board had the same open question for `/evaluate`. If the client drops, the entry still finishes inside the enclave, but its result is lost. An async job id would be a later change.
- **The enclave key is ephemeral.** A restart means the sponsor must seal again, and a new key release comes with it.
- Everything the board README lists as "not yet" still applies:
  - config and tokenizer files are pinned by revision only;
  - Intel TCB, QE identity and CRL collateral are not checked;
  - there is no GPU variant;
  - the on-chain ZK proof and payout run outside this folder.
- Anyone can call `/enter`, so one entrant can keep the enclave busy (409 for everyone else) for up to the download and eval timeouts. That cannot change anyone's score. Rate limiting or an entry fee is out of scope here.
