import urllib.request, sys
sys.stdout.reconfigure(encoding='utf-8')

url = 'https://ai.google.dev/gemini-api/docs/image-generation.md.txt'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
data = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', errors='replace')

# Find the prompt guide section
idx = data.find('prompt')
sections = ['prompt guide', 'best practice', 'tips', 'style transfer', 'product mock', 'photorealistic', 'high-fidelity', 'text in image', 'editing', 'chat', 'iterati']
for s in sections:
    idx = data.lower().find(s)
    if idx >= 0:
        print(f"\n=== SECTION: {s} (at {idx}) ===")
        print(data[max(0,idx-200):idx+3000])
        print("...")
