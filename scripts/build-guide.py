#!/usr/bin/env python3
"""Builds the install guide page and the extension download.

Outputs (in dist/, which is git-ignored):
  literotica-single-page-reader.zip   the extension, ready for "Load unpacked"
  site/index.html                     the guide as a normal web page (GitHub Pages);
                                      its button links to the ZIP next to it
  site/literotica-single-page-reader.zip
  single-page-reader-guide.html       the guide as a claude.ai artifact page, with
                                      the ZIP embedded and offered through the
                                      artifact viewer's downloads capability

Both pages come from guide/guide.template.html; guide/claude-download.html
holds the claude.ai-only download code. Name, version and description come
from manifest.json.

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
import re
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUIDE = os.path.join(ROOT, 'guide')
DIST = os.path.join(ROOT, 'dist')
SITE = os.path.join(DIST, 'site')
ZIP_NAME = 'literotica-single-page-reader.zip'
ARTIFACT_PAGE = 'single-page-reader-guide.html'
PACKAGED_DIRS = ('src', 'icons')
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
SITE_DESCRIPTION = (
    'How to install and use Single-Page Reader, an unofficial browser extension '
    'that puts every page of a Literotica story on one page.'
)


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def write(path, text):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


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


def b64_file(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return base64.b64encode(f.read()).decode()


def download_button(target, slot):
    ident = f'download-{slot}'
    if target == 'artifact':
        return (f'<button type="button" id="{ident}" class="btn btn-primary" data-download '
                f'aria-describedby="{ident}-status">Download the extension</button>')
    return (f'<a id="{ident}" class="btn btn-primary" href="{ZIP_NAME}" download '
            f'aria-describedby="{ident}-status">Download the extension</a>')


def fill(text, values, label):
    for placeholder, value in values.items():
        text = text.replace(placeholder, value)
    left = sorted(set(re.findall(r'__[A-Z0-9_]+__', text)))
    if left:
        sys.exit(f'{label}: unfilled placeholders {left}')
    return text


def web_document(page, icon32_b64):
    """Wraps the template content in a full document (claude.ai adds its own skeleton)."""
    head_end = page.index('</style>') + len('</style>')
    head, body = page[:head_end], page[head_end:]
    head = head.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
    description = html.escape(SITE_DESCRIPTION)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="{description}">
<meta property="og:type" content="website">
<meta property="og:title" content="Single-Page Reader">
<meta property="og:description" content="{description}">
<link rel="icon" type="image/png" href="data:image/png;base64,{icon32_b64}">
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
{head}
</head>
<body>{body}
</body>
</html>
"""


def main():
    manifest = json.loads(read(os.path.join(ROOT, 'manifest.json')))
    files = extension_files()
    missing = referenced_files(manifest) - set(files)
    if missing:
        sys.exit(f'manifest.json references files that would not be packaged: {sorted(missing)}')

    os.makedirs(DIST, exist_ok=True)
    zip_path = os.path.join(DIST, ZIP_NAME)
    zip_bytes = build_zip(files, zip_path)
    zip_b64 = base64.b64encode(zip_bytes).decode()

    template = read(os.path.join(GUIDE, 'guide.template.html'))
    shared = {
        '__ZIP_KB__': str(max(1, round(len(zip_bytes) / 1024))),
        '__ICON_B64__': b64_file(manifest['icons']['48']),
        '__VERSION__': html.escape(manifest['version']),
        '__NAME__': html.escape(manifest['name']),
        '__DESCRIPTION__': html.escape(manifest['description']),
    }

    # claude.ai artifact page: ZIP embedded, offered through the downloads capability.
    claude_download = fill(read(os.path.join(GUIDE, 'claude-download.html')), {'__ZIP_BASE64__': zip_b64}, 'claude-download.html')
    artifact = fill(template, dict(shared, **{
        '__DOWNLOAD_BUTTON_TOP__': download_button('artifact', 'top'),
        '__DOWNLOAD_BUTTON_STEP__': download_button('artifact', 'step'),
        '__DOWNLOAD_SCRIPT__': claude_download.rstrip('\n'),
    }), 'artifact page')
    marker = 'id="extension-zip">'
    start = artifact.index(marker) + len(marker)
    if base64.b64decode(artifact[start:artifact.index('</script>', start)].strip()) != zip_bytes:
        sys.exit('embedded ZIP does not round-trip')
    artifact_path = os.path.join(DIST, ARTIFACT_PAGE)
    write(artifact_path, artifact)

    # Plain web page (GitHub Pages): the button is a link to the ZIP beside it.
    web = fill(template, dict(shared, **{
        '__DOWNLOAD_BUTTON_TOP__': download_button('web', 'top'),
        '__DOWNLOAD_BUTTON_STEP__': download_button('web', 'step'),
        '__DOWNLOAD_SCRIPT__': '',
    }), 'web page')
    if 'claude.use' in web or 'extension-zip' in web:
        sys.exit('web page still contains claude.ai-only code')
    if os.path.isdir(SITE):
        shutil.rmtree(SITE)
    os.makedirs(SITE)
    write(os.path.join(SITE, 'index.html'), web_document(web, b64_file(manifest['icons']['32'])))
    shutil.copyfile(zip_path, os.path.join(SITE, ZIP_NAME))

    rel = lambda p: os.path.relpath(p, ROOT)
    print(f'{rel(zip_path)}  {len(zip_bytes):,} bytes, {len(files)} files, version {manifest["version"]}')
    print(f'{rel(os.path.join(SITE, "index.html"))}  web page, links to {ZIP_NAME}')
    print(f'{rel(artifact_path)}  claude.ai page, ZIP embedded')


if __name__ == '__main__':
    main()
