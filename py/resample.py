"""Build H4 bars from H1 (UTC-aligned 00/04/08/12/16/20).  python py/resample.py
Reads data/broker_h1/*.csv, writes data/broker_h4/*.csv (same columns)."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stratlab as lab  # noqa: E402


def main():
    src, dst = os.path.join(lab.ROOT, lab.DATA_DIRS['H1']), os.path.join(lab.ROOT, lab.DATA_DIRS['H4'])
    os.makedirs(dst, exist_ok=True)
    for fn in sorted(os.listdir(src)):
        if not fn.endswith('.csv'):
            continue
        t, o, h, l, c = lab._read_csv(os.path.join(src, fn))
        b = t // 14400
        st = np.r_[0, np.flatnonzero(b[1:] != b[:-1]) + 1]
        en = np.r_[st[1:] - 1, len(t) - 1]
        ts = (b[st] * 14400).astype('datetime64[s]').astype(str)
        with open(os.path.join(dst, fn), 'w') as f:
            f.write('date,open,high,low,close\n')
            for k in range(len(st)):
                f.write(f'{ts[k]},{o[st[k]]},{np.max(h[st[k]:en[k]+1])},{np.min(l[st[k]:en[k]+1])},{c[en[k]]}\n')
        print(fn, len(st), 'H4 bars')


if __name__ == '__main__':
    main()
