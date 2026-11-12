"""Cache food illustrations with source/license metadata; never send user data."""
import concurrent.futures
import html
import json
from pathlib import Path
import re
import time
import threading
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'public' / 'assets' / 'defaults'
DEST.mkdir(parents=True, exist_ok=True)
CACHE = ROOT / '.local' / 'default-image-sources.json'
CACHE.parent.mkdir(parents=True, exist_ok=True)
sources = json.loads(CACHE.read_text(encoding='utf-8')) if CACHE.exists() else {}
manifest = DEST / 'manifest.js'
previous = json.loads(manifest.read_text(encoding='utf-8').split(' = ', 1)[1].rstrip().rstrip(';')) if manifest.exists() else []
existing = {(r['kind'], r['key']): r for r in previous}
rate_lock = threading.Lock()
last_request = {}


def fetch(url):
    for attempt in range(3):
        host = urllib.parse.urlsplit(url).hostname
        if host and ('wikimedia' in host or 'wikipedia' in host):
            with rate_lock:
                delay = max(0, last_request.get(host, 0) + 1.2 - time.monotonic())
                if delay: time.sleep(delay)
                last_request[host] = time.monotonic()
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'FriendsFridge-EducationalDemo/1.0'})
            with urllib.request.urlopen(request, timeout=25) as response:
                data = response.read(5 * 1024 * 1024 + 1)
                if len(data) > 5 * 1024 * 1024:
                    raise ValueError('Image exceeds size limit')
                return data
        except Exception as error:
            if getattr(error, 'code', None) in (400, 403, 404) or attempt == 2:
                raise
            time.sleep((attempt + 1) * 5 if getattr(error, 'code', None) == 429 else attempt + 1)


def api(params):
    return json.loads(fetch('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode(params)))


def clean(value):
    return html.unescape(re.sub('<[^>]*>', '', value)).strip()


def commons_info(title=None, search=None):
    params = dict(action='query', format='json', prop='imageinfo', iiprop='url|extmetadata', iiurlwidth=240)
    if title:
        params['titles'] = title
    else:
        params.update(generator='search', gsrsearch=search + ' filetype:bitmap', gsrnamespace=6, gsrlimit=5)
    pages = api(params).get('query', {}).get('pages', {})
    for page in sorted(pages.values(), key=lambda p: p.get('index', 0)):
        for info in page.get('imageinfo', []):
            metadata = info.get('extmetadata', {})
            license_name = clean(metadata.get('LicenseShortName', {}).get('value', ''))
            if not re.search(r'CC[ -]BY|CC0|Public domain', license_name, re.I):
                continue
            url = info.get('thumburl', info['url'])
            if '.svg' in url.lower() or '.tif' in url.lower():
                continue
            return dict(url=url, source=info['descriptionurl'], provider='Wikimedia Commons',
                        author=clean(metadata.get('Artist', {}).get('value', 'See source page')),
                        license=license_name, license_url=metadata.get('LicenseUrl', {}).get('value', ''),
                        image_title=page['title'])
    raise ValueError('No freely licensed bitmap found')


def wikimedia(row):
    key = row['name']
    if key in sources:
        return sources[key]
    if row.get('commons_file'):
        result = commons_info(title=row['commons_file'])
        sources[key] = result
        return result
    # A page's lead image is less ambiguous than a free-text image search.
    try:
        summary = json.loads(fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + urllib.parse.quote(row.get('wiki_title', key.title()))))
        original = summary['originalimage']['source']
        if '/wikipedia/commons/' not in original:
            raise ValueError('Not a Commons image')
        title = 'File:' + urllib.parse.unquote(urllib.parse.urlsplit(original).path.rsplit('/', 1)[1])
        result = commons_info(title=title)
    except Exception:
        result = commons_info(search='"' + key + '" food')
    sources[key] = result
    return result


def ingredient(row):
    base = dict(key=row['name'], name=row['name'].title(), kind='ingredient', category=row['category'])
    if row['provider'] == 'Wikimedia Commons':
        return {**base, **wikimedia(row)}
    host = 'www.themealdb.com' if row['provider'] == 'TheMealDB' else 'www.thecocktaildb.com'
    return {**base, 'provider': row['provider'], 'url': f"https://{host}/images/ingredients/{urllib.parse.quote(row['image_name'])}-small.png", 'source': f'https://{host}/api.php'}


def recipe_image(row):
    old = existing.get((row['kind'], row['key']))
    if old:
        return old
    meal = row['provider'] == 'TheMealDB'
    host = 'www.themealdb.com' if meal else 'www.thecocktaildb.com'
    data = json.loads(fetch(f"https://{host}/api/json/v1/1/lookup.php?i={row['source_id']}"))['meals' if meal else 'drinks'][0]
    return dict(key=row['key'], name=data['strMeal' if meal else 'strDrink'], kind=row['kind'], provider=row['provider'],
                url=data['strMealThumb' if meal else 'strDrinkThumb'] + '/small', source=f"https://{host}/{'meal' if meal else 'drink'}/{row['source_id']}")


def download(job):
    data = fetch(job['url'])
    if data.startswith(bytes.fromhex('89504e470d0a1a0a')):
        extension = 'png'
    elif data.startswith(bytes.fromhex('ffd8ff')):
        extension = 'jpg'
    else:
        raise ValueError('Not a PNG or JPEG: ' + job['key'])
    filename = job['kind'] + '-' + job['key'].replace(' ', '-') + '.' + extension
    path = DEST / filename
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_bytes(data)
    temporary.replace(path)
    return {**job, 'src': '/assets/defaults/' + filename}


def process(row, recipe=False):
    kind = row['kind'] if recipe else 'ingredient'
    key = row['key'] if recipe else row['name']
    old = existing.get((kind, key))
    if old and (ROOT / 'public' / old['src'].lstrip('/')).exists():
        return {**old, **({'category': row['category']} if not recipe else {})}
    try:
        job = recipe_image(row) if recipe else ingredient(row)
        try:
            result = download(job)
        except Exception:
            if recipe or job['provider'] == 'Wikimedia Commons':
                raise
            result = download({**job, **wikimedia(row)})
        print('Cached ' + key, flush=True)
        return result
    except Exception as error:
        print('MISSING ' + key + ': ' + str(error), flush=True)
        return dict(key=key, kind=kind, missing=True, error=str(error))


catalog = json.loads((ROOT / 'shared' / 'default-image-catalog.json').read_text(encoding='utf-8'))
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    images = list(pool.map(process, catalog['ingredients']))
    images.extend(pool.map(lambda row: process(row, True), catalog['recipes']))
CACHE.write_text(json.dumps(sources, indent=2), encoding='utf-8')
missing = [r for r in images if r.get('missing')]
(DEST / 'coverage.json').write_text(json.dumps(dict(ingredients=len(catalog['ingredients']), recipes=len(catalog['recipes']), missing=missing), indent=2) + '\n', encoding='utf-8')
images = [r for r in images if not r.get('missing')]
manifest.write_text('export const defaultImages = ' + json.dumps(images, indent=2) + ';\n', encoding='utf-8')
print(f'Cached {len(images)} images; missing {len(missing)}', flush=True)
if missing:
    raise SystemExit(1)
