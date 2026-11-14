import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { READ_SPECS } from './read.js';
import { WRITE_SPECS } from './write.js';
import { buildTool, runSpec } from './spec.js';
import type { ToolSpec } from './spec.js';
import type { CallToolResult } from './types.js';

export const ALL_SPECS: ToolSpec[] = [...READ_SPECS, ...WRITE_SPECS];

export const ALL_TOOLS: Tool[] = ALL_SPECS.map(buildTool);

/** For the MCP host's `read_tools`: GET tools plus the stats export request. */
export const READ_TOOL_NAMES: readonly string[] = ALL_SPECS.filter((s) => s.kind !== 'write').map((s) => s.name);

/** For the MCP host's `write_tools`: every call is an approval-gated proposal. */
export const WRITE_TOOL_NAMES: readonly string[] = ALL_SPECS.filter((s) => s.kind === 'write').map((s) => s.name);

/** Tools that return personal information (call logs, transcripts, contacts, exports) or internal URLs: admin-gate them. */
export const SENSITIVE_TOOL_NAMES: ReadonlySet<string> = new Set(ALL_SPECS.filter((s) => s.sensitive).map((s) => s.name));

const SPEC_BY_NAME = new Map(ALL_SPECS.map((s) => [s.name, s]));

export async function dispatchToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  return runSpec(spec, args);
}
