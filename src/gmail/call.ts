import { clientRequest, traced } from '../telemetry.ts';
import type { Pace } from './quota.ts';

/** Each Gmail method Sift calls: how it is sent, and its path with the ids in it left as names. */
const ROUTES = {
  'users.getProfile': ['GET', '/users/me/profile'],
  'users.history.list': ['GET', '/users/me/history'],
  'users.messages.list': ['GET', '/users/me/messages'],
  'users.messages.get': ['GET', '/users/me/messages/{id}'],
  'users.messages.modify': ['POST', '/users/me/messages/{id}/modify'],
  'users.messages.insert': ['POST', '/users/me/messages'],
  'users.messages.send': ['POST', '/users/me/messages/send'],
  'users.threads.get': ['GET', '/users/me/threads/{id}'],
  'users.labels.list': ['GET', '/users/me/labels'],
  'users.labels.get': ['GET', '/users/me/labels/{id}'],
  'users.labels.create': ['POST', '/users/me/labels'],
  'users.settings.sendAs.list': ['GET', '/users/me/settings/sendAs'],
  'users.settings.filters.list': ['GET', '/users/me/settings/filters'],
  'users.settings.filters.create': ['POST', '/users/me/settings/filters'],
  'users.settings.filters.delete': ['DELETE', '/users/me/settings/filters/{id}'],
} as const;

/** One Gmail request, by the API's name for its method and what it costs of the quota. */
export type Call = <T>(method: keyof typeof ROUTES, units: number, request: () => Promise<{ data: T; status: number }>) => Promise<T>;

export const isNotFound = (error: unknown) => {
  const e = error as { status?: unknown; code?: unknown };
  return e?.status === 404 || e?.code === 404 || e?.code === '404';
};

export const isConflict = (error: unknown) => {
  const e = error as { status?: unknown; code?: unknown };
  return e?.status === 409 || e?.code === 409 || e?.code === '409';
};

/** Gmail compares label names without case: "Sift/news" is the label "sift/news", and creating one beside the other is refused. */
export const labelKey = (name: string) => name.toLowerCase();

/**
 * Requests that each wait their turn under the mailbox's quota, then go as an `http.client` span named by
 * the method's path with its ids left out, since they name the message. A 404 is an answer (the message
 * is gone), not a failure.
 */
export const calls =
  (pace: Pace): Call =>
  async (method, units, request) => {
    await pace(units);
    const [verb, path] = ROUTES[method];
    const { name, attributes } = clientRequest(verb, 'https://gmail.googleapis.com', `/gmail/v1${path}`);
    const settled = await traced('http.client', name, { ...attributes, 'sift.quota_units': units }, async (span) => {
      try {
        const response = await request();
        span.set({ 'http.response.status_code': response.status });
        return { data: response.data };
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (typeof status === 'number') span.set({ 'http.response.status_code': status });
        if (!isNotFound(error)) {
          span.set({ 'error.type': typeof status === 'number' ? String(status) : error instanceof Error ? error.constructor.name : typeof error });
          span.fail();
        }
        return { error };
      }
    });
    if ('error' in settled) throw settled.error;
    return settled.data;
  };
