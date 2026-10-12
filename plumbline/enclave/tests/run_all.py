"""python tests/run_all.py  -- runs every tests/test_*.py in its own process (each sets its own env/mocks)."""
import os, sys, glob, subprocess
here = os.path.dirname(os.path.abspath(__file__))
failed = []
for t in sorted(glob.glob(os.path.join(here, 'test_*.py'))):
    print(f'=== {os.path.basename(t)}', flush=True)
    if subprocess.run([sys.executable, t], cwd=here).returncode != 0:
        failed.append(os.path.basename(t))
print('ALL PASS' if not failed else f'FAILED: {failed}')
sys.exit(1 if failed else 0)
