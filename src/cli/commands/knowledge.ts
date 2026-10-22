import { createFeatureAccount, readFeatureAccounts, previewFeatureAmendment, proposeFeatureAmendment, applyFeatureAmendment } from '../../tools/feature-accounts.js';
import { registerSourceCommands } from './knowledge-sources.js';
import { readFile } from 'node:fs/promises';
import { saveKnowledgeQuestion, previewKnowledgeQuestions, importKnowledgeQuestions } from '../../tools/knowledge-questions.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { previewMetadataRepair, applyMetadataRepair, tagReleasedKnowledge } from '../../tools/knowledge-repair.js';
import { listKnowledgeTags, registerKnowledgeTag } from '../../tools/knowledge-metadata.js';
import { publishDefinition } from '../../tools/knowledge-definitions.js';
import { Command } from 'commander';
import {
  queryKnowledge,
  proposeLegacyClaims,
  getKnowledgeEntry,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  supersedeKnowledgeEntry,
} from '../../tools/knowledge.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail, formatDate } from '../formatter.js';

export function registerKnowledgeCommands(program: Command): void {
  const knowledge = program.command('knowledge').description('Manage workspace knowledge base');

  const accounts = knowledge.command('accounts').description('Live feature accounts and pending clause amendments');
  accounts.command('list').option('--surface <surface>').option('--account <id>').option('--history-limit <n>').option('--history-before <n>').action(async opts => {
    await runCommand(program.opts(), ctx => readFeatureAccounts(ctx.client,ctx.projectId,{owner_surface:opts.surface,account_id:opts.account,history_limit:opts.historyLimit ? Number(opts.historyLimit) : undefined,history_before:opts.historyBefore ? Number(opts.historyBefore) : undefined}), data => JSON.stringify(data,null,2));
  });
  accounts.command('create').requiredOption('--surface <surface>').option('--concept <id>').action(async opts => {
    await runCommand(program.opts(), ctx => createFeatureAccount(ctx.client,ctx.projectId,{owner_surface:opts.surface,concept_id:opts.concept}), data => JSON.stringify(data,null,2));
  });
  for (const [name, handler] of [['preview',previewFeatureAmendment],['propose',proposeFeatureAmendment]] as const) {
    accounts.command(name).requiredOption('--file <path>', 'JSON argument file; same fields as MCP').action(async opts => {
      const args: unknown = JSON.parse(readFileSync(opts.file,'utf8'));
      await runCommand(program.opts(), ctx => handler(ctx.client,ctx.projectId,args), data => JSON.stringify(data,null,2));
    });
  }
  accounts.command('apply').argument('<amendment-id>').option('--production-event <id>').option('--confirm-production', 'Explicitly confirm production promotion has completed').action(async (id,opts) => {
    await runCommand(program.opts(), ctx => applyFeatureAmendment(ctx.client,ctx.projectId,{amendment_id:id,production_event_id:opts.productionEvent,confirm_production:opts.confirmProduction}), data => JSON.stringify(data,null,2));
  });
  registerSourceCommands(knowledge, program);
  const questions = knowledge.command('questions').description('Manage unresolved knowledge; question state never implies shipped behaviour');
  questions.command('save').requiredOption('--state <state>', 'open, parked or decided')
    .option('--claim <claim>', 'Authored one-sentence claim; omitted claims remain derived proposals')
    .option('--id <id>', 'Existing question UUID').option('--expected-updated-at <timestamp>', 'Fresh read timestamp for changes')
    .option('--title <title>').option('--content <content>').option('--scope <scope>', 'product or deployment; required for creates')
    .option('--decision <id>', 'Accepted resulting decision in this project').option('--reopen', 'Explicitly reopen a decided question')
    .option('--domain <domains>', 'Comma-separated subject domains; defaults to product on create')
    .option('--provenance <value>', 'Declare how this write was authorized')
    .action(async opts => runCommand(program.opts(), ctx => saveKnowledgeQuestion(ctx.client, ctx.projectId, {
      question_id: opts.id, expected_updated_at: opts.expectedUpdatedAt, title: opts.title, content: opts.content,
      state: opts.state, scope: opts.scope, claim: opts.claim, resulting_decision_id: opts.decision, reopen: opts.reopen,
      domain: opts.domain?.split(',').map((value: string) => value.trim()).filter(Boolean), provenance: opts.provenance,
    }), data => JSON.stringify(data, null, 2)));
  questions.command('preview').argument('<milestone-id>').description('Read-only manifest; review historical themes and mark chosen items approved:true')
    .action(async id => runCommand(program.opts(), ctx => previewKnowledgeQuestions(ctx.client, ctx.projectId, { milestone_id: id }),
      data => JSON.stringify(data, null, 2)));
  questions.command('import').argument('<manifest-file>').description('Explicitly apply approved entries from a reviewed manifest')
    .option('--provenance <value>', 'Declare how this import was authorized')
    .action(async (file, opts) => {
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      await runCommand(program.opts(), ctx => importKnowledgeQuestions(ctx.client, ctx.projectId, {
        manifest, provenance: opts.provenance,
      }), data => JSON.stringify(data, null, 2));
    });


  knowledge
    .command('list')
    .description('List knowledge entries with optional filters')
    .option('--scope <scope>', 'Product or deployment scope; fails visibly when unavailable')
    .option('--type <type>', 'Filter by type (e.g. architecture, business, convention, specification)')
    .option('--status <status>', 'Filter by status')
    .option(
      '--tag <tag>',
      'Filter by tag (repeat for multiple)',
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option('--search <text>', 'Search term matched against title and content')
    .option('--question-state <state>', 'Filter-only: open, parked or decided; search combination requires B-1223')
    .option('--definitions-only', 'Return only current term definitions', false)
    .option('--all', 'Include superseded entries', false)
    .option('--no-bookkeeping', 'Exclude explicitly marked procedural gate records')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          queryKnowledge(ctx.client, ctx.projectId, {
            scope: opts.scope,
            definitions_only: opts.definitionsOnly,
            type: opts.type,
            status: opts.status,
            tags: opts.tag && opts.tag.length > 0 ? opts.tag : undefined,
            search: opts.search,
            include_superseded: opts.all,
            include_bookkeeping: opts.bookkeeping,
            question_state: opts.questionState,
          }),
        (data) =>
          formatTable(data, [
            {
              key: 'id',
              header: 'ID',
              transform: (v: string) => v.slice(0, 8),
            },
            { key: 'title', header: 'Title', width: 40 },
            { key: 'content', header: 'Definition / value', width: 60 },
            { key: 'source', header: 'Generated source', transform: (v: unknown) => v ? JSON.stringify(v) : '' },
            { key: 'claim', header: 'Claim', width: 60 },
            { key: 'claim_source', header: 'Claim source' },
            { key: 'snippet', header: 'Matched passage', width: 60 },
            { key: 'type', header: 'Type (advisory)', width: 16 },
            { key: 'status', header: 'Status', width: 12 },
            { key: 'question_state', header: 'Question', width: 10 },
            { key: 'answer', header: 'Answer', width: 24 },
            { key: 'resulting_decision_id', header: 'Resulting decision', width: 36 },
            { key: 'superseded_by', header: 'Superseded by', transform: (v: string | null) => v ?? '—' },
            { key: 'supersedes', header: 'Supersedes', transform: (v: string[]) => (v ?? []).join(', ') || '—' },
            { key: 'invalidations', header: 'Invalidation', transform: (links: Array<{ effective_at: string | null }> = []) => links.some(link => link.effective_at) ? 'Retired' : links.length ? 'Removal pending' : '' },
            { key: 'rollout_state', header: 'Rollout', transform: (v: string | null) => v ?? 'unknown' },
            { key: 'verified_against', header: 'Verification', transform: (v: unknown) => v ? JSON.stringify(v) : 'not verified' },
            {
              key: 'tags',
              header: 'Tags',
              width: 20,
              transform: (v: string[]) => (v ?? []).join(', '),
            },
            {
              key: 'updated_at',
              header: 'Updated',
              transform: (v: string) => formatDate(v),
            },
          ]),
      );
    });

  knowledge.command('preview-metadata-repair').argument('<file>').action(async file => {
    await runCommand(program.opts(), async ctx => {const manifest=await previewMetadataRepair(ctx.client,ctx.projectId);writeFileSync(file,JSON.stringify(manifest,null,2));return manifest.counts;}, data=>JSON.stringify(data,null,2));
  });
  knowledge.command('apply-metadata-repair').argument('<reviewed-file>').action(async file => {
    await runCommand(program.opts(), ctx=>applyMetadataRepair(ctx.client,ctx.projectId,JSON.parse(readFileSync(file,'utf8'))),data=>JSON.stringify(data,null,2));
  });
  knowledge.command('tag-release').requiredOption('--task <uuid>','Ticket UUID').requiredOption('--repo <owner/name>','PR repository').requiredOption('--pr <number>','Merged PR number').action(async opts=>{
    await runCommand(program.opts(),ctx=>tagReleasedKnowledge(ctx.client,ctx.projectId,opts.task,opts.repo,Number(opts.pr)),data=>JSON.stringify(data,null,2));
  });
  knowledge.command('tags').action(async () => { await runCommand(program.opts(), ctx => listKnowledgeTags(ctx.client, ctx.projectId), data => JSON.stringify(data, null, 2)); });
  knowledge.command('register-tag').argument('<name>').argument('<description>').action(async (name, description) => { await runCommand(program.opts(), ctx => registerKnowledgeTag(ctx.client, ctx.projectId, name, description), data => JSON.stringify(data, null, 2)); });
  knowledge.command('publish-definition').requiredOption('--concept <uuid>').requiredOption('--expected-revision <uuid-or-null>')
    .requiredOption('--source <uuid>').requiredOption('--wording <text>')
    .option('--metadata <json>', 'Source references', '{}').option('--provenance <value>', 'Knowledge-write provenance').action(async opts => {
      await runCommand(program.opts(), ctx => publishDefinition(ctx.client, ctx.projectId, {
        concept_id: opts.concept, expected_revision: opts.expectedRevision === 'null' ? null : opts.expectedRevision,
        source_decision_id: opts.source, wording: opts.wording, provenance: opts.provenance, metadata: JSON.parse(opts.metadata),
      }), data => JSON.stringify(data, null, 2));
    });

  knowledge.command('propose-claims').description('Propose missing legacy claims; dry run unless --apply').option('--apply', 'Store missing proposals as derived', false).action(async opts => {
    await runCommand(program.opts(), ctx => proposeLegacyClaims(ctx.client, ctx.projectId, opts.apply), data => JSON.stringify(data, null, 2));
  });

  knowledge
    .command('get')
    .description('Get full details of a knowledge entry')
    .argument('<id-or-title>', 'Entry UUID or title')
    .action(async (idOrTitle) => {
      const isUuid = /^[0-9a-f-]{36}$/i.test(idOrTitle);
      await runCommand(
        program.opts(),
        async (ctx) =>
          getKnowledgeEntry(ctx.client, ctx.projectId, {
            ...(isUuid ? { entry_id: idOrTitle } : { title: idOrTitle }),
          }),
        (entry) =>
          formatDetail([
            { label: 'ID', value: entry.id },
            { label: 'Title', value: entry.title },
            { label: 'Type (advisory)', value: entry.type },
            { label: 'Status', value: entry.status },
            { label: 'Verification', value: entry.verified_against ? JSON.stringify(entry.verified_against) : 'Not verified' },
            { label: 'Rollout', value: entry.rollout_state ?? 'Unknown' },
            { label: 'Open steps', value: entry.open_steps?.join('\n') || '(none)' },
            { label: 'Tags', value: entry.tags?.length ? entry.tags.join(', ') : '(none)' },
            { label: 'Project', value: entry.project_id ?? '(workspace-wide)' },
            { label: 'Updated', value: formatDate(entry.updated_at) },
            { label: 'Question', value: entry.question_state ?? '(not a question)' },
            { label: 'Answer', value: entry.answer ?? '' },
            { label: 'Resulting decision', value: entry.resulting_decision_id ?? '' },
            { label: 'Removal capability', value: entry.invalidations_available === false ? 'unavailable' : 'available' },
            { label: 'Invalidators', value: (entry.invalidations ?? []).map(link => `${link.invalidator_title} (${link.invalidator_id}): ${link.effective_at ? 'retired' : 'removal agreed, not yet effective'}`).join('\n') || '(none)' },
            ...(entry.invalidation_rollout_available === false ? [{ label: 'Rollout capability', value: 'unavailable; no retirement inferred' }] : []),
            { label: 'Content', value: entry.content },
          ]),
      );
    });

  knowledge
    .command('create')
    .option('--scope <scope>', 'Required new-entry product or deployment scope')
    .description('Create a new knowledge entry')
    .requiredOption('--title <title>', 'Entry title')
    .requiredOption('--claim <claim>', 'One-sentence claim')
    .requiredOption('--content <content>', 'Markdown content of the entry')
    .requiredOption('--type <type>', 'Entry type: architecture, business, convention, or specification')
    .option('--status <status>', 'Status override (default: draft)')
    .option('--tags <tags>', 'Comma-separated list of tags')
    .option('--source-task <id>', 'Task ID that triggered this knowledge entry')
    .action(async (opts) => {
      const tags = opts.tags
        ? opts.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;
      await runCommand(
        program.opts(),
        async (ctx) =>
          createKnowledgeEntry(ctx.client, ctx.projectId, ctx.userId, {
            scope: opts.scope,
            title: opts.title,
            content: opts.content,
            claim: opts.claim,
            type: opts.type,
            status: opts.status,
            tags,
            source_task_id: opts.sourceTask,
          }),
        (entry) => `Created knowledge entry: "${entry.title}" (${entry.id})`,
      );
    });

  knowledge
    .command('update')
    .option('--scope <scope>', 'Product or deployment scope; requires metadata capability')
    .description('Update an existing knowledge entry')
    .argument('<id>', 'Entry UUID')
    .option('--title <title>', 'New title')
    .option('--claim <claim>', 'Authored claim; explicitly confirms a legacy proposal')
    .option('--content <content>', 'New markdown content')
    .option('--content-mode <mode>', 'replace, prepend_section, or append_section')
    .option('--allow-shrink', 'Explicitly permit a destructive shorter replacement')
    .option('--type <type>', 'New entry type')
    .option('--status <status>', 'New status')
    .option('--tags <tags>', 'Comma-separated list of tags (replaces existing tags)')
    .option(
      '--domain <domain>',
      'Domain (repeat for multiple): engineering, operations, data, product, customer, process',
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option('--madr <json>', 'Structured MADR body as a JSON object (full-object replace)')
    .option('--realization <state>', 'Realization state: agreed, live, deprecating, or retired')
    .option('--acting-task <uuid>', 'Acting ticket UUID for a verification/rollout write')
    .option('--verified-against <json>', 'Verification stamp {plugin_version, web_sha, at}; null to clear')
    .option('--rollout-state <state>', 'Production rollout: designed (staging-only), partly-live (part in production), live (production), retired; null to clear')
    .option('--open-steps <json>', 'JSON array of remaining rollout steps; null to clear')
    .option('--review-by <iso>', 'ISO timestamp; freshness/decay date')
    .action(async (id, opts) => {
      const tags = opts.tags
        ? opts.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;
      const domain = opts.domain && opts.domain.length > 0 ? opts.domain : undefined;
      const madr = opts.madr ? JSON.parse(opts.madr) : undefined;
      await runCommand(
        program.opts(),
        async (ctx) =>
          updateKnowledgeEntry(ctx.client, ctx.projectId, {
            entry_id: id,
            scope: opts.scope,
            new_title: opts.title,
            content: opts.content,
            content_mode: opts.contentMode,
            allow_shrink: opts.allowShrink,
            claim: opts.claim,
            type: opts.type,
            status: opts.status,
            tags,
            domain,
            madr,
            realization: opts.realization,
            review_by: opts.reviewBy,
            acting_task_id: opts.actingTask,
            verified_against: opts.verifiedAgainst !== undefined ? JSON.parse(opts.verifiedAgainst) : undefined,
            rollout_state: opts.rolloutState === 'null' ? null : opts.rolloutState,
            open_steps: opts.openSteps !== undefined ? JSON.parse(opts.openSteps) : undefined,
          }),
        (entry) => `Updated knowledge entry: "${entry.title}" (${entry.id})`,
      );
    });

  knowledge
    .command('supersede')
    .option('--scope <scope>', 'Required applicability of a new successor')
    .description('Supersede an existing knowledge entry with a new replacement')
    .argument('<id>', 'UUID of the entry to supersede')
    .requiredOption('--title <title>', 'Title for the replacement entry')
    .requiredOption('--claim <claim>', 'Authored claim for the replacement')
    .requiredOption('--content <content>', 'Content for the replacement entry')
    .option('--type <type>', 'Type for the replacement (defaults to type of superseded entry)')
    .option('--tags <tags>', 'Comma-separated tags for the replacement')
    .action(async (id, opts) => {
      const tags = opts.tags
        ? opts.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;
      await runCommand(
        program.opts(),
        async (ctx) =>
          supersedeKnowledgeEntry(ctx.client, ctx.projectId, ctx.userId, {
            entry_id: id,
            scope: opts.scope,
            new_title: opts.title,
            new_content: opts.content,
            new_claim: opts.claim,
            type: opts.type,
            tags,
          }),
        ({ superseded, replacement }) =>
          replacement
            ? `Superseded "${superseded.title}" → created "${replacement.title}" (${replacement.id})`
            : `Retired "${superseded.title}" (no successor)`,
      );
    });
}
