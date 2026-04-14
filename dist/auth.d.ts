export declare class HarmonyAuth {
    private apiToken;
    private accessToken;
    private projectId;
    private userId;
    private expiresAt;
    constructor(apiToken: string);
    getAccessToken(): Promise<string>;
    getProjectId(): string;
    getUserId(): string;
    private exchange;
}
