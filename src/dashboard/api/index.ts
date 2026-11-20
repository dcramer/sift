import type { Frame, Read, Write } from './route.ts';
import accountDeleteWrite from './routes/account/delete/post.ts';
import activeWrite from './routes/active/post.ts';
import checkWrite from './routes/check/post.ts';
import contactsRead from './routes/contacts/get.ts';
import decisionsRead from './routes/decisions/get.ts';
import digestWrite from './routes/digest/post.ts';
import domainRead from './routes/domain/get.ts';
import evalRead from './routes/eval/get.ts';
import evalsRead from './routes/evals/get.ts';
import evalsRunWrite from './routes/evals/run/post.ts';
import examplesDeleteAllWrite from './routes/examples/delete-all/post.ts';
import examplesDeleteWrite from './routes/examples/delete/post.ts';
import examplesRead from './routes/examples/get.ts';
import feedbackWrite from './routes/feedback/post.ts';
import inboxRead from './routes/inbox/get.ts';
import inboxStartWrite from './routes/inbox/start/post.ts';
import inboxStopWrite from './routes/inbox/stop/post.ts';
import labelsAcceptWrite from './routes/labels/accept/post.ts';
import labelsAddWrite from './routes/labels/add/post.ts';
import labelsWrite from './routes/labels/post.ts';
import labelsProposalRead from './routes/labels/proposal/get.ts';
import labelsProposeWrite from './routes/labels/propose/post.ts';
import labelsRemoveWrite from './routes/labels/remove/post.ts';
import mailAskWrite from './routes/mail/ask/post.ts';
import mailChangeWrite from './routes/mail/change/post.ts';
import mailOnWrite from './routes/mail/on/post.ts';
import mailReachRead from './routes/mail/reach/get.ts';
import mailThreadRead from './routes/mail/thread/get.ts';
import mailThreadsRead from './routes/mail/threads/get.ts';

import mailSendWrite from './routes/mail/send/post.ts';
import mailboxPrimaryWrite from './routes/mailbox/primary/post.ts';
import mailboxRemoveWrite from './routes/mailbox/remove/post.ts';
import manageRead from './routes/manage/get.ts';
import messageRead from './routes/message/get.ts';
import messageHtmlFrame from './routes/message/html/frame.ts';
import modelChatgptFinishWrite from './routes/model/chatgpt/finish/post.ts';
import modelChatgptWrite from './routes/model/chatgpt/post.ts';
import modelKeyWrite from './routes/model/key/post.ts';
import modelWrite from './routes/model/post.ts';
import modelReasoningWrite from './routes/model/reasoning/post.ts';
import modelSignoutWrite from './routes/model/signout/post.ts';
import modelsRead from './routes/models/get.ts';
import proposalsWrite from './routes/proposals/post.ts';
import rulesApplyWrite from './routes/rules/apply/post.ts';
import rulesDraftWrite from './routes/rules/draft/post.ts';
import rulesEditWrite from './routes/rules/edit/post.ts';
import rulesFilterWrite from './routes/rules/filter/post.ts';
import rulesInboxRead from './routes/rules/inbox/get.ts';
import rulesRead from './routes/rules/get.ts';
import rulesWrite from './routes/rules/post.ts';
import rulesRemoveWrite from './routes/rules/remove/post.ts';
import rulesUsageRead from './routes/rules/usage/get.ts';
import rulesWaitingRead from './routes/rules/waiting/get.ts';
import senderRead from './routes/sender/get.ts';
import standingClearWrite from './routes/standing/clear/post.ts';
import standingWrite from './routes/standing/post.ts';
import suggestionRead from './routes/suggestion/get.ts';
import suggestionsRead from './routes/suggestions/get.ts';
import summaryRead from './routes/summary/get.ts';
import undoWrite from './routes/undo/post.ts';
import usageRead from './routes/usage/get.ts';

/**
 * Every route under `/api/`, each its own module at `routes/<path>/<get|post|frame>.ts`. The server applies
 * the session, the scope and the write checks to all of them.
 */
export const READS: readonly Read[] = [
  contactsRead,
  decisionsRead,
  domainRead,
  evalRead,
  evalsRead,
  examplesRead,
  inboxRead,
  labelsProposalRead,
  mailReachRead,
  mailThreadRead,
  mailThreadsRead,
  manageRead,
  messageRead,
  modelsRead,
  rulesRead,
  rulesInboxRead,
  rulesUsageRead,
  rulesWaitingRead,
  senderRead,
  suggestionRead,
  suggestionsRead,
  summaryRead,
  usageRead,
];
export const WRITES: readonly Write[] = [
  accountDeleteWrite,
  activeWrite,
  checkWrite,
  digestWrite,
  evalsRunWrite,
  examplesDeleteWrite,
  examplesDeleteAllWrite,
  feedbackWrite,
  inboxStartWrite,
  inboxStopWrite,
  labelsWrite,
  labelsAddWrite,
  labelsAcceptWrite,
  labelsProposeWrite,
  labelsRemoveWrite,
  mailAskWrite,
  mailChangeWrite,
  mailOnWrite,
  mailSendWrite,

  mailboxPrimaryWrite,
  mailboxRemoveWrite,
  modelWrite,
  modelChatgptWrite,
  modelChatgptFinishWrite,
  modelKeyWrite,
  modelReasoningWrite,
  modelSignoutWrite,
  proposalsWrite,
  rulesWrite,
  rulesApplyWrite,
  rulesDraftWrite,
  rulesEditWrite,
  rulesFilterWrite,
  rulesRemoveWrite,
  standingClearWrite,
  standingWrite,
  undoWrite,
];
export const FRAMES: readonly Frame[] = [messageHtmlFrame];
