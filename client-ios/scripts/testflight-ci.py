#!/usr/bin/env python3
"""Require complete native acceptance for the exact main revision."""
import json
import os
import re
import subprocess
import sys

REQUIRED = {'changes', 'ios-build', 'ios-acceptance', 'ios-wardrobe-1', 'ios-wardrobe-2',
            'ios-outfits-1', 'ios-outfits-2', 'ios-outfits-max-text',
            'ios-visual-iphone-light', 'ios-visual-iphone-dark',
            'ios-visual-iphone-max-text', 'ios-visual-ipad-light'}


def checked_run(runs, sha, repository, jobs_for_run):
    for run in runs:
        if (run.get('head_sha') == sha and run.get('head_branch') == 'main'
                and run.get('event') in ('push', 'workflow_dispatch', 'schedule') and run.get('status') == 'completed'
                and run.get('conclusion') == 'success' and run.get('path') == '.github/workflows/ci.yml'
                and run.get('head_repository', {}).get('full_name') == repository
                and type(run.get('id')) is int):
            jobs = jobs_for_run(run['id'])
            try:
                check_jobs(jobs)
            except ValueError:
                # A newer focused diagnostic must not hide complete acceptance.
                continue
            return run['id']
    raise ValueError('No successful complete main CI for this revision')


def check_jobs(jobs):
    for name in REQUIRED:
        matches = [job for job in jobs if job.get('name') == name]
        if not matches or any(job.get('status') != 'completed' or job.get('conclusion') != 'success' for job in matches):
            raise ValueError(f'Required CI job did not pass: {name}')


def main():
    sha, repository = os.environ.get('GITHUB_SHA', ''), os.environ.get('GITHUB_REPOSITORY', '')
    if (os.environ.get('GITHUB_REF') != 'refs/heads/main'
            or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or not re.fullmatch(r'[a-f0-9]{40}', sha)
            or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository)):
        raise ValueError('Run TestFlight delivery manually from main')
    def api(path):
        return json.loads(subprocess.check_output(['gh', 'api', path], stderr=subprocess.DEVNULL, timeout=30))
    result = api(f'repos/{repository}/actions/workflows/ci.yml/runs?head_sha={sha}&branch=main&status=success&per_page=100')
    run = checked_run(result.get('workflow_runs', []), sha, repository,
                      lambda run_id: api(f'repos/{repository}/actions/runs/{run_id}/jobs?filter=latest&per_page=100').get('jobs', []))
    print(json.dumps({'revision': sha, 'ciRunId': run, 'checked': True}))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
    except Exception:
        sys.exit('Unable to verify main CI; no TestFlight upload was started')
