"""Private JSON-lines worker; backend owns HTTP/auth/paths and request deadlines.

One process serializes inference. No network listeners, fallback, paid API calls,
or downloads. Caller sends an id and receives the same id. Restart on transport
failure; request retries belong to the existing job/operation coordinator.
"""
import argparse
import json
import sys

from contract import DESCRIPTOR, SPACE_ID


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True)
    parser.add_argument('--threads', type=int, default=2, choices=range(1, 9))
    args = parser.parse_args()
    from adapter import OutfitAdapter
    adapter = OutfitAdapter(args.assets, args.threads)
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 2_000_000:
                raise ValueError('request_too_large')
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError('invalid_request')
            operation = request.get('operation')
            if operation == 'describe':
                adapter.verify_assets()
                result = {'spaceID': SPACE_ID, 'descriptor': DESCRIPTOR}
            elif operation == 'prepare':
                result = adapter.prepare(request['imagePath'], request['photoVersionID'],
                                         request['type'], request['colors'])
            elif operation == 'query':
                result = {'query': adapter.query_target(request['context'])}
            elif operation == 'rank':
                result = {'scores': adapter.rank(request['context'], request['candidates'])}
            else:
                raise ValueError('unknown_operation')
            response = {'id': request.get('id'), 'result': result}
        except Exception as error:
            # Logs are intentionally generic: paths and image metadata stay local.
            print(type(error).__name__, file=sys.stderr, flush=True)
            safe_codes = {'request_too_large', 'invalid_request', 'unknown_operation',
                          'invalid_type', 'invalid_colors', 'incompatible_runtime', 'incompatible_representation',
                          'invalid_photo_version', 'invalid_input_digest', 'invalid_vector',
                          'invalid_vector_norm', 'invalid_context_size', 'invalid_candidate_count',
                          'asset_checksum_mismatch', 'incompatible_text_encoder', 'non_finite_model_output'}
            code = str(error) if isinstance(error, ValueError) and str(error) in safe_codes else 'model_failed'
            response = {'id': request.get('id') if isinstance(request, dict) else None,
                        'error': {'code': code}}
        print(json.dumps(response, allow_nan=False, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
