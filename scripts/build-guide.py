#!/usr/bin/env python3
"""Builds the install guide page with the extension embedded in it.

Outputs (in dist/, which is git-ignored):
  literotica-single-page-reader.zip   the extension, ready for "Load unpacked"
  single-page-reader-guide.html       guide/guide.template.html with the ZIP,
                                      icon and manifest details filled in

The ZIP holds manifest.json, src/ and icons/ at its top level, with no
wrapping folder, so unzipping on macOS or Windows gives one folder with
manifest.json directly inside. Entries are sorted and timestamped
1980-01-01, so the same source always produces the same bytes.

No dependencies. Run: python3 scripts/build-guide.py  (or npm run build:guide)
"""
import base64
import html
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(ROOT, 'guide', 'guide.template.html')
DIST = os.path.join(ROOT, 'dist')
ZIP_NAME = 'literotica-single-page-reader.zip'
PAGE_NAME = 'single-page-reader-guide.html'
PACKAGED_DIRS = ('src', 'icons')
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def extension_files():
    files = ['manifest.json']
    for top in PACKAGED_DIRS:
        for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, top)):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))
            for name in sorted(filenames):
                if not name.startswith('.'):
                    files.append(os.path.relpath(os.path.join(dirpath, name), ROOT).replace(os.sep, '/'))
    return sorted(files)


def referenced_files(manifest):
    refs = set(manifest.get('icons', {}).values())
    for script in manifest.get('content_scripts', []):
        refs.update(script.get('js', []))
        refs.update(script.get('css', []))
    return refs


def build_zip(files, path):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in files:
            info = zipfile.ZipInfo(rel, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(os.path.join(ROOT, rel), 'rb') as f:
                zf.writestr(info, f.read())
    with open(path, 'rb') as f:
        return f.read()


def main():
    with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    files = extension_files()
    missing = referenced_files(manifest) - set(files)
    if missing:
        sys.exit(f'manifest.json references files that would not be packaged: {sorted(missing)}')

    os.makedirs(DIST, exist_ok=True)
    zip_path = os.path.join(DIST, ZIP_NAME)
    zip_bytes = build_zip(files, zip_path)

    icon_rel = manifest['icons']['48']
    with open(os.path.join(ROOT, icon_rel), 'rb') as f:
        icon_b64 = base64.b64encode(f.read()).decode()
    with open(TEMPLATE, encoding='utf-8') as f:
        page = f.read()

    values = {
        '__ZIP_BASE64__': base64.b64encode(zip_bytes).decode(),
        '__ZIP_KB__': str(max(1, round(len(zip_bytes) / 1024))),
        '__ICON_B64__': icon_b64,
        '__VERSION__': html.escape(manifest['version']),
        '__NAME__': html.escape(manifest['name']),
        '__DESCRIPTION__': html.escape(manifest['description']),
    }
    for placeholder, value in values.items():
        if placeholder not in page:
            sys.exit(f'{placeholder} not found in {os.path.relpath(TEMPLATE, ROOT)}')
        page = page.replace(placeholder, value)

    # The embedded ZIP must decode back to exactly the file written above.
    marker = 'id="extension-zip">'
    start = page.index(marker) + len(marker)
    embedded = page[start:page.index('</script>', start)].strip()
    if base64.b64decode(embedded) != zip_bytes:
        sys.exit('embedded ZIP does not round-trip')

    page_path = os.path.join(DIST, PAGE_NAME)
    with open(page_path, 'w', encoding='utf-8') as f:
        f.write(page)

    print(f'{os.path.relpath(zip_path, ROOT)}  {len(zip_bytes):,} bytes, {len(files)} files')
    print(f'{os.path.relpath(page_path, ROOT)}  {len(page.encode()):,} bytes, version {manifest["version"]}')


if __name__ == '__main__':
    main()
