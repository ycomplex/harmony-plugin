// B-449 — hermetic unit tests for the MCP/agent attachment tools.
// Mocks: functions.invoke (the supabase client), node:fs, and global fetch.
// No network, no real Storage — all three substrate calls are stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── mock node:fs (the upload reads a file; the download writes one) ──
// `vi.mock` is hoisted above top-level vars, so build the mock via vi.hoisted.
const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
}));
vi.mock('node:fs', () => ({ promises: fsMock }));

// ── mock resolveTaskId (visual-id → uuid) ──
vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(),
}));

import { resolveTaskId } from './resolve-task-id.js';
import { downloadAttachment, attachFile } from './attachments.js';
import { registerTools } from './index.js';

const mockResolveTaskId = vi.mocked(resolveTaskId);

const PROJECT_ID = 'project-xyz-789';
const TASK_UUID = 'task-abc-123';
const ATTACHMENT_ID = 'att-111-222';

// Build a mock client whose functions.invoke is programmable per-call.
function createInvokeClient(impl: (fn: string, opts: any) => Promise<{ data: any; error: any }>) {
  return {
    functions: { invoke: vi.fn(impl) },
  } as any;
}

// A FunctionsHttpError shape: .context is the original Response, whose JSON body
// carries the real server message (e.g. the write-nothing / size-limit error).
function httpError(bodyJson: Record<string, unknown>) {
  return {
    message: 'Edge Function returned a non-2xx status code',
    context: { json: async () => bodyJson },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.mkdtemp.mockResolvedValue('/tmp/harmony-attachment-xyz');
  mockResolveTaskId.mockResolvedValue(TASK_UUID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── download ─────────────────────────────────────────────────────────

describe('downloadAttachment', () => {
  it('fetches bytes via the signed URL and writes to a temp path', async () => {
    const client = createInvokeClient(async (fn) => {
      expect(fn).toBe('attachments-download');
      return {
        data: {
          attachment_id: ATTACHMENT_ID,
          signed_url: 'https://storage.example/signed?token=abc',
          filename: 'report.pdf',
          content_type: 'application/pdf',
          inline: false,
          expires_in: 300,
        },
        error: null,
      };
    });

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadAttachment(client, { attachment_id: ATTACHMENT_ID });

    expect(client.functions.invoke).toHaveBeenCalledWith('attachments-download', {
      body: { attachment_id: ATTACHMENT_ID },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://storage.example/signed?token=abc');
    // wrote to the mkdtemp dir + original filename
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    expect(fsMock.writeFile.mock.calls[0][0]).toBe('/tmp/harmony-attachment-xyz/report.pdf');
    expect(result.path).toBe('/tmp/harmony-attachment-xyz/report.pdf');
    expect(result.byte_size).toBe(4);
    expect(result.signed_url).toBe('https://storage.example/signed?token=abc');
  });

  it('honors an explicit output_path', async () => {
    const client = createInvokeClient(async () => ({
      data: {
        attachment_id: ATTACHMENT_ID,
        signed_url: 'https://storage.example/signed',
        filename: 'report.pdf',
        content_type: 'application/pdf',
        inline: false,
        expires_in: 300,
      },
      error: null,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    }));

    const result = await downloadAttachment(client, {
      attachment_id: ATTACHMENT_ID,
      output_path: '/work/out/myfile.pdf',
    });

    expect(fsMock.mkdtemp).not.toHaveBeenCalled();
    expect(result.path).toBe('/work/out/myfile.pdf');
    expect(fsMock.writeFile.mock.calls[0][0]).toBe('/work/out/myfile.pdf');
  });

  it('surfaces the server error (e.g. attachment not found)', async () => {
    const client = createInvokeClient(async () => ({
      data: null,
      error: httpError({ error: 'Attachment not found' }),
    }));
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      downloadAttachment(client, { attachment_id: 'nope' }),
    ).rejects.toThrow('Attachment not found');
  });

  it('throws if the byte fetch fails', async () => {
    const client = createInvokeClient(async () => ({
      data: {
        attachment_id: ATTACHMENT_ID,
        signed_url: 'https://storage.example/signed',
        filename: 'x.pdf',
        content_type: 'application/pdf',
        inline: false,
        expires_in: 300,
      },
      error: null,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    await expect(
      downloadAttachment(client, { attachment_id: ATTACHMENT_ID }),
    ).rejects.toThrow('Failed to fetch attachment bytes (403)');
  });
});

// ── upload (3-step) ──────────────────────────────────────────────────

describe('attachFile', () => {
  it('runs create-upload → PUT → finalize and returns finalized metadata', async () => {
    fsMock.readFile.mockResolvedValue(Buffer.from('hello world'));

    const invokeCalls: string[] = [];
    const client = createInvokeClient(async (fn, opts) => {
      invokeCalls.push(fn);
      if (fn === 'attachments-create-upload') {
        expect(opts.body).toEqual({
          task_id: TASK_UUID,
          filename: 'note.txt',
          byte_size: 11,
        });
        return {
          data: {
            attachment_id: ATTACHMENT_ID,
            object_key: 'ws/proj/task/att',
            signed_url: 'https://storage.example/upload?token=put',
            token: 'put',
            path: 'ws/proj/task/att',
          },
          error: null,
        };
      }
      if (fn === 'attachments-finalize') {
        expect(opts.body).toEqual({ attachment_id: ATTACHMENT_ID });
        return {
          data: {
            attachment_id: ATTACHMENT_ID,
            status: 'finalized',
            content_type: 'text/plain',
            byte_size: 11,
          },
          error: null,
        };
      }
      throw new Error(`unexpected fn ${fn}`);
    });

    const putMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', putMock);

    const result = await attachFile(client, PROJECT_ID, {
      task_id: 'B-42',
      file_path: '/work/note.txt',
    });

    // order: create-upload, then finalize (the PUT is the fetch in between)
    expect(invokeCalls).toEqual(['attachments-create-upload', 'attachments-finalize']);
    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, 'B-42');
    // bytes PUT to the signed upload URL
    expect(putMock).toHaveBeenCalledWith(
      'https://storage.example/upload?token=put',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(result).toEqual({
      attachment_id: ATTACHMENT_ID,
      task_id: TASK_UUID,
      filename: 'note.txt',
      content_type: 'text/plain',
      byte_size: 11,
      status: 'finalized',
    });
  });

  it('surfaces a write-nothing server error and does NOT PUT or finalize (viewer token)', async () => {
    fsMock.readFile.mockResolvedValue(Buffer.from('hello'));

    const invokeCalls: string[] = [];
    const client = createInvokeClient(async (fn) => {
      invokeCalls.push(fn);
      // create-upload is the write-role gate; a viewer is rejected here.
      return { data: null, error: httpError({ error: 'Viewers cannot modify attachments' }) };
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      attachFile(client, PROJECT_ID, { task_id: TASK_UUID, file_path: '/work/x.txt' }),
    ).rejects.toThrow('Viewers cannot modify attachments');

    // never PUT, never finalized
    expect(invokeCalls).toEqual(['attachments-create-upload']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a finalize rejection (blocked type / oversize) after the PUT', async () => {
    fsMock.readFile.mockResolvedValue(Buffer.from('PK\x03\x04junk'));

    const client = createInvokeClient(async (fn) => {
      if (fn === 'attachments-create-upload') {
        return {
          data: {
            attachment_id: ATTACHMENT_ID,
            signed_url: 'https://storage.example/upload',
            object_key: 'k', token: 't', path: 'k',
          },
          error: null,
        };
      }
      // finalize rejects on the magic-byte sniff
      return { data: null, error: httpError({ error: 'File type is not allowed.', code: 'TYPE_NOT_ALLOWED' }) };
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await expect(
      attachFile(client, PROJECT_ID, { task_id: TASK_UUID, file_path: '/work/evil.zip' }),
    ).rejects.toThrow('File type is not allowed.');
  });

  it('throws if the byte PUT fails', async () => {
    fsMock.readFile.mockResolvedValue(Buffer.from('hello'));
    const client = createInvokeClient(async () => ({
      data: {
        attachment_id: ATTACHMENT_ID,
        signed_url: 'https://storage.example/upload',
        object_key: 'k', token: 't', path: 'k',
      },
      error: null,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(
      attachFile(client, PROJECT_ID, { task_id: TASK_UUID, file_path: '/work/x.txt' }),
    ).rejects.toThrow('Failed to upload file bytes (500)');
  });

  it('uses an explicit filename override', async () => {
    fsMock.readFile.mockResolvedValue(Buffer.from('data'));
    const client = createInvokeClient(async (fn, opts) => {
      if (fn === 'attachments-create-upload') {
        expect(opts.body.filename).toBe('renamed.txt');
        return {
          data: { attachment_id: ATTACHMENT_ID, signed_url: 'https://up', object_key: 'k', token: 't', path: 'k' },
          error: null,
        };
      }
      return { data: { attachment_id: ATTACHMENT_ID, status: 'finalized', content_type: 'text/plain', byte_size: 4 }, error: null };
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const result = await attachFile(client, PROJECT_ID, {
      task_id: TASK_UUID,
      file_path: '/work/original.txt',
      filename: 'renamed.txt',
    });
    expect(result.filename).toBe('renamed.txt');
  });
});

// ── feature gating ───────────────────────────────────────────────────

describe('attachment feature gating', () => {
  it('registers the attachment tools when the module is on', () => {
    const names = registerTools({}).map((t) => t.name);
    expect(names).toContain('download_attachment');
    expect(names).toContain('attach_file');
  });

  it('omits the attachment tools when the module is off (absent, not errored)', () => {
    const names = registerTools({ attachments: true }).map((t) => t.name);
    expect(names).not.toContain('download_attachment');
    expect(names).not.toContain('attach_file');
    // core tools remain
    expect(names).toContain('get_task');
  });
});
