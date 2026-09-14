/**
 * Bridge-owned Telegram activity verbosity projection
 * Zones: telegram activity, rich rendering, operational delivery
 * Owns persistent bounded thinking and tool disclosures; excludes activity normalization, assistant answer rendering, and transport authority policy
 */


import {
  escapeHtml,
  renderTelegramInlineMarkdownHtml,
} from "./rendering.ts";
import type {
  TelegramInputRichBlock,
  TelegramInputRichMessage,
} from "./telegram-api.ts";

export const TELEGRAM_ACTIVITY_DETAIL_MAX_CHARS = 1_200;
export const TELEGRAM_ACTIVITY_MESSAGE_MAX_CHARS = 3_900;
export const TELEGRAM_ACTIVITY_MESSAGE_MAX_TOOLS = 6;
export const TELEGRAM_REASONING_MESSAGE_MAX_FRAMES = 24;
export const TELEGRAM_REASONING_BUFFER_MAX_CHARS = 1_200;
export const TELEGRAM_REASONING_MIN_INTERVAL_MS = 1_200;
export const TELEGRAM_TOOL_UPDATE_MAX_ENTRIES = 4;

interface ToolActivity {
  id: string;
  name: string;
  args: string;
  updates: string[];
  droppedUpdates: number;
  result?: string;
  isError?: boolean;
  complete: boolean;
}

function neutralizeActivityAutoLinks(text: string): string {
  return text.replace(/\b(https?:\/\/)(?=\S)/gi, "$1\u200b");
}

function escapeActivityEvidenceHtml(text: string): string {
  return escapeHtml(neutralizeActivityAutoLinks(text));
}

function renderThinkingActivityEvidenceHtml(text: string): string {
  return renderTelegramInlineMarkdownHtml(neutralizeActivityAutoLinks(text), {
    allowLinks: false,
  });
}

export function renderTelegramThinkingActivityHtml(text: string): string {
  return `<blockquote expandable>${renderThinkingActivityEvidenceHtml(text)}</blockquote>`;
}

function formatToolActivityLabel(label: string): string {
  return label
    .split("_")
    .filter(Boolean)
    .map((word) => {
      const repeatedPrefix = word.match(/^([a-z])\1*/iu)?.[0] ?? "";
      if (repeatedPrefix.length === 2 || repeatedPrefix.length === 3) {
        return `${repeatedPrefix.toUpperCase()}${word.slice(repeatedPrefix.length)}`;
      }
      return `${word[0]!.toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function renderToolActivityHtml(tool: ToolActivity): string {
  const evidence = [`"arguments": ${tool.args}`];
  if (tool.droppedUpdates > 0) {
    evidence.push(`… [${tool.droppedUpdates} earlier updates omitted]`);
  }
  tool.updates.forEach((update, index) => {
    evidence.push(
      `"update ${tool.droppedUpdates + index + 1}": ${update}`,
    );
  });
  if (tool.complete && tool.result !== undefined) {
    evidence.push(`"${tool.isError ? "error" : "result"}": ${tool.result}`);
  }
  const status = tool.complete
    ? tool.isError
      ? "failed"
      : "done"
    : "running";
  return [
    `<b>${escapeHtml(formatToolActivityLabel(tool.name))}:</b> <code>${status}</code>`,
    `<blockquote expandable>${escapeActivityEvidenceHtml(evidence.join("\n\n"))}</blockquote>`,
  ].join("\n");
}

export function renderTelegramToolActivityHtml(
  tools: readonly ToolActivity[],
): string {
  return tools.map(renderToolActivityHtml).join("\n\n");
}

function createToolActivityDetail(
  summary: string,
  text: string,
  isOpen = false,
): TelegramInputRichBlock {
  return {
    type: "details",
    summary: { type: "code", text: summary },
    blocks: [{ type: "pre", text, language: "json" }],
    ...(isOpen ? { is_open: true as const } : {}),
  };
}

function renderToolActivityRichBlocks(
  tool: ToolActivity,
): TelegramInputRichBlock[] {
  const status = tool.complete
    ? tool.isError
      ? "failed"
      : "done"
    : "running";
  const evidenceBlocks: TelegramInputRichBlock[] = [
    createToolActivityDetail("arguments", tool.args, true),
  ];
  tool.updates.forEach((update, index) => {
    const number = tool.droppedUpdates + index + 1;
    const omitted =
      index === 0 && tool.droppedUpdates > 0
        ? ` (${tool.droppedUpdates} earlier omitted)`
        : "";
    evidenceBlocks.push(
      createToolActivityDetail(`update ${number}${omitted}`, update),
    );
  });
  if (tool.complete && tool.result !== undefined) {
    evidenceBlocks.push(
      createToolActivityDetail(tool.isError ? "error" : "result", tool.result),
    );
  }
  return [
    {
      type: "details",
      summary: [
        {
          type: "bold",
          text: `${formatToolActivityLabel(tool.name)}:`,
        },
        " ",
        { type: "code", text: status },
      ],
      blocks: evidenceBlocks,
    },
  ];
}

export function renderTelegramToolActivityRichMessage(
  tools: readonly ToolActivity[],
): TelegramInputRichMessage {
  return {
    blocks: tools.flatMap(renderToolActivityRichBlocks),
    skip_entity_detection: true,
  };
}

import {
  createTelegramProgressTailRuntime,
  type TelegramProgressTailRuntime,
  type TelegramProgressTailRuntimeDeps,
} from "./progress-tail.ts";

export type TelegramActivityVerbosityRuntime = TelegramProgressTailRuntime;

export interface TelegramActivityVerbosityBinding
  extends TelegramActivityVerbosityRuntime {
  bind: (runtime: TelegramActivityVerbosityRuntime) => void;
}

export function createTelegramActivityVerbosityBinding(): TelegramActivityVerbosityBinding {
  let runtime: TelegramActivityVerbosityRuntime | undefined;
  return {
    bind(next) {
      runtime = next;
    },
    accept(event) {
      runtime?.accept(event);
    },
    reset() {
      runtime?.reset();
    },
    stop() {
      runtime?.stop();
    },
    waitForIdle() {
      return runtime?.waitForIdle() ?? Promise.resolve();
    },
  };
}

export function createTelegramActivityVerbosityRuntime<TAuthority>(
  deps: TelegramProgressTailRuntimeDeps<TAuthority>,
): TelegramActivityVerbosityRuntime {
  return createTelegramProgressTailRuntime(deps);
}
