import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listCyclesTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            status: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
};
export declare function listCycles(client: SupabaseClient, projectId: string, args: {
    status?: string;
}): Promise<any[]>;
export declare const createCycleTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            start_date: {
                type: string;
                description: string;
            };
            name: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function createCycle(client: SupabaseClient, projectId: string, userId: string, args: {
    start_date: string;
    name?: string;
}): Promise<any>;
export declare const updateCycleTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            cycle_id: {
                type: string;
                description: string;
            };
            name: {
                type: string;
                description: string;
            };
            end_date: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function updateCycle(client: SupabaseClient, projectId: string, args: {
    cycle_id: string;
    name?: string;
    end_date?: string;
}): Promise<any>;
