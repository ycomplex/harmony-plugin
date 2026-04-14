import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listProjectDocumentsTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {};
    };
};
export interface ProjectDocumentSummary {
    id: string;
    title: string;
    updated_at: string;
}
export declare function listProjectDocuments(client: SupabaseClient, projectId: string): Promise<ProjectDocumentSummary[]>;
export declare const getProjectDocumentTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            document_id: {
                type: string;
                description: string;
            };
            title: {
                type: string;
                description: string;
            };
        };
    };
};
export interface ProjectDocument {
    id: string;
    title: string;
    content: string;
    created_at: string;
    updated_at: string;
}
export declare function getProjectDocument(client: SupabaseClient, projectId: string, args: {
    document_id?: string;
    title?: string;
}): Promise<ProjectDocument>;
export declare const createProjectDocumentTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            title: {
                type: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function createProjectDocument(client: SupabaseClient, projectId: string, userId: string, args: {
    title: string;
    content: string;
}): Promise<ProjectDocument>;
export declare const updateProjectDocumentTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            document_id: {
                type: string;
                description: string;
            };
            title: {
                type: string;
                description: string;
            };
            new_title: {
                type: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
            };
        };
    };
};
export declare function updateProjectDocument(client: SupabaseClient, projectId: string, args: {
    document_id?: string;
    title?: string;
    new_title?: string;
    content?: string;
}): Promise<ProjectDocument>;
