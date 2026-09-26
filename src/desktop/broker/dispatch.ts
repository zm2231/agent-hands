import { COMPUTER_USE_PLUGIN_ROOT, type BrokerComponents } from "./verify.js";
import { acquireSession } from "./pool.js";
import type { ContentBlock } from "../../kernel/types.js";

const MAX_RESULT_BYTES = 25 * 1024 * 1024;

export type Resolver = (state: ContentBlock[], args: Record<string, unknown>) =>
  | { args: Record<string, unknown>; note: string }
  | { error: string };

export interface FollowUpCall {
  tool: string;
  arguments: Record<string, unknown>;
  keepImages?: boolean;
  resolve?: Resolver;
}

function withImages(content: ContentBlock[], keep: boolean | undefined): ContentBlock[] {
  return keep === false ? content.filter((b) => b.type !== "image") : content;
}

export interface BrokerResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  modelTurnsStarted: number;
  ephemeralThread: boolean;
  followUpResults?: BrokerResult[];
  contentOmitted?: boolean;
  note?: string;
  directCalls: number;
  elicitationRequests: number;
}

export function applyAggregateBudget(
  primaryContentBytes: number,
  followUpResults: BrokerResult[],
  maxAggregateBytes: number = 25 * 1024 * 1024
): BrokerResult[] {
  let aggregateBytes = primaryContentBytes;
  return followUpResults.map((fu) => {
    const fuContentBytes = Buffer.byteLength(JSON.stringify(fu.content), "utf8");
    const overBudget = aggregateBytes + fuContentBytes > maxAggregateBytes;
    if (!overBudget) {
      aggregateBytes += fuContentBytes;
      return fu;
    }
    return {
      ...fu,
      content: [{ type: "text", text: "[content omitted \u2014 aggregate response budget exceeded]" } as ContentBlock],
      contentOmitted: true,
    };
  });
}

export async function brokerDispatch(
  components: BrokerComponents,
  method: string,
  args: Record<string, unknown>,
  options: {
    signal?: AbortSignal;
    toolTimeoutMs?: number;
    onElicitation?: (params: Record<string, unknown>) => Promise<{ action: string }>;
    followUpCalls?: FollowUpCall[];
    continueOnError?: boolean;
    requireActivationFor?: string;
    keepImages?: boolean;
    resolve?: Resolver;
  } = {}
): Promise<BrokerResult> {
  const lease = await acquireSession(components);

  try {
    const session = lease.session;
    let directCalls = 0;
    let elicitationRequests = 0;
    let modelTurnsStarted = 0;
    let lastState: ContentBlock[] | null = null;

    const run = async (tool: string, toolArgs: Record<string, unknown>) => {
      const result = await session.call(tool, toolArgs, {
        signal: options.signal,
        timeoutMs: options.toolTimeoutMs,
        onElicitation: options.onElicitation,
      });
      directCalls++;
      elicitationRequests += result.elicitationRequests;
      modelTurnsStarted += result.modelTurnsStarted;
      lastState = tool === "get_app_state" && !result.isError ? result.content : null;
      if (tool === "get_app_state" && typeof toolArgs.app === "string" && !result.isError) {
        session.markAppActivated(toolArgs.app);
      }
      return result;
    };

    const execute = async (
      tool: string,
      toolArgs: Record<string, unknown>,
      resolve: Resolver | undefined,
    ): Promise<{ content: ContentBlock[]; isError: boolean; note?: string }> => {
      if (!resolve) return run(tool, toolArgs);
      const state = lastState ?? await (async () => {
        const fresh = await run("get_app_state", { app: toolArgs.app });
        return fresh.isError ? null : fresh.content;
      })();
      if (!state) return { content: [{ type: "text", text: "Could not read app state to resolve the target." }], isError: true };
      const resolved = resolve(state, toolArgs);
      if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], isError: true };
      const result = await run(tool, resolved.args);
      return { content: result.content, isError: result.isError, note: resolved.note };
    };

    if (options.requireActivationFor && !options.resolve && !session.isAppActivated(options.requireActivationFor)) {
      const activation = await run("get_app_state", { app: options.requireActivationFor });
      if (activation.isError) {
        return {
          content: withImages(activation.content, options.keepImages),
          isError: true,
          modelTurnsStarted,
          ephemeralThread: activation.ephemeralThread,
          followUpResults: [],
          directCalls,
          elicitationRequests,
        };
      }
    }

    const primary = await execute(method, args, options.resolve);
    const content = withImages(primary.content, options.keepImages);
    const isError = primary.isError;

    const MAX_AGGREGATE_BYTES = 25 * 1024 * 1024;
    let aggregateContentBytes = Buffer.byteLength(JSON.stringify(content), "utf8");
    const followUpResults: BrokerResult[] = [];
    const shouldRunFollowUps = options.followUpCalls?.length &&
      (!isError || options.continueOnError) &&
      !(method === "get_app_state" && isError);

    if (shouldRunFollowUps) {
      for (const followUp of options.followUpCalls!) {
        const before = { directCalls, elicitationRequests };
        const fuResult = await execute(followUp.tool, followUp.arguments, followUp.resolve);
        const fuContent = withImages(fuResult.content, followUp.keepImages);
        const fuIsError = fuResult.isError;
        const fuContentBytes = Buffer.byteLength(JSON.stringify(fuContent), "utf8");

        if (fuContentBytes > MAX_RESULT_BYTES) {
          throw new Error("Follow-up result exceeds 25 MB limit.");
        }

        const overBudget = aggregateContentBytes + fuContentBytes > MAX_AGGREGATE_BYTES;
        followUpResults.push({
          content: overBudget
            ? [{ type: "text", text: "[content omitted \u2014 aggregate response budget exceeded]" } as ContentBlock]
            : fuContent,
          isError: fuIsError,
          modelTurnsStarted: 0,
          ephemeralThread: true,
          ...(overBudget ? { contentOmitted: true } : {}),
          ...(fuResult.note ? { note: fuResult.note } : {}),
          directCalls: directCalls - before.directCalls,
          elicitationRequests: elicitationRequests - before.elicitationRequests,
        });
        if (!overBudget) aggregateContentBytes += fuContentBytes;

        if (fuIsError && !options.continueOnError) break;
      }
    }

    return {
      content,
      isError,
      modelTurnsStarted,
      ephemeralThread: true,
      followUpResults,
      ...(primary.note ? { note: primary.note } : {}),
      directCalls,
      elicitationRequests,
    };
  } finally {
    lease.release();
  }
}

export { closePool } from "./pool.js";
