import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readDraftClaimCode } from './publish';

describe('readDraftClaimCode — draft adoption code resolution', () => {
  it('reads claim_code from the published file frontmatter (top-level)', () => {
    const content = `---\nname: x\nslug: my-agent\nclaim_code: TOP-CODE-1\n---\nbody`;
    expect(readDraftClaimCode(content, '/tmp/my-agent.md')).toBe('TOP-CODE-1');
  });

  it('reads claim_code nested under the agent: block', () => {
    const content = `---\nagent:\n  name: x\n  slug: my-agent\n  claim_code: NESTED-CODE-2\n---\nbody`;
    expect(readDraftClaimCode(content, '/tmp/my-agent.md')).toBe('NESTED-CODE-2');
  });

  it('falls back to a sibling owner AGIRAILS.md (agent block)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adopt-'));
    try {
      writeFileSync(
        join(dir, 'AGIRAILS.md'),
        `---\nagent:\n  slug: my-agent\n  claim_code: SIBLING-CODE-3\n---\nspec`,
      );
      const identityContent = `---\nname: x\nslug: my-agent\n---\nbody`; // no code in the published file
      expect(readDraftClaimCode(identityContent, join(dir, 'my-agent.md'))).toBe('SIBLING-CODE-3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the published file over the sibling when both have a code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adopt-'));
    try {
      writeFileSync(join(dir, 'AGIRAILS.md'), `---\nagent:\n  claim_code: SIBLING\n---\nspec`);
      const identityContent = `---\nslug: my-agent\nclaim_code: PUBLISHED\n---\nbody`;
      expect(readDraftClaimCode(identityContent, join(dir, 'my-agent.md'))).toBe('PUBLISHED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no code is present anywhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adopt-'));
    try {
      const identityContent = `---\nname: x\nslug: my-agent\n---\nbody`;
      expect(readDraftClaimCode(identityContent, join(dir, 'my-agent.md'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
