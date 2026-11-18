import { createHmac } from 'crypto';

/** Domain-separated signing key. Legacy Hermes versions cannot verify mobile JWTs. */
export function mobileJwtKey(jwtSecret: string): string {
  return createHmac('sha256', jwtSecret)
    .update('hermes-crm-mobile-access-v1', 'utf8')
    .digest('hex');
}
