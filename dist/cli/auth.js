import { HarmonyAuth } from '../auth.js';
import { createAuthenticatedClient } from '../supabase.js';
import { getActiveProject } from './config.js';
export async function getAuthenticatedContext(projectConfig) {
    const project = projectConfig ?? getActiveProject();
    // Set env vars if the project has custom Supabase config
    if (project.supabaseUrl) {
        process.env.HARMONY_SUPABASE_URL = project.supabaseUrl;
    }
    if (project.supabaseAnonKey) {
        process.env.HARMONY_SUPABASE_ANON_KEY = project.supabaseAnonKey;
    }
    const auth = new HarmonyAuth(project.token);
    const client = await createAuthenticatedClient(auth);
    const projectId = auth.getProjectId();
    const userId = auth.getUserId();
    return { client, projectId, userId };
}
//# sourceMappingURL=auth.js.map