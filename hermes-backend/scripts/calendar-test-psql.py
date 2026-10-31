#!/usr/bin/env python3
"""Run calendar migration SQL through the dedicated integration PostgreSQL container."""
import os
import subprocess
import sys
from urllib.parse import urlparse

args = sys.argv[1:]
try:
    options = {args[i]: args[i + 1] for i in range(0, len(args) - 1) if args[i] in ('-h', '-p', '-U', '-d')}
    url = urlparse(os.environ['CALENDAR_TEST_DATABASE_URL'])
    container = os.environ['HERMES_TEST_PG_CONTAINER_ID']
    assert url.scheme == 'postgresql'
    assert url.hostname == '127.0.0.1' and url.port == 55432
    assert url.path == '/hermes_learning_test' and url.username == 'learning_test'
    assert options == {'-h': '127.0.0.1', '-p': '55432', '-U': 'learning_test', '-d': 'hermes_learning_test'}
    assert len(container) == 64 and all(c in '0123456789abcdef' for c in container)
except (AssertionError, KeyError, ValueError):
    print('Calendar psql wrapper refused an unexpected target', file=sys.stderr)
    sys.exit(2)

port_index = args.index('-p') + 1
args[port_index] = '5432'
result = subprocess.run(
    ['docker', 'exec', '-i', '-e', 'PGPASSWORD', container, 'psql', *args],
    input=sys.stdin.buffer.read(),
    stdout=sys.stdout.buffer,
    stderr=sys.stderr.buffer,
    check=False,
)
sys.exit(result.returncode)
