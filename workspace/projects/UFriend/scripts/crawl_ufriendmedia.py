#!/usr/bin/env python3
import os, re, json, time
from pathlib import Path
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup

BASE = 'https://www.ufriendmedia.com/'
OUT = Path('media/ufriendmedia.com')
PAGES_DIR = OUT/'pages'
ASSETS_DIR = OUT/'assets'
PAGES_DIR.mkdir(parents=True, exist_ok=True)
ASSETS_DIR.mkdir(parents=True, exist_ok=True)

sess = requests.Session()
sess.headers.update({'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'})

visited=set()

def safe_name(url:str):
    p = urlparse(url)
    path = p.path.strip('/') or 'index'
    if path.endswith('/'):
        path += 'index'
    path = re.sub(r'[^a-zA-Z0-9_\-/\.]+','_',path)
    path = path.replace('/', '__')
    return path

def download_asset(asset_url:str):
    try:
        r=sess.get(asset_url, timeout=30)
        r.raise_for_status()
    except Exception:
        return None
    name=safe_name(asset_url)
    # try keep extension
    ext=os.path.splitext(urlparse(asset_url).path)[1]
    if ext and not name.endswith(ext):
        name += ext
    fp=ASSETS_DIR/name
    if fp.exists() and fp.stat().st_size>0:
        return str(fp)
    fp.write_bytes(r.content)
    return str(fp)

def extract_links_and_assets(html:str, url:str):
    soup=BeautifulSoup(html,'lxml')
    # internal links
    links=set()
    for a in soup.select('a[href]'):
        href=a.get('href')
        if not href: continue
        full=urljoin(url, href)
        if urlparse(full).netloc==urlparse(BASE).netloc:
            links.add(full.split('#')[0])
    assets=set()
    for tag, attr in [('img','src'), ('script','src'), ('link','href')]:
        for t in soup.find_all(tag):
            v=t.get(attr)
            if not v: continue
            full=urljoin(url, v)
            if urlparse(full).scheme in ('http','https'):
                assets.add(full)
    # inline css url(...)
    for style in soup.find_all(style=True):
        css=style.get('style','')
        for m in re.findall(r'url\(["\']?(.*?)["\']?\)', css):
            assets.add(urljoin(url,m))
    return soup, sorted(links), sorted(assets)

def crawl(max_pages=200, delay=0.6):
    q=[BASE]
    pages=[]
    while q and len(visited)<max_pages:
        u=q.pop(0)
        if u in visited: continue
        visited.add(u)
        try:
            r=sess.get(u, timeout=30)
            r.raise_for_status()
            html=r.text
        except Exception as e:
            pages.append({'url':u,'error':str(e)})
            continue
        name=safe_name(u)+'.html'
        (PAGES_DIR/name).write_text(html, encoding='utf-8', errors='ignore')
        soup, links, assets=extract_links_and_assets(html,u)
        title=(soup.title.string.strip() if soup.title and soup.title.string else '')
        pages.append({'url':u,'title':title,'saved_html':str(PAGES_DIR/name),'links':links,'assets':assets})
        for l in links:
            if l not in visited and l not in q:
                q.append(l)
        # download assets (lightweight: only images/css/js)
        downloaded=[]
        for a in assets:
            if any(a.lower().endswith(ext) for ext in ['.png','.jpg','.jpeg','.webp','.gif','.svg','.css','.js','.mp4','.mov','.pdf']):
                p=download_asset(a)
                if p: downloaded.append({'url':a,'path':p})
        pages[-1]['downloaded_assets']=downloaded
        time.sleep(delay)
    out=OUT/'site_dump.json'
    out.write_text(json.dumps(pages, ensure_ascii=False, indent=2))
    return out, len(pages)

if __name__=='__main__':
    out, n=crawl()
    print('DONE pages=',n,'json=',out)
