import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listMilestonesTool: {
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
export declare function listMilestones(client: SupabaseClient, projectId: string, args: {
    status?: string;
}): Promise<any[]>;
export declare const createMilestoneTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            name: {
                type: string;
                description: string;
            };
            description: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function createMilestone(client: SupabaseClient, projectId: string, userId: string, args: {
    name: string;
    description?: string;
}): Promise<any>;
export declare const updateMilestoneTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            milestone_id: {
                type: string;
                description: string;
            };
            name: {
                type: string;
                description: string;
            };
            description: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function updateMilestone(client: SupabaseClient, projectId: string, args: {
    milestone_id: string;
    name?: string;
    description?: string;
}): Promise<any>;
export declare const shipMilestoneTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            milestone_id: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function shipMilestone(client: SupabaseClient, projectId: string, args: {
    milestone_id: string;
}): Promise<{
    milestone: any;
    shipped_task_count: number;
    removed_tasks: {
        id: any;
        title: any;
        status: any;
    }[];
}>;
