#!/home/mertb/.openclaw/workspace/.venv-graph/bin/python
import json
import os
import sys
from pathlib import Path

import msal

CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
AUTHORITY = 'https://login.microsoftonline.com/common'
SCOPES = ['Mail.Read', 'User.Read']
CACHE_DIR = Path('/home/mertb/.openclaw/workspace/windows-bridge-bootstrap/graph-cache')
CACHE_PATH = CACHE_DIR / 'msal_token_cache.json'


def load_cache():
    cache = msal.SerializableTokenCache()
    if CACHE_PATH.exists():
        cache.deserialize(CACHE_PATH.read_text(encoding='utf-8'))
    return cache


def save_cache(cache):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if cache.has_state_changed:
        CACHE_PATH.write_text(cache.serialize(), encoding='utf-8')


def main():
    cache = load_cache()
    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY, token_cache=cache)

    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and 'access_token' in result:
            save_cache(cache)
            print(json.dumps({'status': 'ok', 'source': 'silent-cache', 'account': accounts[0].get('username')}))
            return 0

    flow = app.initiate_device_flow(scopes=SCOPES)
    if 'user_code' not in flow:
        print(json.dumps({'status': 'failed', 'error': flow}), file=sys.stderr)
        return 1

    print(json.dumps({
        'status': 'pending',
        'verification_uri': flow.get('verification_uri'),
        'user_code': flow.get('user_code'),
        'message': flow.get('message'),
    }))
    sys.stdout.flush()

    result = app.acquire_token_by_device_flow(flow)
    if 'access_token' in result:
        save_cache(cache)
        print(json.dumps({'status': 'ok', 'source': 'device-flow', 'account': result.get('id_token_claims', {}).get('preferred_username')}))
        return 0

    print(json.dumps({'status': 'failed', 'error': result}), file=sys.stderr)
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
