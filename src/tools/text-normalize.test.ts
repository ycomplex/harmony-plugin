// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { normalizeHtmlEntities, validateTitle } from './text-normalize.js';

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

describe('validateTitle (B-1033)', () => {
  describe('length', () => {
    it('throws with the exact message for a 201-char title', () => {
      const title = 'a'.repeat(201);
      expect(() => validateTitle(title)).toThrow('Title exceeds 200 characters (received 201).');
    });

    it('does not throw for a title of exactly 200 chars', () => {
      const title = 'a'.repeat(200);
      expect(() => validateTitle(title)).not.toThrow();
    });
  });

  // Real specimen shapes that corrupted B-1021, B-1030, and B-1032: a stray
  // tool-call XML fragment (a closing </title>, a <parameter> tag) landed in
  // the title field instead of the intended body. These fixtures are
  // truncated/reconstructed plausibly -- the original ~4000-char bodies
  // aren't preserved verbatim -- but the leading shape that triggered the bug
  // is pinned here so a future reader knows why these are fixtures.
  describe('markup', () => {
    it('throws quoting the fragment for a stray leading </title> (B-1021 shape)', () => {
      const title = '</title>\n<parameter name="description">Some body text here...';
      expect(() => validateTitle(title)).toThrow('Title contains disallowed markup: `</title>`');
    });

    it('throws quoting the fragment for a mid-string <parameter> tag (B-1030 shape)', () => {
      const title = 'Fix the login flow <parameter name="foo"> for real this time';
      expect(() => validateTitle(title)).toThrow(
        'Title contains disallowed markup: `<parameter name="foo">`',
      );
    });

    it('throws quoting the fragment for a title that is just a tag pair (B-1032 shape)', () => {
      const title = '<title>Something</title>';
      expect(() => validateTitle(title)).toThrow('Title contains disallowed markup: `<title>`');
    });
  });

  describe('line breaks', () => {
    it('throws the exact message for a title containing \\n with no markup', () => {
      expect(() => validateTitle('First line\nSecond line')).toThrow(
        'Title cannot contain a line break.',
      );
    });
  });

  describe('positive control', () => {
    it('does not throw for a normal one-sentence title with an em dash and an apostrophe', () => {
      expect(() => validateTitle("Don't ship — it's not ready yet")).not.toThrow();
    });
  });
});
