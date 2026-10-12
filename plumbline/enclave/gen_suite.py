"""Writes a fresh sealed test suite to suite.json using OS randomness. Run it on your own machine:
nobody else, including whoever wrote this script, ever sees the questions or answers."""
import json, secrets, sys

R = secrets.SystemRandom()
NAMES = ['Asha', 'Ravi', 'Meera', 'Kabir', 'Divya', 'Arjun', 'Neha', 'Vikram', 'Leela', 'Imran']
ITEMS = ['mangoes', 'notebooks', 'bricks', 'tickets', 'bottles', 'kites', 'chairs', 'lamps']


def item():
    n, t = R.choice(NAMES), R.choice(ITEMS)
    k = R.randrange(5)
    a, b, c = R.randint(12, 95), R.randint(3, 9), R.randint(2, 7)
    if k == 0:
        q = f'{n} buys {b} boxes of {t} with {a} {t} in each box, then gives away {c * 4} {t}. How many {t} are left?'
        ans = a * b - c * 4
    elif k == 1:
        p = R.randint(20, 150)
        q = f'A shop sells {t} at {p} rupees each. {n} buys {b} and pays with {(p * b // 500 + 1) * 500} rupees. How much change does {n} get?'
        ans = (p * b // 500 + 1) * 500 - p * b
    elif k == 2:
        q = f'{n} reads {a} pages on Monday, {b} times as many on Tuesday, and {c} fewer than Monday on Wednesday. How many pages in total?'
        ans = a + a * b + (a - c)
    elif k == 3:
        tot = a * b * c
        q = f'{tot} {t} are packed equally into {b} trucks, and each truck splits its load equally among {c} shops. How many {t} does each shop get?'
        ans = a
    else:
        d = R.randint(2, 6)
        q = f'{n} saves {a} rupees a week for {b} weeks, spends {c * 10} rupees, then saves {d} more weeks at the same rate. How many rupees does {n} have?'
        ans = a * b - c * 10 + a * d
    return {'q': q, 'a': str(ans)}


if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    suite = {'suite_id': 'tessera-arith-' + secrets.token_hex(4), 'salt': secrets.token_hex(32),
             'items': [item() for _ in range(n)]}
    json.dump(suite, open('suite.json', 'w'), ensure_ascii=False)
    print(f'wrote suite.json: {suite["suite_id"]}, {n} items (not printed; keep this file private)')
