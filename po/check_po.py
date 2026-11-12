#!/usr/bin/env python3
"""Check translations against po/resource-bar.pot.

Usage: python3 po/check_po.py po/xx.po [more.po ...]

For each file: every template message is present and translated (no fuzzy),
placeholders (%s, %d) match the source, plural entries have as many forms as
the Plural-Forms header declares. Exit code 1 if any file has problems.
Run `msgfmt --check -o /dev/null file.po` as well.
"""
import re
import sys
from pathlib import Path

POT = Path(__file__).with_name('resource-bar.pot')


def unquote(chunks):
    out = ''.join(chunks)
    return bytes(out, 'utf-8').decode('unicode_escape').encode('latin-1').decode('utf-8')


def parse(path):
    entries = []
    cur = None
    field = None
    fuzzy = False
    for raw in Path(path).read_text(encoding='utf-8').splitlines() + ['']:
        line = raw.strip()
        if not line:
            if cur is not None:
                cur['fuzzy'] = fuzzy
                entries.append(cur)
            cur, field, fuzzy = None, None, False
            continue
        if line.startswith('#,') and 'fuzzy' in line:
            fuzzy = True
        if line.startswith('#'):
            continue
        if cur is None:
            cur = {'ctx': None, 'id': None, 'plural': None, 'str': {}}
        m = re.match(r'^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+"(.*)"$', line)
        if m:
            key, idx, text = m.group(1), m.group(2), m.group(3)
            if key == 'msgctxt':
                field = ('ctx',)
            elif key == 'msgid':
                field = ('id',)
            elif key == 'msgid_plural':
                field = ('plural',)
            else:
                field = ('str', int(idx) if idx is not None else 0)
            buf = [text]
            if field[0] == 'str':
                cur['str'][field[1]] = buf
            else:
                cur[field[0]] = buf
        elif line.startswith('"') and field is not None:
            target = cur['str'][field[1]] if field[0] == 'str' else cur[field[0]]
            target.append(line[1:-1])
    for e in entries:
        for k in ('ctx', 'id', 'plural'):
            if e[k] is not None:
                e[k] = unquote(e[k])
        e['str'] = {i: unquote(v) for i, v in e['str'].items()}
    return entries


def placeholders(s):
    return sorted(re.findall(r'%[sd]', s))


def check(path):
    problems = []
    pot = {(e['ctx'], e['id']): e for e in parse(POT) if e['id']}
    po = parse(path)
    header = next((e for e in po if e['id'] == ''), None)
    nplurals = None
    if header:
        m = re.search(r'nplurals\s*=\s*(\d+)', header['str'].get(0, ''))
        nplurals = int(m.group(1)) if m else None
    if nplurals is None:
        problems.append('missing Plural-Forms header')
    got = {(e['ctx'], e['id']): e for e in po if e['id']}
    for key, src in pot.items():
        e = got.get(key)
        label = f'{key[0] + "|" if key[0] else ""}{key[1]!r}'
        if e is None:
            problems.append(f'missing: {label}')
            continue
        if e['fuzzy']:
            problems.append(f'fuzzy: {label}')
        if src['plural']:
            if nplurals and len(e['str']) != nplurals:
                problems.append(f'{label}: {len(e["str"])} plural forms, header says {nplurals}')
            want = placeholders(src['plural'])
            for i, t in e['str'].items():
                if not t:
                    problems.append(f'untranslated plural form {i}: {label}')
                elif placeholders(t) not in (want, []) or len(placeholders(t)) > len(want):
                    problems.append(f'{label}: placeholders {placeholders(t)} in form {i}, expected {want}')
        else:
            t = e['str'].get(0, '')
            if not t:
                problems.append(f'untranslated: {label}')
            elif placeholders(t) != placeholders(src['id']):
                problems.append(f'{label}: placeholders {placeholders(t)}, expected {placeholders(src["id"])}')
    extra = set(got) - set(pot)
    for key in sorted(extra, key=str):
        problems.append(f'not in template: {key}')
    return problems


def main():
    bad = False
    for path in sys.argv[1:]:
        problems = check(path)
        if problems:
            bad = True
            print(f'{path}: {len(problems)} problem(s)')
            for p in problems:
                print(f'  - {p}')
        else:
            print(f'{path}: OK')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
