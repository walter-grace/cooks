"""Jev design critique of the web app from a design-audit run.

Usage: ~/Bids/.venv/bin/python scripts/qa/jev_design_review.py <audit-dir> [--diff <other audit-dir>]

One TypeSafe call: every page screenshot plus its measured metrics go in the state once; Jev answers a
Score per page (polish, spacing, figures), a set of yes/no checks across the whole app, and three choices
(weakest page, best single change, ship verdict). Writes <audit-dir>/jev.json so two runs can be diffed.
The API key is read from ~/.typesafe-api-key and never printed.
"""
import io
import json
import os
import sys
from pathlib import Path

from PIL import Image as PilImage
from typesafe_sdk import Choice, Image, Noul, Score, TypeSafeClient

PAGES = [
    'tasks', 'prospects', 'prospect-detail', 'sequences', 'sequence-detail', 'emails', 'inbox', 'signals',
    'calls', 'call-detail', 'dialer', 'practice', 'settings-mailboxes', 'settings-dialer', 'settings-api',
    'phone-tasks', 'phone-settings', 'dark-tasks',
]
POLISH = ['unacceptable: broken layout or unreadable', 'rough: works but visibly unfinished', 'acceptable: ordinary SaaS quality',
          'polished: consistent, nothing distracts', 'immaculate: every element placed with intent']
SPACING = ['chaotic: gaps and paddings vary at random', 'uneven: several misaligned edges or odd gaps', 'mostly on a scale, one or two slips',
           'consistent rhythm, edges align', 'immaculate: one spacing scale, every edge shared']
FIGURES = ['wrong: numbers mis-formatted or misaligned', 'inconsistent units or alignment', 'readable, minor inconsistencies',
           'right-aligned, tabular, consistent units', 'immaculate: every figure formatted and aligned']


def shot(path: Path) -> Image:
    im = PilImage.open(path).convert('RGB')
    im.thumbnail((1536, 1536))
    if min(im.size) < 256:
        im = im.resize((max(256, im.width), max(256, im.height)))
    buf = io.BytesIO()
    im.save(buf, format='PNG', optimize=True)
    return Image(buf.getvalue())


def summary(m: dict) -> dict:
    keys = ['hueTotal', 'fontSizes', 'contrastFailCount', 'smallTargetCount', 'clippedCount', 'offScaleCount', 'numericLeftCount', 'h1Count', 'headingSkips', 'pageOverflowX', 'gaps']
    return {k: m[k] for k in keys if k in m}


def main() -> None:
    args = sys.argv[1:]
    diff = None
    if '--diff' in args:
        i = args.index('--diff')
        diff = Path(args[i + 1]) / 'jev.json'
        del args[i:i + 2]
    out = Path(args[0])
    audit = json.loads((out / 'audit.json').read_text())
    key = Path(os.path.expanduser('~/.typesafe-api-key')).read_text().strip()
    client = TypeSafeClient(api_key=key, timeout=120, headers={'TypeSafe-Danger-Zone-Images': 'true', 'TypeSafe-Danger-Zone-Long-Context': 'true'})

    pages = {}
    for pid in PAGES:
        png = out / f'{pid}.png'
        if not png.exists() or pid not in audit:
            continue
        pages[pid] = {'screenshot': shot(png), 'metrics': summary(audit[pid])}
    state = {
        'brief': (
            'Cooks is a self-hosted sales engagement app (tasks, prospects, sequences, emails, inbox, buying signals, calls, a parallel '
            'power dialer, practice calls against an AI prospect, settings). It was just restyled to a strict black-and-white palette: '
            'no hue anywhere, state carried by weight (filled, soft, outlined, quiet pills). You are a senior front-end engineer reviewing '
            'the result for spacing, alignment, typography, number formatting and overall polish. Each page has a screenshot (1360x900 '
            'desktop, phone-* are 390 wide, dark-* is the dark scheme) and measured metrics from a Playwright audit: hueTotal counts '
            'coloured computed styles, gaps are vertical gaps between sibling blocks in px, contrastFailCount is WCAG AA failures, '
            'numericLeftCount is numeric table cells not right-aligned.'
        ),
        'pages': pages,
    }

    q = {}
    for pid in pages:
        q[f'polish:{pid}'] = Score(instructions=f'Overall visual polish of pages.{pid} (screenshot + metrics).', criteria=POLISH)
        q[f'spacing:{pid}'] = Score(instructions=f'Spacing, padding and alignment discipline of pages.{pid}.', criteria=SPACING)
    for pid in ['tasks', 'sequence-detail', 'calls', 'call-detail', 'settings-dialer', 'signals']:
        if pid in pages:
            q[f'figures:{pid}'] = Score(instructions=f'Formatting and alignment of numbers, dates, money and durations on pages.{pid}.', criteria=FIGURES)
    nouls = {
        'hue_visible': 'Across all screenshots, is any colour other than black, white or grey visible (ignore photos)?',
        'text_clipped': 'Is any text visibly cut off, overlapping or wrapping badly in any screenshot?',
        'pills_readable': 'Are the state pills (active, answered, canceled, voicemail, high, normal) distinguishable from each other without colour?',
        'hierarchy_clear': 'On every page, is the primary action obvious and the heading hierarchy clear within two seconds?',
        'dates_consistent': 'Are dates and times written the same way on every page?',
        'tables_tidy': 'Do table columns share consistent alignment, with numbers right-aligned and text left-aligned?',
        'dialer_belongs': 'Does the dark power-dialer page feel like part of the same product as the light pages?',
        'phone_usable': 'Are the phone screenshots usable: nothing overflowing, tap targets large enough, nav reachable?',
        'empty_states_designed': 'Do empty states (Nothing here yet, No calls yet, None yet) look intentional rather than missing content?',
        'too_many_borders': 'Do the pages feel over-boxed, with too many nested borders and cards?',
        'dark_mode_balanced': 'Does the dark screenshot have balanced contrast, neither muddy nor glaring?',
        'ready_to_ship': 'Would a design-conscious founder be happy to ship this UI today?',
    }
    for k, v in nouls.items():
        q[k] = Noul(instructions=v, criteria={'true': 'yes', 'false': 'no'})
    q['weakest_page'] = Choice(instructions='Which page most needs work?', criteria={pid: None for pid in pages})
    q['best_change'] = Choice(
        instructions='Which single change would most improve the app?',
        criteria={
            'tighter_tables': 'tighter row heights and column widths in the list tables',
            'fewer_cards': 'merge nested cards into flat sections with dividers',
            'stronger_type_scale': 'more contrast between heading, body and caption sizes',
            'better_empty_states': 'illustrated or instructive empty states',
            'phone_layout': 'a dedicated phone layout for tables and nav',
            'dialer_restraint': 'quieter dialer console, fewer glows and labels',
            'nothing_major': 'no single change stands out; polish is even',
        },
    )
    q['verdict'] = Choice(instructions='Ship verdict for the monochrome restyle.', criteria={'ship': 'ship as is', 'polish': 'ship after small fixes', 'rework': 'needs a real pass'})

    r = client.system_one(state, q)
    answers = r.answers
    res = {'model': r.model, 'usage': {'input': r.usage.input_tokens, 'output': r.usage.output_tokens}, 'scores': {}, 'nouls': {}, 'choices': {}}
    for name, a in answers.items():
        if a.type == 'score':
            res['scores'][name] = {'score': round(a.score, 2), 'conf': round(a.confidence, 2)}
        elif a.type == 'noul':
            res['nouls'][name] = round(a.noul, 2)
        else:
            res['choices'][name] = {'choice': a.choice, 'conf': round(a.confidence, 2), 'top': sorted(a.probabilities.items(), key=lambda kv: -kv[1])[:3]}
    (out / 'jev.json').write_text(json.dumps(res, indent=2))

    prev = json.loads(diff.read_text()) if diff and diff.exists() else None
    print(f"model {res['model']}  tokens in {res['usage']['input']} out {res['usage']['output']}")
    print(f"{'page':20} {'polish':>8} {'spacing':>8} {'figures':>8}" + ('   (before → after)' if prev else ''))
    for pid in pages:
        row = f'{pid:20}'
        for kind in ['polish', 'spacing', 'figures']:
            s = res['scores'].get(f'{kind}:{pid}')
            if not s:
                row += f"{'':>8}"
                continue
            cell = f"{s['score']:.2f}"
            if prev and (p := prev['scores'].get(f'{kind}:{pid}')):
                cell = f"{p['score']:.2f}→{s['score']:.2f}"
            row += f'{cell:>12}' if prev else f'{cell:>8}'
        print(row)
    print('\nchecks (probability of yes)')
    for k, v in res['nouls'].items():
        before = f"  (was {prev['nouls'][k]:.2f})" if prev and k in prev['nouls'] else ''
        print(f'  {k:24} {v:.2f}{before}')
    print('\nchoices')
    for k, v in res['choices'].items():
        print(f"  {k:14} {v['choice']}  conf {v['conf']}  top {[(a, round(b, 2)) for a, b in v['top']]}")


if __name__ == '__main__':
    main()
