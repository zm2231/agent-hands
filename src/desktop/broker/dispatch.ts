import { COMPUTER_USE_PLUGIN_ROOT, type BrokerComponents } from "./verify.js";
import { acquireSession } from "./pool.js";
import type { ContentBlock } from "../../kernel/types.js";

const MAX_RESULT_BYTES = 25 * 1024 * 1024;

export interface FollowUpCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface BrokerResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  modelTurnsStarted: number;
  ephemeralThread: boolean;
  followUpResults?: BrokerResult[];
  contentOmitted?: boolean;
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
  } = {}
): Promise<BrokerResult> {
  const lease = await acquireSession(components);

  try {
    const session = lease.session;
    const primary = await session.call(method, args, {
      signal: options.signal,
      timeoutMs: options.toolTimeoutMs,
      onElicitation: options.onElicitation,
    });

    const content = primary.content;
    const isError = primary.isError;

    const MAX_AGGREGATE_BYTES = 25 * 1024 * 1024;
    let aggregateContentBytes = Buffer.byteLength(JSON.stringify(content), "utf8");
    const followUpResults: BrokerResult[] = [];
    const shouldRunFollowUps = options.followUpCalls?.length &&
      (!isError || options.continueOnError);

    if (shouldRunFollowUps) {
      for (const followUp of options.followUpCalls!) {
        const fuResult = await session.call(followUp.tool, followUp.arguments, {
          signal: options.signal,
          timeoutMs: options.toolTimeoutMs,
          onElicitation: options.onElicitation,
        });

        const fuContent = fuResult.content;
        const fuIsError = fuResult.isError;
        const fuContentBytes = Buffer.byteLength(JSON.stringify(fuContent), "utf8");

        if (fuContentBytes > MAX_RESULT_BYTES) {
          throw new Error("Follow-up result exceeds 25 MB limit.");
        }

        const overBudget = aggregateContentBytes + fuContentBytes > MAX_AGGREGATE_BYTES;
        followUpResults.push(overBudget
          ? {
              content: [{ type: "text", text: "[content omitted \u2014 aggregate response budget exceeded]" } as ContentBlock],
              isError: fuIsError,
              modelTurnsStarted: 0,
              ephemeralThread: true,
              contentOmitted: true,
            }
          : {
              content: fuContent,
              isError: fuIsError,
              modelTurnsStarted: 0,
              ephemeralThread: true,
            }
        );
        if (!overBudget) aggregateContentBytes += fuContentBytes;

        if (fuIsError && !options.continueOnError) break;
      }
    }

    return {
      content,
      structuredContent: primary.structuredContent,
      isError,
      modelTurnsStarted: primary.modelTurnsStarted,
      ephemeralThread: true,
      followUpResults,
    };
  } finally {
    lease.release();
  }
}

export { closePool } from "./pool.js";
