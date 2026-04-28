#!/home/mertb/.openclaw/workspace/.venv-graph/bin/python
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import msal
import requests

CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
AUTHORITY = 'https://login.microsoftonline.com/common'
SCOPES = ['Mail.Read', 'User.Read']
CACHE_PATH = Path('/home/mertb/.openclaw/workspace/windows-bridge-bootstrap/graph-cache/msal_token_cache.json')
KEYWORDS = [
    'offer', 'job offer', 'opportunity', 'position', 'role', 'interview', 'recruiter', 'compensation', 'salary', 'contract',
    'iş teklifi', 'pozisyon', 'maaş', 'görüşme', 'dot net developer', '.net developer'
]


def load_token():
    cache = msal.SerializableTokenCache()
    if CACHE_PATH.exists():
        cache.deserialize(CACHE_PATH.read_text(encoding='utf-8'))
    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY, token_cache=cache)
    accounts = app.get_accounts()
    if not accounts:
        raise RuntimeError('No cached Graph account found. Run graph_device_login.py first.')
    result = app.acquire_token_silent(SCOPES, account=accounts[0])
    if not result or 'access_token' not in result:
        raise RuntimeError('Could not acquire token silently from cache.')
    return result['access_token'], accounts[0].get('username')


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--days-back', type=int, default=913)
    args = parser.parse_args()

    token, account = load_token()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=args.days_back)).isoformat().replace('+00:00', 'Z')
    url = 'https://graph.microsoft.com/v1.0/me/messages'
    params = {
        '$top': '200',
        '$select': 'id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,webLink',
        '$filter': f'receivedDateTime ge {cutoff}',
        '$orderby': 'receivedDateTime desc',
    }
    headers = {'Authorization': f'Bearer {token}'}
    items = []
    next_url = url
    next_params = params
    page_count = 0
    max_pages = 25
    while next_url and page_count < max_pages:
        resp = requests.get(next_url, headers=headers, params=next_params, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        items.extend(data.get('value', []))
        next_url = data.get('@odata.nextLink')
        next_params = None
        page_count += 1

    matches = []
    for item in items:
        subject = item.get('subject') or ''
        from_obj = item.get('from') or {}
        email = (from_obj.get('emailAddress') or {})
        from_text = ' '.join([x for x in [email.get('name'), f"<{email.get('address')}>" if email.get('address') else None] if x])
        preview = item.get('bodyPreview') or ''
        haystack = '\n'.join([subject, from_text, preview]).lower()
        reasons = [kw for kw in KEYWORDS if kw.lower() in haystack]
        if reasons:
            matches.append({
                'id': item.get('id'),
                'subject': subject,
                'from': from_text,
                'receivedAt': item.get('receivedDateTime'),
                'sentAt': item.get('sentDateTime'),
                'preview': preview,
                'webLink': item.get('webLink'),
                'matchReasons': reasons,
            })
    print(json.dumps({
        'status': 'ok',
        'account': account,
        'daysBack': args.days_back,
        'pageCount': page_count,
        'totalScanned': len(items),
        'matchedCount': len(matches),
        'matches': matches,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
