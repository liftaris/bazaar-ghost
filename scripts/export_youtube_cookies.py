#!/usr/bin/env python3
"""Export only default-container YouTube cookies from a Firefox profile."""
import argparse
import os
from pathlib import Path
import sqlite3
import shutil
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    database = args.profile / 'cookies.sqlite'
    with tempfile.TemporaryDirectory(prefix='youtube-cookie-export-') as temporary:
        snapshot = Path(temporary) / 'cookies.sqlite'
        shutil.copyfile(database, snapshot)
        wal = database.with_name(database.name + '-wal')
        if wal.exists():
            shutil.copyfile(wal, snapshot.with_name(snapshot.name + '-wal'))
        with sqlite3.connect(snapshot) as db:
            rows = db.execute("""SELECT host,path,isSecure,expiry,name,value,isHttpOnly
                FROM moz_cookies WHERE (host='youtube.com' OR host LIKE '%.youtube.com')
                AND originAttributes=''""").fetchall()
    if not rows:
        raise SystemExit('No YouTube cookies in this profile/container')
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.write('# Netscape HTTP Cookie File\n')
        for host, path, secure, expiry, name, value, http_only in rows:
            output.write('\t'.join([
                ('#HttpOnly_' if http_only else '') + host,
                'TRUE' if host.startswith('.') else 'FALSE', path,
                'TRUE' if secure else 'FALSE', str(expiry), name, value,
            ]) + '\n')
    print(f'Exported {len(rows)} YouTube-only cookies; values omitted')


if __name__ == '__main__':
    main()
