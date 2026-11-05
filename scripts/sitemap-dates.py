"""Set each page's <lastmod> in site/sitemap.xml to the day its files last changed (from git).

Google uses lastmod to decide when to look at a page again, but only trusts it while it's honest, so this reads
the dates from git instead of anyone typing them. A pup page (/pup-club/corgi) is built from the board page and
products.json, so it counts changes to either. Run from the repo root after committing a change to a page:

    python3 scripts/sitemap-dates.py           # update the dates
    python3 scripts/sitemap-dates.py --check   # only say which are out of date (exits 1 if any)

Then commit site/sitemap.xml. Uncommitted changes don't count: the date is the last commit's.
"""
import re
import subprocess
import sys

SITEMAP = 'site/sitemap.xml'
ORIGIN = 'https://ourjkadventures.com'


def sources(path):
    """the files a page is made from"""
    if path == '/':
        return ['site/index.html']
    if path.startswith('/pup-club/'):
        return ['site/pup-club.html', 'site/products.json']
    return ['site' + path + '.html']


def last_changed(files):
    out = subprocess.check_output(['git', 'log', '-1', '--format=%cs', '--'] + files, text=True).strip()
    if not out:
        sys.exit('no commits for ' + ', '.join(files) + ': commit the page first')
    return out


def main():
    check = '--check' in sys.argv
    xml = open(SITEMAP).read()
    stale = []

    def fix(m):
        path = m.group(1)[len(ORIGIN):]
        want = last_changed(sources(path))
        if m.group(3) != want:
            stale.append((path, m.group(3), want))
        return m.group(1).join(['<loc>', '</loc>']) + m.group(2) + want

    new = re.sub(r'<loc>([^<]+)</loc>(\s*<lastmod>)([^<]+)', lambda m: fix(m), xml)
    for path, was, now in stale:
        print(path, was, '->', now)
    if check:
        sys.exit(1 if stale else 0)
    if stale:
        open(SITEMAP, 'w').write(new)
    print(len(stale), 'date(s) changed')


main()
