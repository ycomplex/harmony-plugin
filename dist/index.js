#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HarmonyAuth } from './auth.js';
import { createAuthenticatedClient } from './supabase.js';
import { registerTools, handleToolCall } from './tools/index.js';
const apiToken = process.env.HARMONY_API_TOKEN;
if (!apiToken) {
    console.error('HARMONY_API_TOKEN environment variable is required');
    process.exit(1);
}
const auth = new HarmonyAuth(apiToken);
const server = new Server({ name: 'harmony', version: '0.1.0' }, { capabilities: { tools: {} } });
let cachedFeatures;
server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!cachedFeatures) {
        const client = await createAuthenticatedClient(auth);
        const projectId = auth.getProjectId();
        // Fetch workspace disabled_features via the project
        const { data } = await client
            .from('projects')
            .select('workspace_id, workspaces(disabled_features)')
            .eq('id', projectId)
            .single();
        cachedFeatures = data?.workspaces?.disabled_features ?? {};
    }
    return { tools: registerTools(cachedFeatures) };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const client = await createAuthenticatedClient(auth);
    const projectId = auth.getProjectId();
    const userId = auth.getUserId();
    return handleToolCall(request.params.name, request.params.arguments ?? {}, client, projectId, userId);
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Harmony MCP server started');
}
main().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map