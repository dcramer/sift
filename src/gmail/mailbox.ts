import { gmail } from '@googleapis/gmail';
import type { OAuth2Client } from 'google-auth-library';
import { validateFilter } from '../actions/filters.ts';
import type { Mailbox } from '../actions/mailbox.ts';
import { calls, isConflict, isNotFound, labelKey } from './call.ts';
import type { Pace } from './quota.ts';

/** Gmail implementation of the Mailbox port. Deliberately has no forward, trash or delete. Calls are paced as `createGmailApi`'s are. */
export function createGmailMailbox(auth: OAuth2Client, pace: Pace): Mailbox {
  const client = gmail({ version: 'v1', auth });
  const userId = 'me';
  const call = calls(pace);
  let labelIdsByName: Map<string, string> | null = null;
  const listLabelIds = async () => {
    const data = await call('users.labels.list', 1, () => client.users.labels.list({ userId }));
    return new Map((data.labels ?? []).flatMap((l) => (l.name && l.id ? [[labelKey(l.name), l.id] as const] : [])));
  };

  return {
    async getLabelIds(messageId) {
      try {
        // `minimal` returns labels without headers or body and does not mark the message read.
        const data = await call('users.messages.get', 20, () => client.users.messages.get({ userId, id: messageId, format: 'minimal' }));
        return data.labelIds ?? [];
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async modifyLabels(messageId, change) {
      const data = await call('users.messages.modify', 5, () =>
        client.users.messages.modify({ userId, id: messageId, requestBody: { addLabelIds: change.add, removeLabelIds: change.remove } }),
      );
      return data.labelIds ?? [];
    },

    async ensureLabel(name) {
      labelIdsByName ??= await listLabelIds();
      const existing = labelIdsByName.get(labelKey(name));
      if (existing) return existing;
      try {
        const data = await call('users.labels.create', 5, () =>
          client.users.labels.create({ userId, requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } }),
        );
        if (!data.id) throw new Error(`Gmail did not return an id for label ${name}`);
        labelIdsByName.set(labelKey(name), data.id);
        return data.id;
      } catch (error) {
        // Made since the list was read: by another pass, or by the person in Gmail.
        if (!isConflict(error)) throw error;
        labelIdsByName = await listLabelIds();
        const made = labelIdsByName.get(labelKey(name));
        if (made) return made;
        throw error;
      }
    },

    async hasSentTo(address) {
      // The address goes into a search query, so refuse anything that could change the query's meaning.
      if (!/^[^\s"'(){}<>:,]+@[^\s"'(){}<>:,]+$/.test(address)) throw new Error('address cannot be searched safely');
      const data = await call('users.messages.list', 5, () => client.users.messages.list({ userId, q: `in:sent to:${address}`, maxResults: 1 }));
      return (data.messages ?? []).length > 0;
    },

    async createFilter(filter) {
      // Checked here as well as by callers: nothing reaches Gmail's filter API unvalidated.
      const problems = validateFilter(filter);
      if (problems.length > 0) throw new Error(`Refusing to create filter: ${problems.join('; ')}`);
      const data = await call('users.settings.filters.create', 5, () =>
        client.users.settings.filters.create({ userId, requestBody: { criteria: filter.criteria, action: filter.action } }),
      );
      if (!data.id) throw new Error('Gmail did not return a filter id');
      return data.id;
    },

    async deleteFilter(filterId) {
      try {
        await call('users.settings.filters.delete', 5, () => client.users.settings.filters.delete({ userId, id: filterId }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    async insertMessage(raw, labelIds) {
      const data = await call('users.messages.insert', 25, () =>
        client.users.messages.insert({
          userId,
          // Dated when Gmail takes it, so it sorts as the newest mail in the inbox.
          internalDateSource: 'receivedTime',
          requestBody: { raw: Buffer.from(raw).toString('base64url'), labelIds: [...labelIds] },
        }),
      );
      if (!data.id) throw new Error('Gmail did not return an id for the inserted message');
      return { id: data.id, labelIds: data.labelIds ?? [] };
    },

    async send({ raw, threadId }) {
      const data = await call('users.messages.send', 100, () =>
        client.users.messages.send({ userId, requestBody: { raw: Buffer.from(raw).toString('base64url'), ...(threadId ? { threadId } : {}) } }),
      );
      if (!data.id || !data.threadId) throw new Error('Gmail did not return an id for the sent message');
      return { id: data.id, threadId: data.threadId, labelIds: data.labelIds ?? [] };
    },

    async findByMessageId(messageId) {
      // It goes into a search query, so refuse anything that could change the query's meaning.
      if (!/^<[\w.-]+@[\w.-]+>$/.test(messageId)) throw new Error('message id cannot be searched safely');
      const data = await call('users.messages.list', 5, () =>
        client.users.messages.list({ userId, q: `rfc822msgid:${messageId}`, includeSpamTrash: true, maxResults: 1 }),
      );
      const [found] = data.messages ?? [];
      return found?.id && found.threadId ? { id: found.id, threadId: found.threadId } : null;
    },

    async listFilters() {
      const data = await call('users.settings.filters.list', 1, () => client.users.settings.filters.list({ userId }));
      return (data.filter ?? []).flatMap((f) => {
        if (!f.id) return [];
        const criteria: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(f.criteria ?? {})) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') criteria[key] = value;
        }
        return [
          {
            id: f.id,
            criteria,
            action: {
              addLabelIds: f.action?.addLabelIds ?? [],
              removeLabelIds: f.action?.removeLabelIds ?? [],
              ...(f.action?.forward ? { forward: f.action.forward } : {}),
            },
          },
        ];
      });
    },
  };
}
