"""Public, model-independent representation envelope and pinned adapter identity."""
import hashlib
import json
import math
import re

MODEL_REVISION = '7eaf8d92beb709db20498614b1bc04e43f08136a'
LABSE_REVISION = '836121a0533e5664b21c7aacc5d22951f2b8b25b'
DESCRIPTOR = {
    'model': 'fkuyumcu/OutfitTransformer-labse',
    'modelRevision': MODEL_REVISION,
    'headSHA256': 'bb5aad51daa663bc45c489d9711b69661ed75009df267c79be380df4b8614823',
    'imageEncoder': 'torchvision/resnet18/IMAGENET1K_V1',
    'imageEncoderSHA256': 'f37072fd47e89c5e827621c5baffa7500819f7896bbacec160b1a16c560e07ec',
    'textEncoder': 'sentence-transformers/LaBSE',
    'textEncoderRevision': LABSE_REVISION,
    'textEncoderSHA256': '77d8e1f2dbab6eb5d3c261ce9d3dbf1e3c69e02938c95f934f94f42c22dfa31f',
    'textOutput': 'BertModel.pooler_output (no SentenceTransformer dense layer)',
    'preprocessing': 'exif-transpose-rgb-resize224-bilinear-imagenet-v1',
    'textFormat': 'type-id-spaces-colors-sorted-v1',
    'precision': 'float32',
    'runtime': 'torch2.6.0-torchvision0.21.0-transformers4.49.0-pillow11.1.0',
    'dimensions': 128,
    'itemNormalization': 'none',
    'queryNormalization': 'l2',
    'metric': 'cosine (published README inference example)',
}
SPACE_ID = hashlib.sha256(json.dumps(DESCRIPTOR, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def canonical_text(item_type, colors):
    if not isinstance(item_type, str) or not re.fullmatch(r'[a-z][a-z_]{0,63}', item_type):
        raise ValueError('invalid_type')
    if not isinstance(colors, list) or not colors or len(colors) > 20:
        raise ValueError('invalid_colors')
    if any(not isinstance(c, str) or not re.fullmatch(r'[a-z][a-z_]{0,63}', c) for c in colors):
        raise ValueError('invalid_colors')
    return item_type.replace('_', ' ') + '. Colors: ' + ', '.join(sorted(set(colors))) + '.'


def validate_representation(item):
    if not isinstance(item, dict) or item.get('schemaVersion') != 1 or item.get('spaceID') != SPACE_ID:
        raise ValueError('incompatible_representation')
    if not isinstance(item.get('photoVersionID'), str) or not item['photoVersionID']:
        raise ValueError('invalid_photo_version')
    for key in ('sourceSHA256', 'textSHA256'):
        if not isinstance(item.get(key), str) or not re.fullmatch('[0-9a-f]{64}', item[key]):
            raise ValueError('invalid_input_digest')
    v = item.get('vector')
    if not isinstance(v, list) or len(v) != 128:
        raise ValueError('invalid_vector')
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in v):
        raise ValueError('invalid_vector')
    norm = sum(x*x for x in v)
    if not math.isfinite(norm) or norm < 1e-12 or norm > 1e12:
        raise ValueError('invalid_vector_norm')
    return v


def representation(vector, photo_version_id, source_sha256, text):
    item = {'schemaVersion': 1, 'spaceID': SPACE_ID, 'photoVersionID': photo_version_id,
            'sourceSHA256': source_sha256, 'textSHA256': hashlib.sha256(text.encode()).hexdigest(),
            'vector': vector}
    validate_representation(item)
    return item
