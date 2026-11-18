import { toolCalls } from '@open-foresight/db';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z, type ZodTypeAny } from 'zod';

export type ToolDefinition<T extends ZodTypeAny = ZodTypeAny> = {
  name: string;
  input: T;
  execute: (input: z.infer<T>) => Promise<{ result: unknown; resultIds: string[] }>;
};

type Turn =
  | { kind: 'final'; value: unknown; llmCallId: string; cost: number }
  | { kind: 'tool'; name: string; input: unknown; llmCallId: string; cost: number };

type TranscriptEntry = { name: string; input: unknown; result: unknown };

export async function runToolLoop<T extends ZodTypeAny>(options: {
  db: PostgresJsDatabase;
  tools: ToolDefinition[];
  output: T;
  maxTurns: number;
  maxToolCalls: number;
  budget: number;
  turn: (input: { transcript: readonly TranscriptEntry[]; remainingBudget: number }) => Promise<Turn>;
}): Promise<z.infer<T>> {
  const { maxTurns, maxToolCalls, budget } = options;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0 || !Number.isFinite(budget) || budget <= 0) throw new Error('Invalid loop limits');
  const tools = new Map(options.tools.map(tool => [tool.name, tool]));
  if (tools.size !== options.tools.length) throw new Error('Duplicate tool name');
  const transcript: TranscriptEntry[] = [];
  let remainingBudget = budget;
  for (let i = 0; i < maxTurns; i++) {
    if (remainingBudget <= 0) throw new Error('Budget limit reached');
    const turn = await options.turn({ transcript, remainingBudget });
    if (!Number.isFinite(turn.cost) || turn.cost < 0 || turn.cost > remainingBudget) throw new Error('Budget limit exceeded');
    remainingBudget -= turn.cost;
    if (turn.kind === 'final') return options.output.parse(turn.value);
    if (transcript.length >= maxToolCalls) throw new Error('Tool call limit reached');
    const tool = tools.get(turn.name);
    if (!tool) throw new Error(`Unknown tool: ${turn.name}`);
    const input = tool.input.parse(turn.input);
    let result: { result: unknown; resultIds: string[] };
    try {
      result = await tool.execute(input);
    } catch (error) {
      await options.db.insert(toolCalls).values({ llmCallId: turn.llmCallId, tool: turn.name, args: input, resultIds: [], error: { message: error instanceof Error ? error.message : 'Tool failed' } });
      throw error;
    }
    await options.db.insert(toolCalls).values({ llmCallId: turn.llmCallId, tool: turn.name, args: input, resultIds: result.resultIds });
    transcript.push({ name: turn.name, input, result: result.result });
  }
  throw new Error('Turn limit reached');
}

const actionSchema = z.object({ kind: z.enum(['final', 'tool']), name: z.string(), input: z.string(), value: z.string() }).strict();
type Generate = (input: {
  runId: string; role: string; promptVersion: string; system: string; user: string;
  schemaName: string; schema: typeof actionSchema; inputEvidenceIds: string[];
  maxOutputTokens: number; onAudit: (id: string) => void;
}) => Promise<z.infer<typeof actionSchema>>;

/** Budget is the maximum reserved output tokens, including possible retry and repair calls. */
export async function runAgent<T extends ZodTypeAny>(options: {
  db: PostgresJsDatabase;
  gateway: { generate: Generate };
  runId: string;
  role: string;
  promptVersion: string;
  system: string;
  user: string;
  inputEvidenceIds: string[];
  tools: ToolDefinition[];
  output: T;
  maxTurns: number;
  maxToolCalls: number;
  outputTokenBudget: number;
  maxOutputTokens: number;
}): Promise<z.infer<T>> {
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || !Number.isSafeInteger(options.outputTokenBudget) || options.outputTokenBudget < 1) throw new Error('Invalid token budget');
  const reservation = 3 * options.maxOutputTokens;
  if (!Number.isSafeInteger(reservation)) throw new Error('Invalid token budget');
  const { zodToJsonSchema } = await import('zod-to-json-schema');
  const descriptions = options.tools.map(tool => ({ name: tool.name, input: zodToJsonSchema(tool.input, { $refStrategy: 'none' }) }));
  return runToolLoop({
    db: options.db, tools: options.tools, output: options.output, maxTurns: options.maxTurns,
    maxToolCalls: options.maxToolCalls, budget: options.outputTokenBudget,
    turn: async ({ transcript, remainingBudget }) => {
      if (remainingBudget < reservation) throw new Error('Budget limit reached');
      let llmCallId = '';
      const action = await options.gateway.generate({
        runId: options.runId, role: options.role, promptVersion: options.promptVersion,
        system: `${options.system}\nChoose a tool or final answer. Encode tool input or final value as JSON in the corresponding string field. Set unused fields to empty strings. Tools: ${JSON.stringify(descriptions)}. Final output schema: ${JSON.stringify(zodToJsonSchema(options.output, { $refStrategy: 'none' }))}`,
        user: JSON.stringify({ request: options.user, transcript }), schemaName: 'agent_action', schema: actionSchema,
        inputEvidenceIds: options.inputEvidenceIds, maxOutputTokens: options.maxOutputTokens,
        onAudit: id => { llmCallId = id; },
      });
      if (!llmCallId) throw new Error('Missing model call audit');
      return action.kind === 'final'
        ? { kind: 'final', value: JSON.parse(action.value), llmCallId, cost: reservation }
        : { kind: 'tool', name: action.name, input: JSON.parse(action.input), llmCallId, cost: reservation };
    },
  });
}
