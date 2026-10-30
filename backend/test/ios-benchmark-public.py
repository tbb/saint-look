"""Four pinned public photos -> four real encoder outputs; never image-provider claims.

Explicit benchmark setup only. Downloads are public; no credentials or paid calls.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.request

IDS = ('light-polo', 'pub-03', 'pub-13', 'black-jeans')
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend/ml'))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def make_illustration(photo, output):
    from PIL import Image
    # Match the actual client artifact contract without changing encoder bytes.
    with Image.open(photo) as original:
        content = original.convert('RGBA')
        content.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
        canvas.alpha_composite(content, ((1024 - content.width) // 2, (1024 - content.height) // 2))
        canvas.save(output, format='PNG')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--public-cache', type=Path)
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    from adapter import OutfitAdapter
    from PIL import Image, ImageOps
    adapter = OutfitAdapter(args.assets, threads=1)
    adapter.verify_assets()
    entries = {item['id']: item for item in json.loads((ROOT / 'docs/research/epic63-public-manifest.json').read_text())['items']}
    records = []
    started = time.monotonic()
    for index, source_id in enumerate(IDS):
        entry = entries[source_id]
        cached = args.public_cache / entry['image'] if args.public_cache else None
        jpeg = args.output / (source_id + '.jpg')
        if cached and cached.is_file():
            data = cached.read_bytes()
            if digest(data) != entry['sha256']:
                raise ValueError('public_cache_digest')
            jpeg.write_bytes(data)
        else:
            request = urllib.request.Request(entry['downloadUrl'], headers={'User-Agent': 'SaintLookPublicBenchmark/1.0 (https://github.com/tbb/saint-look)'})
            with urllib.request.urlopen(request, timeout=90) as response:
                raw = response.read(32 * 1024 * 1024 + 1)
            if len(raw) > 32 * 1024 * 1024 or digest(raw) != entry['sourceSha256']:
                raise ValueError('public_source_digest')
            import io
            with Image.open(io.BytesIO(raw)) as original:
                image = ImageOps.exif_transpose(original).convert('RGB')
                image.thumbnail((1024, 1024), Image.Resampling.LANCZOS if source_id == 'black-jeans' else Image.Resampling.BICUBIC)
                image.save(jpeg, format='JPEG', quality=90)
            if digest(jpeg.read_bytes()) != entry['sha256']:
                raise ValueError('public_transform_digest')
        photo = args.output / (source_id + '.png')
        with Image.open(jpeg) as original:
            ImageOps.exif_transpose(original).convert('RGB').save(photo, format='PNG')
        # Product readiness requires a square RGBA illustration. This remains an
        # explicit image fixture: preserve the public photo and add transparent
        # padding without changing the encoder's original RGB input bytes.
        illustration = args.output / (source_id + '-illustration.png')
        make_illustration(photo, illustration)
        photo_id = 'b4000001-0000-4000-8000-' + str(index + 1).zfill(12)
        before = time.monotonic()
        representation = adapter.prepare(photo, photo_id, entry['type'], entry['colors'])
        representation_bytes = json.dumps(representation, separators=(',', ':'), allow_nan=False).encode()
        representation_file = source_id + '-representation.json'
        (args.output / representation_file).write_bytes(representation_bytes)
        records.append({'id': source_id, 'photoVersionId': photo_id, 'sourceFile': photo.name,
                        'representationFile': representation_file, 'publicJPEGFile': jpeg.name,
                        'illustrationFile': illustration.name, 'illustrationSHA256': digest(illustration.read_bytes()),
                        'sourceSHA256': digest(photo.read_bytes()), 'publicJPEG_SHA256': entry['sha256'],
                        'representationSHA256': digest(representation_bytes),
                        'encoderMilliseconds': (time.monotonic() - before) * 1000})
    manifest = {'schemaVersion': 1, 'sourceProvenance': 'public-manifest-encoder-on-runner',
                'imageProviders': 'synthetic-public-photo-copies', 'items': records,
                'encoderPreparationMilliseconds': (time.monotonic() - started) * 1000,
                'note': 'Four actual encoder calls. Image fixtures are copies of public photographs, not Photoroom or Gemini results. No owner identifiers.'}
    (args.output / 'sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'evidence': 'four-public-real-encoder-sources', 'items': len(records),
                      'sourceBytes': sum(path.stat().st_size for path in args.output.iterdir()),
                      'encoderPreparationMilliseconds': manifest['encoderPreparationMilliseconds'], 'paidProviderCalls': 0}))


if __name__ == '__main__':
    main()
