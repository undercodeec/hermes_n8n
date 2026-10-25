"""Standalone VPS observer replacement. Copy explicitly; never runs from this Windows patch."""

import argparse
from datetime import datetime, timezone
import json
import re
import subprocess
import uuid


_UTC_STAMP = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\Z')
_STATUSES = {'PREPARED', 'DISPATCHING', 'CONFIRMED', 'REJECTED', 'AMBIGUOUS', 'SUPPRESSED'}


def build_sql(source_message_id: str, after_utc: str) -> str:
    try:
        parsed = uuid.UUID(source_message_id)
    except (ValueError, AttributeError, TypeError) as error:
        raise ValueError('source_message_id must be a canonical UUID') from error
    if str(parsed) != source_message_id.lower():
        raise ValueError('source_message_id must be a canonical UUID')
    if not isinstance(after_utc, str) or not _UTC_STAMP.fullmatch(after_utc):
        raise ValueError('after_utc must be an ISO UTC timestamp')
    try:
        when = datetime.fromisoformat(after_utc.replace('Z', '+00:00'))
    except ValueError as error:
        raise ValueError('after_utc must be a valid timestamp') from error
    if when.tzinfo != timezone.utc:
        raise ValueError('after_utc must be UTC')
    return (
        'BEGIN READ ONLY;\n'
        "SELECT 'MESSAGE', id, \"createdAt\"::text FROM messages "
        f"WHERE id = '{parsed}' AND \"createdAt\" >= '{after_utc}'::timestamptz\n"
        'UNION ALL\n'
        "SELECT 'DELIVERY', id, status::text FROM automated_deliveries "
        f"WHERE \"sourceMessageId\" = '{parsed}' AND \"createdAt\" >= '{after_utc}'::timestamptz;\n"
        'COMMIT;\n'
    )


def observe(source_message_id: str, after_utc: str) -> dict:
    sql = build_sql(source_message_id, after_utc)
    command = [
        'docker', 'exec', '-i', 'hermes-postgres', 'sh', '-lc',
        'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|"',
    ]
    try:
        result = subprocess.run(
            command, input=sql, text=True, capture_output=True,
            check=False, timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {'state': 'EXEC_ERROR'}
    if result.returncode != 0:
        return {'state': 'SQL_ERROR', 'exitCode': result.returncode}
    lines = [line for line in result.stdout.splitlines()
             if line and line not in {'BEGIN', 'COMMIT'}]
    if not lines:
        return {'state': 'NO_ROWS', 'messageCount': 0, 'deliveryCount': 0}
    message_count = 0
    delivery_count = 0
    statuses = set()
    for line in lines:
        parts = line.split('|')
        if len(parts) != 3:
            return {'state': 'OUTPUT_INVALID'}
        row_type, _row_id, value = parts
        if row_type == 'MESSAGE':
            message_count += 1
        elif row_type == 'DELIVERY' and value in _STATUSES:
            delivery_count += 1
            statuses.add(value)
        else:
            return {'state': 'OUTPUT_INVALID'}
    return {
        'state': 'ROWS',
        'messageCount': message_count,
        'deliveryCount': delivery_count,
        'deliveryStatuses': sorted(statuses),
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source_message_id')
    parser.add_argument('after_utc')
    args = parser.parse_args()
    print(json.dumps(observe(args.source_message_id, args.after_utc), sort_keys=True))
