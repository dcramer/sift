import { createContext, useContext } from 'react';
import type { Confidential } from '@/lib/api.ts';

/** One item of a list a message is opened from. */
export interface MessageRef {
  /** `''` when only its id is known, as from the address. */
  accountId: string;
  messageId: string;
  /** Null when the list it was opened from does not know it. */
  subject: Confidential | null;
  /** Opened as a conversation (Inbox), whose newest message `messageId` is. */
  threadId?: string;
}

/** Opens the reader on `items[index]`, stepping through `items`. */
export type OpenMessages = (items: MessageRef[], index: number) => void;

/** Given by the dashboard's frame, which holds the reader, to every screen in it. */
export const OpenMessagesContext = createContext<OpenMessages>(() => {});

export const useOpenMessages = () => useContext(OpenMessagesContext);
