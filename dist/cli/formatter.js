import Table from 'cli-table3';
import chalk from 'chalk';
export function formatOutput(data, opts, textFn) {
    if (opts.json) {
        return JSON.stringify(data, null, 2);
    }
    return textFn ? textFn() : JSON.stringify(data, null, 2);
}
export function formatTable(rows, columns) {
    if (rows.length === 0)
        return 'No results.';
    const table = new Table({
        head: columns.map((c) => chalk.bold(c.header)),
        ...(columns.some((c) => c.width) ? { colWidths: columns.map((c) => c.width ?? null) } : {}),
        style: { head: [], border: [] },
        wordWrap: true,
    });
    for (const row of rows) {
        table.push(columns.map((col) => {
            const raw = row[col.key];
            if (col.transform)
                return col.transform(raw, row);
            return raw?.toString() ?? '';
        }));
    }
    return table.toString();
}
export function formatDetail(fields) {
    const table = new Table({
        style: { head: [], border: [] },
    });
    for (const { label, value } of fields) {
        table.push({ [chalk.bold(label)]: value?.toString() ?? '' });
    }
    return table.toString();
}
// Helpers for common formatting patterns
export function formatPriority(priority) {
    switch (priority) {
        case 'high': return chalk.red(priority);
        case 'medium': return chalk.yellow(priority);
        case 'low': return chalk.green(priority);
        default: return priority;
    }
}
export function formatStatus(status) {
    switch (status) {
        case 'Done': return chalk.green(status);
        case 'In Progress': return chalk.blue(status);
        case 'In Review': return chalk.magenta(status);
        case 'To Do': return chalk.yellow(status);
        case 'Backlog': return chalk.gray(status);
        default: return status;
    }
}
export function formatDate(dateStr) {
    if (!dateStr)
        return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
//# sourceMappingURL=formatter.js.map