"""Reproduce the pinned public development photographs; no paid provider calls."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request
from PIL import Image, ImageOps


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(destination):
    manifest = Path(__file__).resolve().parents[2] / 'docs/research/epic63-public-manifest.json'
    dataset = json.loads(manifest.read_text())
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'originals').mkdir(exist_ok=True)
    (destination / 'images').mkdir(exist_ok=True)
    for item in dataset['items']:
        output = destination / item['image']
        if output.exists() and digest(output) == item['sha256']:
            continue
        source = destination / 'originals' / (item['id'] + '.source')
        if not source.exists() or digest(source) != item['sourceSha256']:
            request = urllib.request.Request(item['downloadUrl'], headers={
                'User-Agent': 'SaintLookPublicValidation/1.0 (https://github.com/tbb/saint-look)'})
            with urllib.request.urlopen(request, timeout=90) as response, source.open('wb') as stream:
                shutil.copyfileobj(response, stream)
        if digest(source) != item['sourceSha256']:
            raise ValueError('public_source_changed: ' + item['id'])
        with Image.open(source) as original:
            image = ImageOps.exif_transpose(original)
            if item['id'] in {'olive-cargo', 'black-jeans', 'creepers'}:
                if image.mode in ('RGBA', 'LA') or 'transparency' in image.info:
                    rgba = image.convert('RGBA')
                    background = Image.new('RGBA', rgba.size, (255, 255, 255, 255))
                    image = Image.alpha_composite(background, rgba)
                image = image.convert('RGB')
                image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            else:
                image = image.convert('RGB')
                image.thumbnail((1024, 1024), Image.Resampling.BICUBIC)
            image.save(output, format='JPEG', quality=90)
        if digest(output) != item['sha256']:
            raise ValueError('public_transform_changed: ' + item['id'])
        print(item['id'], flush=True)
    shutil.copyfile(manifest, destination / 'manifest.json')
    reference = destination / 'reference-model.py'
    request = urllib.request.Request('https://huggingface.co/fkuyumcu/OutfitTransformer-labse/resolve/7eaf8d92beb709db20498614b1bc04e43f08136a/model.py')
    with urllib.request.urlopen(request, timeout=90) as response:
        reference.write_bytes(response.read())
    if digest(reference) != 'b03cbf04b5a34625f1f302fdaba469f8b2f9fc70a993bac2adb05e69bee3b492':
        raise ValueError('reference_source_changed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', type=Path)
    fetch(parser.parse_args().destination)
