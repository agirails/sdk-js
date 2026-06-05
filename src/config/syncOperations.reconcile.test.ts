import { decideReconcile, ReconcileDecisionInput } from './syncOperations';

const ANCHOR = '0x' + 'a'.repeat(64);
const H_LOCAL = '0x' + 'b'.repeat(64);
const H_WEB = '0x' + 'c'.repeat(64);

function base(over: Partial<ReconcileDecisionInput> = {}): ReconcileDecisionInput {
  return {
    anchorHash: ANCHOR,
    localHash: ANCHOR,
    localMtimeMs: 1000,
    webHash: ANCHOR,
    webUpdatedAtMs: 1000,
    webHasContent: true,
    ...over,
  };
}

describe('decideReconcile — three-way local/web/chain', () => {
  it('in-sync when nothing changed from the anchor', () => {
    const d = decideReconcile(base());
    expect(d.action).toBe('in-sync');
    expect(d.needsPublish).toBe(false);
    expect(d.pullWebToLocal).toBe(false);
  });

  it('pull-web when only web changed', () => {
    const d = decideReconcile(base({ webHash: H_WEB }));
    expect(d.action).toBe('pull-web');
    expect(d.pullWebToLocal).toBe(true);
    expect(d.needsPublish).toBe(true);
    expect(d.snapshotLocal).toBe(false);
  });

  it('pull-web when web changed and there is no local file', () => {
    const d = decideReconcile(base({ webHash: H_WEB, localHash: null, localMtimeMs: 0 }));
    expect(d.action).toBe('pull-web');
    expect(d.pullWebToLocal).toBe(true);
  });

  it('push-local when only local changed', () => {
    const d = decideReconcile(base({ localHash: H_LOCAL }));
    expect(d.action).toBe('push-local');
    expect(d.needsPublish).toBe(true);
    expect(d.pullWebToLocal).toBe(false);
  });

  it('push-local when local changed and web has no config', () => {
    const d = decideReconcile(base({ localHash: H_LOCAL, webHash: null }));
    expect(d.action).toBe('push-local');
  });

  it('push-local (no conflict) when both changed to the SAME content', () => {
    const d = decideReconcile(base({ localHash: H_WEB, webHash: H_WEB }));
    expect(d.action).toBe('push-local');
    expect(d.snapshotLocal).toBe(false);
    expect(d.snapshotWeb).toBe(false);
  });

  it('conflict-web-wins when both changed and web is newer', () => {
    const d = decideReconcile(base({
      localHash: H_LOCAL, localMtimeMs: 1000,
      webHash: H_WEB, webUpdatedAtMs: 2000,
    }));
    expect(d.action).toBe('conflict-web-wins');
    expect(d.pullWebToLocal).toBe(true);
    expect(d.snapshotLocal).toBe(true);   // loser (local) is backed up
    expect(d.needsPublish).toBe(true);
  });

  it('conflict-local-wins when both changed and local is newer', () => {
    const d = decideReconcile(base({
      localHash: H_LOCAL, localMtimeMs: 5000,
      webHash: H_WEB, webUpdatedAtMs: 2000,
    }));
    expect(d.action).toBe('conflict-local-wins');
    expect(d.pullWebToLocal).toBe(false);
    expect(d.snapshotWeb).toBe(true);     // loser (web) is saved for reference
    expect(d.needsPublish).toBe(true);
  });

  it('ignores a web change we cannot apply (no content) — falls back to local', () => {
    const d = decideReconcile(base({ webHash: H_WEB, webHasContent: false, localHash: H_LOCAL }));
    expect(d.action).toBe('push-local');
  });

  it('treats missing web updatedAt as oldest (local wins the tie-break)', () => {
    const d = decideReconcile(base({
      localHash: H_LOCAL, localMtimeMs: 1,
      webHash: H_WEB, webUpdatedAtMs: null,
    }));
    expect(d.action).toBe('conflict-local-wins');
  });
});
