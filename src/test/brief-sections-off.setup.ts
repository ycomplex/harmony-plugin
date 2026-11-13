// B-1305: every test file starts with the brief-section declaration reader answering "none", so an
// unrelated compose_brief test never shells out to git or fetches over the network. Tests that exercise
// project sections pass their own reader (composeBrief's options, or setDefaultBriefSectionReader).
import { beforeEach } from 'vitest';
import { setDefaultBriefSectionReader } from '../tools/brief-project-sections.js';

beforeEach(() => {
  setDefaultBriefSectionReader(async () => ({ kind: 'none' }));
});
