// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { normalizeHtmlEntities } from './text-normalize.js';

describe('normalizeHtmlEntities', () => {
  it('returns plain text with no entities unchanged', () => {
    const input = 'Nothing to see here.';
    expect(normalizeHtmlEntities(input)).toBe(input);
  });
});

describe('normalizeHtmlEntities more', () => {
  it('returns empty string unchanged', () => {
    expect(normalizeHtmlEntities('')).toBe('');
  });

  it('decodes all 5 named entities outside of code', () => {
    const input = 'Tom &amp; Jerry &lt;tag&gt; say &quot;hi&quot; &#39;quote&#39;';
    const expected = 'Tom & Jerry <tag> say "hi" \'quote\'';
    expect(normalizeHtmlEntities(input)).toBe(expected);
  });
});

describe('genuinely-mangled cases (the actual defect this ticket fixes)', () => {
  it('normalizes a genuinely-mangled title', () => {
    const mangled = 'Fix &quot;Save &amp; Continue&quot; button on signup';
    const fixed = 'Fix "Save & Continue" button on signup';
    expect(normalizeHtmlEntities(mangled)).toBe(fixed);
  });

  it('normalizes a genuinely-mangled description with mixed entities', () => {
    const mangled = 'When A &lt; B &amp;&amp; B &gt; C, the check fails.';
    const fixed = 'When A < B && B > C, the check fails.';
    expect(normalizeHtmlEntities(mangled)).toBe(fixed);
  });
});

describe('intentional literal outside code (accepted residual, not a bug)', () => {
  it('normalizes an intentional literal entity written in prose', () => {
    const input = 'The template escapes ampersands as &amp; before rendering.';
    const result = normalizeHtmlEntities(input);
    expect(result).toBe('The template escapes ampersands as & before rendering.');
  });
});

describe('code-quoted text stays byte-identical', () => {
  it('leaves an inline code span byte-identical', () => {
    const input = 'Use the literal `&amp;` entity in your XML.';
    expect(normalizeHtmlEntities(input)).toBe(input);
  });
});

describe('fenced code blocks stay byte-identical', () => {
  it('leaves a fenced code block byte-identical', () => {
    const input = [
      'Here is the escaped payload:',
      '```',
      'const s = "Tom &amp; Jerry &lt;3&gt;";',
      '```',
      'End of example.',
    ].join('\n');
    expect(normalizeHtmlEntities(input)).toBe(input);
  });
});

describe('mixed code and prose', () => {
  it('normalizes prose outside a fenced block while leaving the block itself untouched', () => {
    const input = [
      'Title has &amp; mangled text.',
      '```',
      'raw &amp; stays raw',
      '```',
      'Trailing &lt;note&gt; also mangled.',
    ].join('\n');
    const expected = [
      'Title has & mangled text.',
      '```',
      'raw &amp; stays raw',
      '```',
      'Trailing <note> also mangled.',
    ].join('\n');
    expect(normalizeHtmlEntities(input)).toBe(expected);
  });

  it('normalizes prose outside an inline code span while leaving the span itself untouched', () => {
    const input = 'Bad &amp; good, but `keep &amp; verbatim` in code, then &lt;more&gt;.';
    const expected = 'Bad & good, but `keep &amp; verbatim` in code, then <more>.';
    expect(normalizeHtmlEntities(input)).toBe(expected);
  });

  it('treats an unterminated fenced block as code through end-of-string', () => {
    const input = 'Before.\n```\nunterminated &amp; block continues';
    expect(normalizeHtmlEntities(input)).toBe(input);
  });
});

describe('idempotence', () => {
  it('is idempotent -- normalizing an already-normalized string is a no-op', () => {
    const once = normalizeHtmlEntities('Save &amp; Continue');
    const twice = normalizeHtmlEntities(once);
    expect(twice).toBe(once);
    expect(once).toBe('Save & Continue');
  });
});
