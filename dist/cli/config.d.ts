export interface ProjectConfig {
    name: string;
    token: string;
    supabaseUrl?: string;
    supabaseAnonKey?: string;
}
export interface HarmonyConfig {
    activeProject: string | null;
    projects: Record<string, ProjectConfig>;
}
export declare function loadConfig(): HarmonyConfig;
export declare function saveConfig(config: HarmonyConfig): void;
export declare function addProject(name: string, token: string, opts?: {
    supabaseUrl?: string;
    supabaseAnonKey?: string;
}): void;
export declare function removeProject(name: string): void;
export declare function switchProject(name: string): void;
export declare function getActiveProject(): ProjectConfig;
export declare function listProjects(): Array<{
    name: string;
    active: boolean;
}>;
