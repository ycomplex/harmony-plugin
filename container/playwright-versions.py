#!/usr/bin/env python3
"""Bounded, dependency-free Playwright discovery; stdout commits only on success.

This is deliberately not a general YAML reader. Only scalar workspace lists and
pnpm's generated package keys are understood. The shell owns root-only fallback.
"""
import glob
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys

MAX_FILES = 256
MAX_BYTES = 16 * 1024 * 1024
SECONDS = 3
VERSION = r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"
FAMILY = ("playwright-core", "playwright", "@playwright/test")


class DiscoveryError(Exception):
    pass


def scalar(value):
    value = value.strip()
    if value.startswith('"'):
        result = json.loads(value)
    elif value.startswith("'") and value.endswith("'"):
        result = value[1:-1].replace("''", "'")
    else:
        result = value
        if not result or result[0] in '&*!{|>' or ': ' in result:
            raise DiscoveryError('unsupported YAML scalar')
    if not isinstance(result, str):
        raise DiscoveryError('workspace pattern must be a string')
    return result


def uncomment(line):
    # A # inside quotes or a glob is data, not a YAML comment.
    quote = None
    escaped = False
    for i, char in enumerate(line):
        if escaped:
            escaped = False
        elif char == '\\' and quote == '"':
            escaped = True
        elif quote:
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == '#' and (i == 0 or line[i - 1].isspace()):
            return line[:i].rstrip()
    if quote:
        raise DiscoveryError('unterminated YAML quote')
    return line.rstrip()


def workspace_yaml(text):
    result = []
    active = False
    for raw in text.splitlines():
        line = uncomment(raw)
        if not line.strip():
            continue
        if line.startswith('packages:'):
            if active or result:
                raise DiscoveryError('duplicate packages list')
            tail = line[len('packages:'):].strip()
            if tail:
                if not (tail.startswith('[') and tail.endswith(']')):
                    raise DiscoveryError('unsupported packages list')
                # Split commas outside quotes (glob character classes may contain commas).
                parts = re.findall(r'''"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,]+''', tail[1:-1])
                return [scalar(x) for x in parts]
            active = True
        elif active:
            if not line[0].isspace() and not line.startswith('- '):
                break
            match = re.fullmatch(r'\s*-\s+(.+)', line)
            if not match:
                raise DiscoveryError('unsupported workspace list item')
            result.append(scalar(match[1]))
    return result


class Discovery:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.files = 0
        self.bytes = 0

    def read(self, path):
        path = Path(path)
        if not path.exists():
            return None
        if not path.resolve().is_relative_to(self.root):
            raise DiscoveryError('path escapes repository')
        if not stat.S_ISREG(path.stat().st_mode):
            raise DiscoveryError('input is not a regular file')
        self.files += 1
        if self.files > MAX_FILES:
            raise DiscoveryError('file-read cap exceeded')
        with path.open('rb') as stream:
            data = stream.read(MAX_BYTES - self.bytes + 1)
        self.bytes += len(data)
        if self.bytes > MAX_BYTES:
            raise DiscoveryError('input-byte cap exceeded')
        return data.decode('utf-8')

    def manifest(self, path):
        text = self.read(path)
        if text is None:
            return {}
        value = json.loads(text)
        if not isinstance(value, dict):
            raise DiscoveryError('manifest is not an object')
        return value

    def run(self):
        root_pkg = self.manifest(self.root / 'package.json')
        patterns = root_pkg.get('workspaces', [])
        if isinstance(patterns, dict):
            patterns = patterns.get('packages', [])
        if not isinstance(patterns, list) or not all(isinstance(x, str) for x in patterns):
            raise DiscoveryError('unsupported workspaces declaration')
        yaml = self.read(self.root / 'pnpm-workspace.yaml')
        patterns = patterns + (workspace_yaml(yaml) if yaml is not None else [])
        included, excluded = set(), set()
        for pattern in patterns:
            negative = pattern.startswith('!')
            pattern = pattern[1:] if negative else pattern
            if os.path.isabs(pattern) or '..' in Path(pattern).parts:
                raise DiscoveryError('workspace pattern escapes repository')
            target = excluded if negative else included
            for path in glob.iglob(str(self.root / pattern), recursive=True):
                candidate = Path(path)
                if any(x in ('node_modules', '.git') for x in candidate.relative_to(self.root).parts):
                    continue
                if not candidate.resolve().is_relative_to(self.root):
                    raise DiscoveryError('workspace symlink escapes repository')
                target.add(candidate)
                if len(included) + len(excluded) > MAX_FILES:
                    raise DiscoveryError('workspace-match cap exceeded')
        packages = [self.root] + sorted(included - excluded - {self.root})
        active = False
        versions = set()
        for directory in packages:
            pkg = root_pkg if directory == self.root else self.manifest(directory / 'package.json')
            declares = any(name in (pkg.get(field) or {}) for field in ('dependencies', 'devDependencies') for name in FAMILY[1:])
            if not declares:
                continue
            active = True
            # Resolve local then hoisted installations, never above this repository.
            for name in FAMILY:
                parent = directory
                while True:
                    installed = self.manifest(parent / 'node_modules' / name / 'package.json')
                    version = installed.get('version', '')
                    if re.fullmatch(VERSION, str(version)):
                        versions.add(version)
                        break
                    if parent == self.root:
                        break
                    parent = parent.parent
        lock = self.manifest(self.root / 'package-lock.json')
        records = lock.get('packages', {})
        if not isinstance(records, dict):
            raise DiscoveryError('unsupported npm lock packages')
        for key, value in records.items():
            if not isinstance(value, dict):
                raise DiscoveryError('invalid npm lock package')
            name = next((x for x in FAMILY if key.endswith('node_modules/' + x)), None)
            if name:
                active = active or name == '@playwright/test'
                version = value.get('version', '')
                if re.fullmatch(VERSION, str(version)):
                    versions.add(version)
        pnpm = self.read(self.root / 'pnpm-lock.yaml')
        section = None
        for raw in (pnpm or '').splitlines():
            line = uncomment(raw)
            if line and not line[0].isspace():
                section = line[:-1] if line.endswith(':') else None
            if section not in ('packages', 'snapshots'):
                continue
            match = re.fullmatch(r'  ([^ ].*):\s*(?:\{\})?', line)
            if not match:
                continue
            key = scalar(match[1])
            for name in FAMILY:
                locked = re.fullmatch(r'/?' + re.escape(name) + r'(?:@|/)(' + VERSION + r')(?:\([^\n]*\))?', key)
                if locked:
                    active = active or name == '@playwright/test'
                    versions.add(locked[1])
        if active and not versions:
            raise DiscoveryError('Playwright version could not be resolved')
        return sorted(versions) if active else []


def timeout(_signum, _frame):
    raise DiscoveryError('3-second discovery deadline exceeded')


if __name__ == '__main__':
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(SECONDS)
    try:
        result = Discovery(sys.argv[1]).run()
        # No partial stdout can survive a timeout or parse failure.
        signal.alarm(0)
        print('\n'.join(result))
    except Exception as error:
        print(str(error).replace('\n', ' ')[:200], file=sys.stderr)
        sys.exit(1)
