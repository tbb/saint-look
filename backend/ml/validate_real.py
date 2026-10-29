"""Opt-in real checkpoint verification on attributed PUBLIC photographs.

This is not CI, UI acceptance, a holdout, or a taste benchmark. No external AI
calls. Writes exact outputs, inputs, process RSS and CPU timings for reproduction.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import statistics
import time


def memory():
    values = {}
    for line in Path('/proc/self/status').read_text().splitlines():
        if line.startswith(('VmRSS:', 'VmHWM:')):
            values[line.split(':')[0] + 'KiB'] = int(line.split()[1])
    return values


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--reference-source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    start = time.perf_counter()
    import torch
    from adapter import OutfitAdapter
    from contract import SPACE_ID, DESCRIPTOR
    adapter = OutfitAdapter(args.assets, args.threads)
    if hashlib.sha256(args.reference_source.read_bytes()).hexdigest() != 'b03cbf04b5a34625f1f302fdaba469f8b2f9fc70a993bac2adb05e69bee3b492':
        raise ValueError('Reference source is not pinned model.py')
    spec = importlib.util.spec_from_file_location('reference', args.reference_source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    reference = module.OutfitTransformerCIR(use_projection=False).eval()
    loaded = reference.load_state_dict(torch.load(Path(args.assets) / 'pytorch_model.bin',
                                                 map_location='cpu', weights_only=True), strict=True)
    result = {'hardware': {'cpu': platform.processor(), 'machine': platform.machine(),
                           'logicalCPUs': os.cpu_count(), 'torchThreads': torch.get_num_threads()},
              'spaceID': SPACE_ID, 'descriptor': DESCRIPTOR,
              'headStrictLoad': str(loaded), 'headStartupSeconds': time.perf_counter() - start,
              'startupMemory': memory(), 'items': [], 'contexts': [],
              'limitations': ['CPU adapter only; excludes HTTP/network/UI',
                              'Development public photos, no human preference labels',
                              'Synthetic 300 duplicates only checks computation volume']}
    dataset = json.loads(args.dataset.read_text())
    for item in dataset['items']:
        tick = time.perf_counter()
        image = args.dataset.parent / item['image']
        prepared = adapter.prepare(image, 'public-source-v1', item['type'], item['colors'])
        assert prepared['sourceSHA256'] == item['sha256'], item['id']
        result['items'].append({'id': item['id'], 'type': item['type'], 'colors': item['colors'],
                                'image': str(image), 'attribution': item.get('attribution'),
                                'preparationSeconds': time.perf_counter() - tick,
                                'memory': memory(), 'representation': prepared})
    representations = [item['representation'] for item in result['items']]
    for size in [0, 1, 3, 8, 16]:
        context = (representations * 2)[:size]
        tick = time.perf_counter()
        query = torch.tensor(adapter.query_target(context))
        first = (time.perf_counter() - tick) * 1000
        vectors = torch.tensor([r['vector'] for r in context]).reshape(1, size, 128)
        with torch.inference_mode():
            expected = reference(vectors[:, :, :64], vectors[:, :, 64:])[0]
            assert torch.allclose(query, expected, atol=1e-6, rtol=1e-5)
            # Padding invariance exercises the ORIGINAL masking semantics too.
            padded = torch.cat([vectors, torch.zeros(1, 2, 128)], dim=1)
            mask = torch.tensor([[False] * size + [True, True]])
            masked = reference(padded[:, :, :64], padded[:, :, 64:], mask)[0]
            padding_error = (query - masked).abs().max().item()
            assert torch.allclose(query, masked, atol=2e-6, rtol=1e-4)
        reverse = torch.tensor(adapter.query_target(list(reversed(context))))
        permutation_error = (query - reverse).abs().max().item()
        assert torch.allclose(query, reverse, atol=2e-6, rtol=1e-4)
        times = []
        candidates = (representations * 24)[:300]
        for _ in range(30):
            tick = time.perf_counter()
            scores = adapter.rank(context, candidates)
            times.append((time.perf_counter() - tick) * 1000)
        candidate_vectors = torch.tensor([r['vector'] for r in representations])
        cosine = torch.nn.functional.cosine_similarity(query, candidate_vectors)
        dot = candidate_vectors @ query
        euclidean = -(candidate_vectors - query).norm(dim=-1)
        result['contexts'].append({'size': size, 'firstQueryMs': first,
            'warmRank300MedianMs': statistics.median(times), 'warmRank300MaxMs': max(times),
            'queryNorm': query.norm().item(), 'paddingMaxError': padding_error,
            'permutationMaxError': permutation_error,
            'originalParityMaxError': (query - expected).abs().max().item(),
            'ranking': {name: [result['items'][idx]['id'] for idx in values.argsort(descending=True).tolist()]
                        for name, values in [('cosine', cosine), ('dot', dot), ('negativeEuclidean', euclidean)]}})
    item = dataset['items'][0]
    repeat = adapter.prepare(args.dataset.parent / item['image'], 'public-source-v1', item['type'], item['colors'])
    assert repeat == representations[0]
    result['repeatBitExact'] = True
    result['serializedBytesPerItem'] = [len(json.dumps(r, separators=(',', ':')).encode()) for r in representations]
    result['memory'] = memory()
    result['totalSeconds'] = time.perf_counter() - start
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ('items', 'contexts')}, indent=2))


if __name__ == '__main__':
    main()
