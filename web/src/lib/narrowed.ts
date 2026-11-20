import { createContext } from 'react';

/** The mailbox what is shown is narrowed to, `''` for all of them. Every read under it asks for that mailbox alone (`useLoaded`). */
export const Mailbox = createContext('');
