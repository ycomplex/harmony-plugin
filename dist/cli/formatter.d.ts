export interface ColumnDef {
    key: string;
    header: string;
    width?: number;
    transform?: (value: any, row: any) => string;
}
export declare function formatOutput(data: any, opts: {
    json: boolean;
}, textFn?: () => string): string;
export declare function formatTable(rows: any[], columns: ColumnDef[]): string;
export declare function formatDetail(fields: Array<{
    label: string;
    value: any;
}>): string;
export declare function formatPriority(priority: string): string;
export declare function formatStatus(status: string): string;
export declare function formatDate(dateStr: string | null): string;
