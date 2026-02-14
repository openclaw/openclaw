import urllib.request, json, sys
sys.stdout.reconfigure(encoding='utf-8')

url = 'https://raw.githubusercontent.com/google-gemini/cookbook/main/quickstarts/Get_Started_Nano_Banana.ipynb'
data = urllib.request.urlopen(url).read()
nb = json.loads(data)

for i, cell in enumerate(nb['cells']):
    if cell['cell_type'] in ('markdown', 'code'):
        text = ''.join(cell['source'])
        if cell['cell_type'] == 'markdown' and len(text) > 80:
            print(f'=== MD CELL {i} ===')
            print(text[:1000])
            print()
        elif cell['cell_type'] == 'code' and ('generate_content' in text or 'send_message' in text or 'image' in text.lower()):
            print(f'=== CODE CELL {i} ===')
            print(text[:1000])
            print()
