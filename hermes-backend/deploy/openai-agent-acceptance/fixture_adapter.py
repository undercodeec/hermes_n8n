"""Synthetic fixture only; not an image adapter or evidence of Hermes behavior."""
import json
import sys
import urllib.error
import urllib.request

request = json.load(sys.stdin)
url = request['openai_base_url'] + '/chat/completions'
body = json.dumps({'model': 'synthetic-model', 'messages': [{'role': 'user', 'content': request['input']}]}).encode()
try:
    # The limit scenario represents a two-call turn; no third call is made.
    count = request['max_provider_calls'] if request['scenario'] == 'turn_limit' else 1
    if len(sys.argv) > 1 and sys.argv[1] == 'overlimit' and request['scenario'] == 'turn_limit':
        count += 1
    for _ in range(count):
        req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=3) as response:
            completion = json.load(response)
        if request['scenario'] != 'turn_limit':
            answer = json.loads(completion['choices'][0]['message']['content'])['answer']
    result = {'status': 'error', 'side_effects': 0} if request['scenario'] == 'turn_limit' else {'status': 'ok', 'answer': answer, 'side_effects': 0}
except (ValueError, KeyError, urllib.error.URLError):
    result = {'status': 'error', 'side_effects': 0}
if len(sys.argv) > 1 and sys.argv[1] == 'failopen' and request['scenario'] in ('invalid_json', 'rate_limit'):
    result = {'status': 'ok', 'answer': 'synthetic-ok', 'side_effects': 0}
print(json.dumps(result))
