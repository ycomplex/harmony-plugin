import { AuthenticatedContext } from './auth.js';
export declare function runCommand<T>(opts: {
    json: boolean;
}, handler: (ctx: AuthenticatedContext) => Promise<T>, formatter: (data: T) => string): Promise<void>;
