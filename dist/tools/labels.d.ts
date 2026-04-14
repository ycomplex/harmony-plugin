import type { SupabaseClient } from '@supabase/supabase-js';
export interface Label {
    id: string;
    name: string;
    color: string;
}
export declare const listLabelsTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {};
    };
};
export declare function listLabels(client: SupabaseClient, projectId: string): Promise<Label[]>;
export declare const createLabelTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            name: {
                type: string;
                description: string;
            };
            color: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function createLabel(client: SupabaseClient, projectId: string, userId: string, args: {
    name: string;
    color?: string;
}): Promise<Label>;
