import type { SupabaseClient } from '@supabase/supabase-js';
import { linkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  previewMetadataRepair,
  type MetadataPreviewSelectors,
} from '../tools/knowledge-repair.js';

/** Each published snapshot is complete JSON. Exclusive first publication protects reviewed files. */
export async function previewMetadataRepairToFile(
  client: SupabaseClient,
  projectId: string,
  file: string,
  selectors: MetadataPreviewSelectors = {},
  progress: (line: string) => void = line => process.stderr.write(`${line}\n`),
) {
  let published = false;
  const manifest = await previewMetadataRepair(client, projectId, {
    ...selectors,
    onCheckpoint(snapshot) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        if (published) renameSync(temporary, file);
        else {
          // link is atomic and refuses an existing destination, unlike rename.
          linkSync(temporary, file);
          published = true;
        }
      } finally {
        rmSync(temporary, { force: true });
      }
      progress(`Metadata preview: ${snapshot.counts.entries} entries, ${snapshot.preview!.pages} pages — ${snapshot.preview!.complete ? `complete (${snapshot.preview!.stopped_by})` : 'in progress'}; review file: ${file}`);
    },
  });
  return manifest.counts;
}
