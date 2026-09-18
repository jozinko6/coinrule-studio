/**
 * backend-session.js — one in-RAM backend client shared by all views.
 * The admin token lives only inside that client instance; nothing is persisted.
 */

let client = null;

export function setBackendClient(next) { client = next ?? null; }
export function getBackendClient() { return client; }
export function clearBackendClient() { client = null; }
