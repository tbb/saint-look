"""Explicit build-time download of public pinned weights; runtime never downloads."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


def fetch(destination):
    manifest = json.loads(Path(__file__).with_name('assets.json').read_text())
    for name, entry in manifest.items():
        target = destination / name
        if target.exists():
            with target.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() == entry['sha256']:
                    continue
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(target.suffix + '.partial')
        urllib.request.urlretrieve(entry['url'], partial)
        with partial.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != entry['sha256']:
                partial.unlink()
                raise ValueError('asset_checksum_mismatch: ' + name)
        partial.replace(target)
        print(name, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', type=Path)
    fetch(parser.parse_args().destination)
