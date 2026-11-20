import type { Api, AssistantMessage, Context, Model, Models, Tool, ToolCall } from '@earendil-works/pi-ai';
import { ASK_PROMPT, ASK_TOOL, type MailAsker, VIEW_WORDS, buildAskPrompt, readMailFilter } from '../triage/mail-ask.ts';
import { FIND_TOOL, type FoundSender, MAX_LOOKUPS, describeFound } from '../triage/rule-draft.ts';
import type { Usage } from '../triage/stages/model.ts';
import { describeFailure as failure } from '../triage/stages/model.ts';
import { chat, executeTool } from './chat.ts';
import type { Reasoning } from './reasoning.ts';

/** One attempt per turn, as for the rule drafter; the person asks again. */
const CALL = { timeoutMs: 60_000, maxRetries: 0 };

/** Turns that may end without a usable filter: one more after an unusable one, told what is wrong, or after an answer in words. */
const MAX_FILLS = 2;

const find: Tool = {
  name: FIND_TOOL,
  description: 'Find senders Sift has recorded mail from, by words in their name, address, mailing list or newest subject.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'A name, brand, domain or a few words.' } },
    required: ['query'],
    additionalProperties: false,
  },
};

function narrow(labels: readonly string[]): Tool {
  const strings = { type: 'array', items: { type: 'string' } } as const;
  return {
    name: ASK_TOOL,
    description: 'Narrow the list of conversations.',
    parameters: {
      type: 'object',
      // Written first, as the rule drafter's reading is, so the rest follows from it.
      properties: {
        reading: { type: 'string', description: 'A sentence: which conversations they mean.' },
        from: { ...strings, description: 'Addresses a look-up returned.' },
        domains: { ...strings, description: 'Domains of senders a look-up returned, for everyone there.' },
        label: { type: 'string', enum: ['', ...labels] },
        view: { type: 'string', enum: VIEW_WORDS },
        unread: { type: 'boolean' },
        since: { type: 'string', description: 'YYYY-MM-DD, or empty.' },
        words: { ...strings, description: 'Words one message must have, every one, in its text, sender or subject.' },
        note: { type: 'string', description: 'What of what they asked the list cannot narrow by; empty if nothing.' },
      },
      required: ['reading', 'from', 'domains', 'label', 'view', 'unread', 'since', 'words', 'note'],
      additionalProperties: false,
    },
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
  };
}

const add = (a: Usage | undefined, b: Usage): Usage =>
  a ? { model: b.model, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd } : b;

/**
 * A MailAsker backed by a pi-ai model: a conversation of a few turns with the person's words and labels, and two
 * tools. One looks up senders in the person's own record and changes nothing; the other records the filter, which is
 * checked here against what the look-ups returned, and sent back once with what is wrong when it cannot be used.
 */
export function createMailAsker(models: Models, model: Model<Api>, reasoning: Reasoning): MailAsker {
  return async (input, findSenders) => {
    const record = narrow(input.labels.map((l) => l.name));
    const context: Context = {
      systemPrompt: ASK_PROMPT,
      messages: [{ role: 'user', content: buildAskPrompt(input), timestamp: Date.now() }],
    };
    const found: FoundSender[] = [];
    let usage: Usage | undefined;
    let lookups = 0;
    let fills = 0;
    const spent = () => ({ lookups, ...(usage ? { usage } : {}) });
    for (;;) {
      const last = lookups >= MAX_LOOKUPS;
      let message: AssistantMessage;
      try {
        message = await chat(models, model, { ...context, tools: last ? [record] : [find, record] }, { ...CALL, reasoning });
      } catch (error) {
        return { failed: failure(error), ...spent() };
      }
      usage = add(usage, {
        model: `${model.provider}/${model.id}`,
        inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
        outputTokens: message.usage.output,
        costUsd: message.usage.cost.total,
      });
      if (message.stopReason === 'error' || message.stopReason === 'aborted')
        return { failed: failure(message.errorMessage ?? message.stopReason), ...spent() };
      const calls = message.content.filter((block): block is ToolCall => block.type === 'toolCall');
      const filled = calls.find((c) => c.name === ASK_TOOL);
      let unusable: string | undefined;
      if (filled) {
        const read = await executeTool(ASK_TOOL, filled.id, async (span) => {
          const result = readMailFilter(filled.arguments, input, found);
          if ('unusable' in result) span.fail();
          return result;
        });
        if ('answer' in read) return { ...read.answer, ...spent() };
        unusable = read.unusable;
        fills += 1;
        if (fills >= MAX_FILLS) return { failed: `the model did not make a usable filter: ${unusable}`, ...spent() };
      }
      const asked = calls.filter((c) => c.name === FIND_TOOL);
      if (!filled && (last || asked.length === 0)) {
        fills += 1;
        if (fills >= MAX_FILLS || calls.length > 0) return { failed: 'the model did not make a filter', ...spent() };
        context.messages.push(message, { role: 'user', content: `Narrow the list with ${ASK_TOOL}.`, timestamp: Date.now() });
        continue;
      }
      context.messages.push(message);
      if (filled)
        context.messages.push({
          role: 'toolResult',
          toolCallId: filled.id,
          toolName: ASK_TOOL,
          content: [{ type: 'text', text: `That filter cannot be used: ${unusable}. Call ${ASK_TOOL} again.` }],
          isError: true,
          timestamp: Date.now(),
        });
      for (const c of asked) {
        lookups += 1;
        const query = typeof c.arguments['query'] === 'string' ? c.arguments['query'] : '';
        const text =
          lookups > MAX_LOOKUPS
            ? `No more look-ups: call ${ASK_TOOL}.`
            : await executeTool(FIND_TOOL, c.id, async () => {
                const senders = await findSenders(query);
                found.push(...senders);
                return describeFound(senders);
              });
        context.messages.push({
          role: 'toolResult',
          toolCallId: c.id,
          toolName: FIND_TOOL,
          content: [{ type: 'text', text }],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }
  };
}
