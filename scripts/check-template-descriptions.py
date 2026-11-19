#!/usr/bin/env python3
"""Fail if any CloudFormation template's `Description` exceeds 1024 characters.

CloudFormation rejects such a template outright — "Template format error:
'Description' length is greater than 1024" — but only when the changeset is
created. `sam validate` and `sam build` both pass it, so without this check
the first sign of trouble is a failed prod deploy.

Long prose belongs in `#` comments, which CloudFormation never parses.

Usage: check-template-descriptions.py <dir-or-file>...
"""

import sys
from pathlib import Path

import yaml

LIMIT = 1024
SKIP_DIRS = {'.aws-sam', 'node_modules', '.open-next', '.next', '.git'}


class CfnLoader(yaml.SafeLoader):
    """SafeLoader that tolerates CFN short tags (`!Ref`, `!GetAtt`, `!Sub`…).

    Subclassing SafeLoader is deliberate and load-bearing: `yaml.load` with
    this loader cannot construct arbitrary Python (`!!python/object` stays
    unresolvable), while plain `yaml.safe_load` cannot be used at all here —
    it raises on the `!Ref`/`!GetAtt` tags every CFN template contains. The
    multi-constructor below discards tagged nodes; this script only ever
    reads the plain-string `Description`.

    A real YAML load rather than line-scanning, because SAM rewrites folded
    block scalars into double-quoted ones with escaped newlines when it
    builds — a line-based reader sees only the first physical line of those
    and reports a passing length for a template that in fact fails.
    """


CfnLoader.add_multi_constructor('!', lambda loader, suffix, node: None)


def iter_templates(args: list[str]):
    for arg in args:
        p = Path(arg)
        if p.is_dir():
            # Skipping applies to *traversal* only: build output under
            # .aws-sam is a copy of sources already checked. A file named
            # explicitly is always checked, so the artifact CFN actually
            # rejected can be re-run through this script by hand.
            for path in sorted(p.rglob('*.yaml')):
                if SKIP_DIRS & set(path.parts):
                    continue
                if 'AWSTemplateFormatVersion' in path.read_text():
                    yield path
        else:
            yield p


def main(argv: list[str]) -> int:
    failed = False
    checked = 0

    for path in iter_templates(argv or ['.']):
        checked += 1
        doc = yaml.load(path.read_text(), Loader=CfnLoader) or {}
        n = len(doc.get('Description') or '')
        if n > LIMIT:
            print(
                f'::error file={path}::Description is {n} characters, over '
                f'CloudFormation\'s limit of {LIMIT}. Move the prose into '
                f'# comments above it — CFN never parses those.'
            )
            failed = True
        else:
            print(f'ok  {n:>5}/{LIMIT}  {path}')

    if not checked:
        print('::error::no CloudFormation templates found — check the path')
        return 1
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
