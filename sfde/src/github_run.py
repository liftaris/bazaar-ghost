"""The GitHub Actions run executing this process, reported to the backend's run history."""

import os


def github_run():
    run = {}
    for field in ('github_run_id', 'github_run_attempt'):
        value = os.getenv(field.upper(), '')
        if value.isdigit() and int(value) > 0:
            run[field] = int(value)
    return run
