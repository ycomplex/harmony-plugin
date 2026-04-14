import type { SupabaseClient } from '@supabase/supabase-js';
export declare const getProjectTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {};
    };
};
export declare function getProject(client: SupabaseClient, projectId: string): Promise<{
    id: any;
    name: any;
    key: any;
    description: any;
    custom_statuses: any;
    field_definitions: any;
    archived: any;
}>;
