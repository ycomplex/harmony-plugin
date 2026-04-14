import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listTestCasesTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function listTestCases(client: SupabaseClient, projectId: string, args: {
    task_id: string;
}): Promise<{
    id: any;
    name: any;
    type: any;
    position: any;
    created_by: any;
    created_at: any;
}[]>;
export declare const manageTestCasesTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
            add: {
                type: string;
                items: {
                    type: string;
                    properties: {
                        name: {
                            type: string;
                            description: string;
                        };
                        type: {
                            type: string;
                            description: string;
                        };
                    };
                    required: string[];
                };
                description: string;
            };
            update: {
                type: string;
                items: {
                    type: string;
                    properties: {
                        id: {
                            type: string;
                            description: string;
                        };
                        name: {
                            type: string;
                            description: string;
                        };
                        type: {
                            type: string;
                            description: string;
                        };
                    };
                    required: string[];
                };
                description: string;
            };
            delete: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
        };
        required: string[];
    };
};
export declare function manageTestCases(client: SupabaseClient, projectId: string, userId: string, args: {
    task_id: string;
    add?: {
        name: string;
        type?: string;
    }[];
    update?: {
        id: string;
        name?: string;
        type?: string;
    }[];
    delete?: string[];
}): Promise<{
    added: any[];
    updated: any[];
    deleted: string[];
}>;
