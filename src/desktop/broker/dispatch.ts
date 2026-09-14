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
  } = {}
): Promise<BrokerResult> {
  const lease = await acquireSession(components);

  try {
    const session = lease.session;
    let directCalls = 0;
    let elicitationRequests = 0;
    if (options.requireActivationFor && !session.isAppActivated(options.requireActivationFor)) {
      const activation = await session.call("get_app_state", { app: options.requireActivationFor }, {
        signal: options.signal,
        timeoutMs: options.toolTimeoutMs,
        onElicitation: options.onElicitation,
      });
      directCalls++;
      elicitationRequests += activation.elicitationRequests;
      if (activation.isError) {
        return {
          content: activation.content,
          structuredContent: activation.structuredContent,
          isError: true,
          modelTurnsStarted: activation.modelTurnsStarted,
          ephemeralThread: activation.ephemeralThread,
          followUpResults: [],
          directCalls,
          elicitationRequests,
        };
      }
      session.markAppActivated(options.requireActivationFor);
    }
    const primary = await session.call(method, args, {
      signal: options.signal,
      timeoutMs: options.toolTimeoutMs,
      onElicitation: options.onElicitation,
    });
    directCalls++;
    elicitationRequests += primary.elicitationRequests;
    if (method === "get_app_state" && typeof args.app === "string" && !primary.isError) {
      session.markAppActivated(args.app);
    }

    const content = primary.content;
    const isError = primary.isError;

    const MAX_AGGREGATE_BYTES = 25 * 1024 * 1024;
    let aggregateContentBytes = Buffer.byteLength(JSON.stringify(content), "utf8");
    const followUpResults: BrokerResult[] = [];
    const shouldRunFollowUps = options.followUpCalls?.length &&
      (!isError || options.continueOnError) &&
      !(method === "get_app_state" && isError);

    if (shouldRunFollowUps) {
      for (const followUp of options.followUpCalls!) {
        const fuResult = await session.call(followUp.tool, followUp.arguments, {
          signal: options.signal,
          timeoutMs: options.toolTimeoutMs,
          onElicitation: options.onElicitation,
        });
        directCalls++;
        elicitationRequests += fuResult.elicitationRequests;
        if (followUp.tool === "get_app_state" && typeof followUp.arguments.app === "string" && !fuResult.isError) {
          session.markAppActivated(followUp.arguments.app);
        }

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
              directCalls: 1,
              elicitationRequests: fuResult.elicitationRequests,
            }
          : {
              content: fuContent,
              isError: fuIsError,
              modelTurnsStarted: 0,
              ephemeralThread: true,
              directCalls: 1,
              elicitationRequests: fuResult.elicitationRequests,
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
      directCalls,
      elicitationRequests,
    };
  } finally {
    lease.release();
  }
}

export { closePool } from "./pool.js";
