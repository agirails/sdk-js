/**
 * Buyer Link Module Tests (AIP-18 DEC-8).
 *
 * The buyer-link marker is the signal that lets a pure buyer (intent: pay) use
 * the gas-sponsored auto wallet even though it has no on-chain configHash and
 * no pending-publish. These tests cover save/load/has/delete and the
 * defensive behaviours (corrupt file, missing dir, network-agnostic load).
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BuyerLink,
  saveBuyerLink,
  loadBuyerLink,
  hasBuyerLink,
  deleteBuyerLink,
  getBuyerLinkPath,
} from './buyerLink';

const SAMPLE: BuyerLink = {
  version: 1,
  slug: 'my-buyer',
  wallet: '0x' + '11'.repeat(20),
  linkedAt: '2026-06-06T12:00:00.000Z',
};

describe('buyerLink', () => {
  let dir: string;
  const prevActpDir = process.env.ACTP_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buyerlink-'));
    process.env.ACTP_DIR = join(dir, '.actp');
  });

  afterEach(() => {
    if (prevActpDir === undefined) delete process.env.ACTP_DIR;
    else process.env.ACTP_DIR = prevActpDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null / false when no marker exists', () => {
    expect(loadBuyerLink()).toBeNull();
    expect(hasBuyerLink()).toBe(false);
  });

  it('saves and loads a marker (creating .actp/ on demand)', () => {
    saveBuyerLink(SAMPLE);
    expect(existsSync(getBuyerLinkPath())).toBe(true);
    expect(loadBuyerLink()).toEqual(SAMPLE);
    expect(hasBuyerLink()).toBe(true);
  });

  it('is network-agnostic — a marker saved once is found for any network', () => {
    saveBuyerLink(SAMPLE);
    expect(loadBuyerLink('base-sepolia')).toEqual(SAMPLE);
    expect(loadBuyerLink('base-mainnet')).toEqual(SAMPLE);
    expect(hasBuyerLink('base-mainnet')).toBe(true);
  });

  it('honours an explicit actpDir (publish writes beside the {slug}.md, not cwd)', () => {
    const projectActp = join(dir, 'some-project-root', '.actp');
    saveBuyerLink(SAMPLE, projectActp);

    // The marker is NOT in the default (cwd/ACTP_DIR) location...
    expect(loadBuyerLink()).toBeNull();
    expect(hasBuyerLink()).toBe(false);

    // ...but is found when the same project-root dir is supplied (what the
    // runtime client does when run from that project root).
    expect(getBuyerLinkPath(projectActp)).toBe(join(projectActp, 'buyer-link.json'));
    expect(loadBuyerLink(undefined, projectActp)).toEqual(SAMPLE);
    expect(hasBuyerLink(undefined, projectActp)).toBe(true);
  });

  it('deletes the marker (and is a no-op when already absent)', () => {
    saveBuyerLink(SAMPLE);
    deleteBuyerLink();
    expect(loadBuyerLink()).toBeNull();
    expect(() => deleteBuyerLink()).not.toThrow();
  });

  it('treats a corrupt marker as absent rather than crashing', () => {
    saveBuyerLink(SAMPLE);
    writeFileSync(getBuyerLinkPath(), '{ not valid json', 'utf-8');
    expect(loadBuyerLink()).toBeNull();
    expect(hasBuyerLink()).toBe(false);
  });

  it('writes the marker with owner-only (0o600) permissions', () => {
    saveBuyerLink(SAMPLE);
    const { statSync } = require('fs');
    const mode = statSync(getBuyerLinkPath()).mode & 0o777;
    // 0o600 on POSIX; on platforms that don't honour mode this is best-effort.
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });
});
