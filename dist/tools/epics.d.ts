import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listEpicsTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {};
    };
};
export declare function listEpics(client: SupabaseClient, projectId: string): Promise<{
    id: any;
    name: any;
    color: any;
    position: any;
}[]>;
export declare const createEpicTool: {
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
export declare const updateEpicTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            epic_id: {
                type: string;
                description: string;
            };
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
export declare function updateEpic(client: SupabaseClient, projectId: string, args: {
    epic_id: string;
    name?: string;
    color?: string;
}): Promise<any>;
export declare function createEpic(client: SupabaseClient, projectId: string, userId: string, args: {
    name: string;
    color?: string;
}): Promise<any>;
