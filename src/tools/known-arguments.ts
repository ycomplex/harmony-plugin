// B-1400: refuse arguments a tool's own inputSchema does not define.
//
// The MCP entry hands `request.params.arguments` to handleToolCall unvalidated, and the handlers
// read only the keys they know — so a misspelt or invented argument (`acceptance_criteria` on
// create_task, `items` instead of `add` on manage_acceptance_criteria) used to be dropped silently
// and the call reported success. A handler that opts in calls assertKnownArguments as its FIRST
// statement, before any client call, so the MCP server and the CLI (which both call the handlers)
// refuse the same calls.
//
// The message must never contain the phrases handleToolCall's catch rewrites ("not found",
// "no rows", "permission denied", "RLS"), so it reaches the caller verbatim as `Error: …`.

type SchemaProperty = {
  type?: string | string[];
  items?: { type?: string; properties?: Record<string, unknown> };
  [key: string]: unknown;
};

export interface ToolWithSchema {
  name: string;
  inputSchema: { properties: Record<string, any> };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Throw one Error naming every argument (top-level, and keys inside object elements of an
 * array-of-objects property) that `tool.inputSchema` does not define. A known key whose value is
 * `undefined` is allowed (the CLI passes unset flags that way). Non-object `args` count as `{}`.
 * `hints` maps an unknown key, exactly as reported (e.g. `acceptance_criteria` or `add[0].text`), to
 * one extra line appended to the message.
 */
export function assertKnownArguments(
  tool: ToolWithSchema,
  args: unknown,
  hints?: Record<string, string>,
): void {
  const input = isPlainObject(args) ? args : {};
  const properties = tool.inputSchema.properties ?? {};
  const allowed = Object.keys(properties);
  const unknown: string[] = [];

  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      unknown.push(key);
      continue;
    }
    const schema = properties[key] as SchemaProperty;
    const value = input[key];
    const itemProps = schema?.items?.properties;
    if (schema?.type === 'array' && schema.items?.type === 'object' && itemProps && Array.isArray(value)) {
      value.forEach((element, index) => {
        if (!isPlainObject(element)) return;
        for (const itemKey of Object.keys(element)) {
          if (!Object.prototype.hasOwnProperty.call(itemProps, itemKey)) {
            unknown.push(`${key}[${index}].${itemKey}`);
          }
        }
      });
    }
  }

  if (unknown.length === 0) return;

  const lines = [`${tool.name} does not accept: ${unknown.join(', ')}. Accepted arguments: ${allowed.join(', ')}.`];
  const nested = new Set<string>();
  for (const key of unknown) {
    const match = /^([^[]+)\[\d+\]\./.exec(key);
    if (match && !nested.has(match[1])) {
      nested.add(match[1]);
      const itemKeys = Object.keys((properties[match[1]] as SchemaProperty).items?.properties ?? {});
      lines.push(`Each ${match[1]} entry accepts: ${itemKeys.join(', ')}.`);
    }
  }
  if (hints) {
    const seen = new Set<string>();
    for (const key of unknown) {
      const hint = hints[key];
      if (hint && !seen.has(hint)) {
        seen.add(hint);
        lines.push(hint);
      }
    }
  }
  throw new Error(lines.join('\n'));
}
