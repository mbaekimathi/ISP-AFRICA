"""Loads KEY=VALUE pairs from a .env file into os.environ.

Existing environment variables always win, so a real deployment can override
the file. The file is searched next to this module and then in the parent
folder; ISP_ENV_FILE points at an explicit path when set.
"""

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _parse(line):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    if line.startswith("export "):
        line = line[7:].lstrip()
    name, _, value = line.partition("=")
    name = name.strip()
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    if not name or any(character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_" for character in name):
        return None
    return name, value


def _candidates():
    explicit = os.environ.get("ISP_ENV_FILE", "").strip()
    if explicit:
        yield Path(explicit)
    yield HERE / ".env"
    yield HERE.parent / ".env"


def load():
    seen = set()
    for candidate in _candidates():
        try:
            path = candidate.resolve()
        except OSError:
            continue
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                parsed = _parse(line)
                if parsed:
                    name, value = parsed
                    os.environ.setdefault(name, value)
        except OSError:
            continue
