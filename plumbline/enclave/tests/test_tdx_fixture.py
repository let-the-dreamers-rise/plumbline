"""tdxq.py against the real H200-host TDX quote, and the mock-dstack quote shim the enclave tests use."""
from _mocks import *
import tdxq

m = tdxq.verify_quote(TDX_QUOTE)
check(m['report_data'] == TDX_REPORT_DATA.hex(), 'fixture quote verifies to Intel root; report_data == report_data.bin')
check(tdxq.replay_rtmr3('[]')[0] == m['rtmr'][3], 'fixture RTMR3 is zero, so an empty event log replays to it')
for pos, what in ((60, 'TD report'), (48 + 520 + 3, 'report_data'), (48 + 584 + 10, 'quote signature')):
    bad = bytearray(TDX_QUOTE); bad[pos] ^= 1
    rejects(lambda: tdxq.verify_quote(bytes(bad)), f'flipped bit in {what}')
install_fake_dstack()
from dstack_sdk import DstackClient
q = bytes.fromhex(DstackClient().get_quote(b'\x11' * 32).quote)
check(tdxq.verify_quote(q)['report_data'] == TDX_REPORT_DATA.hex(), 'mock quote = real signed bytes; unshimmed report_data is still the fixture value')
with quote_shim():
    check(tdxq.verify_quote(q)['report_data'][:64] == '11' * 32, 'shim substitutes the requested report_data after real verification')
    bad = bytearray(q); bad[60] ^= 1
    rejects(lambda: tdxq.verify_quote(bytes(bad)), 'shim still runs the real signature checks')
print('PASS test_tdx_fixture')
