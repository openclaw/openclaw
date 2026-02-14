import urllib.request, json, sys
sys.stdout.reconfigure(encoding='utf-8')

# Try to fetch the prompt guide from Google's docs
urls = [
    'https://ai.google.dev/gemini-api/docs/image-generation.md.txt',
    'https://ai.google.dev/gemini-api/docs/image-generation',
]

for url in urls:
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        data = urllib.request.urlopen(req, timeout=10).read().decode('utf-8', errors='replace')
        print(f"=== SUCCESS: {url} ===")
        print(data[:10000])
        break
    except Exception as e:
        print(f"FAILED {url}: {e}")
