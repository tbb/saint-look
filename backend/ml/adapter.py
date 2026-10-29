"""CPU inference adapter. Public methods: prepare, query_target, rank.

No model-generated eligibility or full-outfit score. Runtime is local-only and
fails closed on absent/incompatible weights, representations or non-finite output.
"""
import hashlib
from importlib.metadata import version
import json
from pathlib import Path

import torch
from torch.nn import functional as F

from contract import DESCRIPTOR, SPACE_ID, canonical_text, representation, validate_representation
from head import OutfitTransformerCIR


class OutfitAdapter:
    def __init__(self, assets, threads=2):
        for package, expected in {'torch': '2.6.0', 'torchvision': '0.21.0',
                                  'transformers': '4.49.0', 'Pillow': '11.1.0',
                                  'numpy': '2.2.3', 'safetensors': '0.5.3'}.items():
            if version(package).split('+')[0] != expected:
                raise ValueError('incompatible_runtime')
        torch.set_num_threads(threads)
        self.assets = Path(assets)
        self.verified = set()
        self.manifest = json.loads(Path(__file__).with_name('assets.json').read_text())
        self._verify('pytorch_model.bin')
        self.head = OutfitTransformerCIR()
        self.head.load_state_dict(torch.load(self.assets / 'pytorch_model.bin',
                                            map_location='cpu', weights_only=True), strict=True)
        self.head.eval().requires_grad_(False)
        self.resnet = self.labse = self.tokenizer = self.preprocess = None

    def _verify(self, name):
        if name not in self.verified:
            with (self.assets / name).open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != self.manifest[name]['sha256']:
                    raise ValueError('asset_checksum_mismatch')
            self.verified.add(name)

    def verify_assets(self):
        for name in self.manifest:
            self._verify(name)

    def _load_encoders(self):
        if self.resnet is not None:
            return
        from torchvision import models, transforms
        from transformers import AutoModel, AutoTokenizer
        for name in self.manifest:
            self._verify(name)
        resnet = models.resnet18(weights=None)
        resnet.load_state_dict(torch.load(self.assets / 'resnet18-f37072fd.pth',
                                         map_location='cpu', weights_only=True), strict=True)
        resnet = torch.nn.Sequential(*list(resnet.children())[:-1]).eval().requires_grad_(False)
        labse, info = AutoModel.from_pretrained(self.assets / 'labse', local_files_only=True,
                                                    output_loading_info=True, torch_dtype=torch.float32)
        if any(info.get(key) for key in ('missing_keys', 'unexpected_keys', 'mismatched_keys', 'error_msgs')):
            raise ValueError('incompatible_text_encoder')
        labse.eval().requires_grad_(False)
        tokenizer = AutoTokenizer.from_pretrained(self.assets / 'labse', local_files_only=True)
        preprocess = transforms.Compose([
            transforms.Resize((224, 224), interpolation=transforms.InterpolationMode.BILINEAR, antialias=True),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        self.resnet, self.labse = resnet, labse
        self.tokenizer, self.preprocess = tokenizer, preprocess

    @torch.inference_mode()
    def prepare(self, image_path, photo_version_id, item_type, colors):
        from PIL import Image, ImageOps
        text = canonical_text(item_type, colors)
        self._load_encoders()
        path = Path(image_path)
        with path.open('rb') as stream:
            source_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        with Image.open(path) as image:
            tensor = self.preprocess(ImageOps.exif_transpose(image).convert('RGB')).unsqueeze(0)
        visual = self.resnet(tensor).flatten(1)
        tokens = self.tokenizer(text, return_tensors='pt', padding=True, truncation=True, max_length=512)
        textual = self.labse(**tokens).pooler_output
        projected = self.head.encode_item(visual, textual)
        return representation(projected[0].tolist(), photo_version_id, source_digest, text)

    @torch.inference_mode()
    def query_target(self, context):
        if not isinstance(context, list) or not 0 <= len(context) <= 32:
            raise ValueError('invalid_context_size')
        vectors = [validate_representation(item) for item in context]
        query = self.head.forward_projected(torch.tensor(vectors, dtype=torch.float32).reshape(1, len(vectors), 128))[0]
        if not torch.isfinite(query).all():
            raise ValueError('non_finite_model_output')
        return query.tolist()

    @torch.inference_mode()
    def rank(self, context, candidates):
        if not 1 <= len(candidates) <= 300:
            raise ValueError('invalid_candidate_count')
        query = torch.tensor(self.query_target(context), dtype=torch.float32)
        vectors = torch.tensor([validate_representation(item) for item in candidates], dtype=torch.float32)
        scores = F.cosine_similarity(query.unsqueeze(0), vectors, dim=-1)
        if not torch.isfinite(scores).all():
            raise ValueError('non_finite_model_output')
        # Return scores in the caller's order; product eligibility/tie policy stays outside.
        return scores.tolist()
