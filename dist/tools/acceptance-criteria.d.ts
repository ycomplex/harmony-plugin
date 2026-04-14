import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listAcceptanceCriteriaTool: {
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
export declare function listAcceptanceCriteria(client: SupabaseClient, projectId: string, args: {
    task_id: string;
}): Promise<{
    id: any;
    content: any;
    checked: any;
    position: any;
    created_by: any;
    created_at: any;
}[]>;
export declare const manageAcceptanceCriteriaTool: {
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
                        content: {
                            type: string;
                            description: string;
                        };
                        checked: {
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
                        content: {
                            type: string;
                            description: string;
                        };
                        checked: {
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
export declare function manageAcceptanceCriteria(client: SupabaseClient, projectId: string, userId: string, args: {
    task_id: string;
    add?: {
        content: string;
        checked?: boolean;
    }[];
    update?: {
        id: string;
        content?: string;
        checked?: boolean;
    }[];
    delete?: string[];
}): Promise<{
    added: any[];
    updated: any[];
    deleted: string[];
}>;
