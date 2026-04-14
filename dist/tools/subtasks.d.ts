import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listSubtasksTool: {
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
export declare function listSubtasks(client: SupabaseClient, projectId: string, args: {
    task_id: string;
}): Promise<{
    id: any;
    title: any;
    completed: any;
    position: any;
    created_by: any;
    created_at: any;
}[]>;
export declare const manageSubtasksTool: {
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
                        title: {
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
                        title: {
                            type: string;
                            description: string;
                        };
                        completed: {
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
export declare function manageSubtasks(client: SupabaseClient, projectId: string, userId: string, args: {
    task_id: string;
    add?: {
        title: string;
    }[];
    update?: {
        id: string;
        title?: string;
        completed?: boolean;
    }[];
    delete?: string[];
}): Promise<{
    added: any[];
    updated: any[];
    deleted: string[];
}>;
