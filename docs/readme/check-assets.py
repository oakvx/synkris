#!/usr/bin/env python3
"""Offline checks for the README asset bundle; no third-party packages required."""
from pathlib import Path
from urllib.parse import unquote, urlsplit
import re
import json
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
DOCUMENTS = [ROOT / 'README.md', ROOT / 'docs/OPEN_SOURCE_READINESS.md', ROOT / 'docs/readme/README.md', ROOT / 'docs/WHATSAPP_MIGRATION.md', ROOT / 'deploy/PRIMI_PASSI.md', ROOT / 'docs/PLUG_AND_PLAY.md']
ASSETS = ROOT / 'docs/assets'
checks = 0


def check(condition, message):
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


def headings(content):
    result = set()
    for heading in re.findall(r'^#{1,6}\s+(.+)$', content, re.M):
        heading = re.sub(r'[^\w\- ]', '', heading.lower()).strip()
        result.add(re.sub(r'\s+', '-', heading))
    return result


for document in DOCUMENTS:
    content = document.read_text(encoding='utf-8')
    references = re.findall(r'(?:src|href)=["\']([^"\']+)["\']', content)
    references += re.findall(r'!?\[[^\]\n]*\]\(([^)\s]+)\)', content)
    for reference in references:
        parts = urlsplit(reference)
        if parts.scheme or parts.netloc:
            continue
        target = (document.parent / unquote(parts.path)).resolve() if parts.path else document
        check(target.is_relative_to(ROOT), f'Local reference escapes repository: {reference}')
        check(target.exists(), f'{document.name}: missing local reference {reference}')
        if parts.fragment and target.suffix == '.md':
            check(unquote(parts.fragment) in headings(target.read_text(encoding='utf-8')), f'Missing heading: {reference}')

svgs = sorted(ASSETS.glob('*.svg'))
previews = sorted(ASSETS.glob('*.webp'))
check(len(svgs) == 6, 'Expected 6 generated SVG assets')
check(len(previews) == 3, 'Expected 3 rendered frontend previews')
for asset in svgs:
    content = asset.read_text(encoding='utf-8')
    tree = ET.fromstring(content)
    ns = {'svg': 'http://www.w3.org/2000/svg'}
    check(tree.tag == '{http://www.w3.org/2000/svg}svg', f'Not SVG: {asset.name}')
    check(tree.find('svg:title', ns) is not None and tree.find('svg:desc', ns) is not None, f'Missing accessible title/description: {asset.name}')
    check('viewBox' in tree.attrib, f'Missing viewBox: {asset.name}')
    check(not re.search(r'<(?:script|foreignObject)\b|\son[a-z]+\s*=', content, re.I), f'Active content: {asset.name}')
    check(not re.search(r'(?:href|src)\s*=|@import|url\((?!#)', content, re.I), f'External/embedded resource: {asset.name}')
    check(asset.stat().st_size < 32 * 1024, f'Unexpectedly large vector asset: {asset.name}')
for asset in previews:
    data = asset.read_bytes()
    check(data[:4] == b'RIFF' and data[8:12] == b'WEBP', f'Invalid WebP header: {asset.name}')
    check(len(data) < 1024 * 1024, f'Preview exceeds README size budget: {asset.name}')

readme = DOCUMENTS[0].read_text(encoding='utf-8')
check('synk non è open source' in readme, 'Chosen proprietary licensing status must remain explicit')
check('fixture sintetiche' in readme, 'Rendered previews must disclose synthetic data')
check('non un badge live' in readme, 'CI/audit snapshot must not look live')
license_text = (ROOT / 'LICENSE.md').read_text(encoding='utf-8')
check('non è una licenza open source' in license_text, 'Custom license must not be presented as open source')
check('uso privato non commerciale gratuito' in license_text, 'Private noncommercial permission missing')
check('persona fisica' in license_text, 'Private-use scope must be explicit')
check('accordo commerciale scritto' in license_text and 'a titolo oneroso' in license_text, 'Non-private commercial agreement missing')
check('prezzi o percentuali automatici' in license_text, 'Do not invent royalties/prices')
check('rilascio è gestito manualmente' in readme, 'Activation limitations must be disclosed')
package = json.loads((ROOT / 'package.json').read_text())
lock = json.loads((ROOT / 'package-lock.json').read_text())
check(package.get('license') == 'SEE LICENSE IN LICENSE.md', 'npm metadata must point to the custom license')
check(lock['packages'][''].get('license') == package['license'], 'Lockfile license must match package metadata')
check(package.get('private') is True, 'Accidental npm publication protection changed')
check(package['dependencies'].get('whatsapp-web.js') == '1.34.7', 'Migrated SDK/version missing')
check(package['dependencies'].get('qrcode') == '1.5.4', 'Explicit QR encoder/version missing')
check(not any('@open-wa/' in name for name in lock['packages']), 'OpenWA remains in the install graph')
check('La migrazione del codice è eseguita' in readme, 'Migration implementation must not be described as only a candidate')
check('collaudo WhatsApp reale resta da fare' in readme, 'Do not claim live provider acceptance')
print(f'PASS: {checks} documentation checks; 6 self-contained SVGs, 3 WebP previews, local links and README anchors verified.')
