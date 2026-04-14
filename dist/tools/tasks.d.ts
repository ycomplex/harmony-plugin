import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listTasksTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            status: {
                type: string;
                description: string;
            };
            epic_id: {
                type: string;
                description: string;
            };
            assignee_id: {
                type: string;
                description: string;
            };
            archived: {
                type: string;
                description: string;
            };
            label_ids: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            offset: {
                type: string;
                description: string;
            };
        };
    };
};
export declare function listTasks(client: SupabaseClient, projectId: string, args: {
    status?: string;
    epic_id?: string;
    assignee_id?: string;
    archived?: boolean;
    label_ids?: string[];
    limit?: number;
    offset?: number;
}): Promise<any[]>;
export declare const getTaskTool: {
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
export declare function getTask(client: SupabaseClient, projectId: string, args: {
    task_id: string;
}): Promise<any>;
export declare const createTaskTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            title: {
                type: string;
                description: string;
            };
            status: {
                type: string;
                description: string;
            };
            priority: {
                type: string;
                enum: string[];
                description: string;
            };
            assignee_id: {
                type: string;
                description: string;
            };
            epic_id: {
                type: string;
                description: string;
            };
            description: {
                type: string;
                description: string;
            };
            due_date: {
                type: string;
                description: string;
            };
            field_values: {
                type: string;
                description: string;
            };
            cycle_id: {
                type: string;
                description: string;
            };
            milestone_id: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function createTask(client: SupabaseClient, projectId: string, userId: string, args: {
    title: string;
    status?: string;
    priority?: string;
    assignee_id?: string;
    epic_id?: string;
    description?: string;
    due_date?: string;
    field_values?: Record<string, any>;
    cycle_id?: string;
    milestone_id?: string;
}): Promise<any>;
export declare const updateTaskTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
            title: {
                type: string;
                description: string;
            };
            status: {
                type: string;
                description: string;
            };
            priority: {
                type: string;
                enum: string[];
                description: string;
            };
            assignee_id: {
                type: string;
                description: string;
            };
            epic_id: {
                type: string;
                description: string;
            };
            description: {
                type: string;
                description: string;
            };
            due_date: {
                type: string;
                description: string;
            };
            archived: {
                type: string;
                description: string;
            };
            field_values: {
                type: string;
                description: string;
            };
            label_ids: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            cycle_id: {
                type: string;
                description: string;
            };
            milestone_id: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function updateTask(client: SupabaseClient, projectId: string, args: {
    task_id: string;
    [key: string]: any;
}): Promise<any>;
export declare const bulkCreateTasksTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            tasks: {
                type: string;
                items: {
                    type: string;
                    properties: {
                        title: {
                            type: string;
                        };
                        status: {
                            type: string;
                        };
                        priority: {
                            type: string;
                            enum: string[];
                        };
                        epic_id: {
                            type: string;
                        };
                        description: {
                            type: string;
                        };
                        due_date: {
                            type: string;
                        };
                        field_values: {
                            type: string;
                        };
                    };
                    required: string[];
                };
                description: string;
            };
        };
        required: string[];
    };
};
export declare function bulkCreateTasks(client: SupabaseClient, projectId: string, userId: string, args: {
    tasks: Array<{
        title: string;
        status?: string;
        priority?: string;
        epic_id?: string;
        description?: string;
        due_date?: string;
        field_values?: Record<string, any>;
    }>;
}): Promise<any[]>;
