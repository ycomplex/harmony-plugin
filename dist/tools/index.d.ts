import type { SupabaseClient } from '@supabase/supabase-js';
export declare function registerTools(disabledFeatures?: Record<string, boolean>): {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {};
    };
}[];
export declare function handleToolCall(name: string, args: Record<string, unknown>, client: SupabaseClient, projectId: string, userId: string): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
} | {
    content: {
        type: "text";
        text: string;
    }[];
    isError?: undefined;
}>;
