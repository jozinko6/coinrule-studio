/**
 * signing.mjs — Binance Spot API request signing (Node crypto, no deps).
 *
 * Binance signs the EXACT percent-encoded query string that is sent on the
 * wire, so the encoder here is part of the security boundary: a mismatch
 * produces `-1022 Signature for this request is not valid`.
 */

import crypto from 'node:crypto';

/** Percent-encode a single value the way Node's URLSearchParams does (& = %26, space = %20). */
export function encodeValue(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Build the canonical query string (sorted by key, percent-encoded). */
export function encodeQuery(params = {}) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeValue(k)}=${encodeValue(v)}`)
    .join('&');
}

/** HMAC-SHA256 hex signature of a query string. */
export function signQuery(query, apiSecret) {
  return crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
}

/** Append the signature to a signed query. */
export function signedQuery(params, apiSecret, { timestamp, recvWindow = 5000 } = {}) {
  if (!Number.isFinite(timestamp)) throw new Error('signedQuery: chýba timestamp.');
  const base = encodeQuery({ ...params, timestamp, recvWindow });
  return `${base}&signature=${signQuery(base, apiSecret)}`;
}

/** Mask an API key for display/storage: ABCD...WXYZ (never the full key). */
export function maskApiKey(apiKey) {
  const key = String(apiKey ?? '');
  if (key.length <= 8) return `${key.slice(0, 2)}...${key.slice(-2)}`;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/** Stable, non-reversible fingerprint used to recognise a key without storing it. */
export function fingerprintApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}