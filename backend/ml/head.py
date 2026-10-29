"""OutfitTransformer-LaBSE CIR head, pinned to 7eaf8d9 (MIT, fkuyumcu).

Architecture/state keys follow the published model.py. The only split is exposing
forward_projected so recommendations consume persisted item embeddings. No category
input or whole-outfit score exists in this checkpoint.
"""
import torch
from torch import nn
from torch.nn import functional as F


class OutfitTransformerCIR(nn.Module):
    def __init__(self):
        super().__init__()
        self.visual_proj = nn.Linear(512, 64)
        self.text_proj = nn.Linear(768, 64)
        layer = nn.TransformerEncoderLayer(d_model=128, nhead=16, dim_feedforward=512,
                                          batch_first=True, dropout=0.1)
        self.transformer = nn.TransformerEncoder(layer, num_layers=6)
        self.query_token = nn.Parameter(torch.randn(1, 1, 128))
        self.output_proj = nn.Sequential(nn.Linear(128, 128), nn.LayerNorm(128))

    def encode_item(self, images, texts):
        return torch.cat((self.visual_proj(images), self.text_proj(texts)), dim=-1)

    def forward_projected(self, items):
        query = self.query_token.expand(items.size(0), -1, -1)
        output = self.transformer(torch.cat((query, items), dim=1))
        return F.normalize(self.output_proj(output[:, 0, :]), p=2, dim=-1)
