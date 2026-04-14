import type { SupabaseClient } from '@supabase/supabase-js';
export interface ManageTaskLabelsArgs {
    task_id: string;
    add?: string[];
    remove?: string[];
}
export declare const manageTaskLabelsTool: {
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
                };
                description: string;
            };
            remove: {
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
export declare function manageTaskLabels(client: SupabaseClient, projectId: string, args: ManageTaskLabelsArgs): Promise<{
    added: string[];
    removed: string[];
}>;
