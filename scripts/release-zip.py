#!/usr/bin/env python3
"""Write and verify a deterministic ZIP from an explicit JSON file list."""
import json
import pathlib
import sys
import zipfile


def create_zip(output, entries):
    names = [entry['name'] for entry in entries]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate ZIP entry')
    for entry in entries:
        name = entry['name']
        source = pathlib.Path(entry['source'])
        if (not name or '\\' in name or ':' in name or name.startswith('/')
                or any(part in ('', '.', '..') for part in name.split('/'))
                or source.is_symlink() or not source.is_file()):
            raise ValueError('Invalid ZIP entry: ' + name)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for entry in sorted(entries, key=lambda value: value['name']):
            info = zipfile.ZipInfo(entry['name'], (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, pathlib.Path(entry['source']).read_bytes(), compresslevel=9)
    with zipfile.ZipFile(output) as archive:
        if sorted(archive.namelist()) != sorted(names) or archive.testzip() is not None:
            raise ValueError('ZIP verification failed')
        for entry in entries:
            if archive.read(entry['name']) != pathlib.Path(entry['source']).read_bytes():
                raise ValueError('ZIP contents mismatch: ' + entry['name'])


if __name__ == '__main__':
    create_zip(sys.argv[1], json.load(sys.stdin))
