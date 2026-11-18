import { createHmac } from 'crypto';

// Domain separation: a web-session JWT cannot be presented as a legacy JWT.
export function webJwtKey(secret: string): string {
  return createHmac('sha256', secret)
    .update('hermes-crm-web-session-access-v1')
    .digest('hex');
}
