import {
  AgreementTerms,
  AGREEMENT_SCHEMA_VERSION,
  ZERO_AGREEMENT_HASH,
  serializeAgreement,
  computeAgreementHash,
  agreementHash,
  validateAgreement,
  InvalidAgreementError,
  UnsupportedAgreementVersionError
} from './AgreementSerializer';

/**
 * Golden agreement vector — the cross-language anchor (TS ⇄ Py). The Python
 * twin test `python-sdk-v2/tests/test_builders/test_agreement.py` pins the
 * SAME canonical bytes + hash. If either drifts, the agreementHash preimage
 * serializer is no longer byte-identical across SDKs.
 */
const GOLDEN_AGREEMENT: AgreementTerms = {
  schemaVersion: '1.0.0',
  request: { service: 'summarize', url: 'https://example.com/doc' },
  input: { lang: 'en', maxTokens: 500 },
  sla: { deadlineSeconds: 3600, minQualityBps: 9000 }
};
const GOLDEN_CANONICAL =
  '{"input":{"lang":"en","maxTokens":500},"request":{"service":"summarize","url":"https://example.com/doc"},"schemaVersion":"1.0.0","sla":{"deadlineSeconds":3600,"minQualityBps":9000}}';
const GOLDEN_AGREEMENT_HASH =
  '0xb2ef8cf734173588408b48793a43cc53e86f1f3d5702778a29f4460f5c8e9db4';

describe('AgreementSerializer (AIP-14c D3 agreementHash preimage)', () => {
  it('serializes to the frozen canonical bytes (sorted keys, no whitespace)', () => {
    expect(serializeAgreement(GOLDEN_AGREEMENT)).toBe(GOLDEN_CANONICAL);
  });

  it('computes the golden agreementHash (cross-language anchor)', () => {
    expect(computeAgreementHash(GOLDEN_AGREEMENT)).toBe(GOLDEN_AGREEMENT_HASH);
    expect(agreementHash(GOLDEN_AGREEMENT)).toBe(GOLDEN_AGREEMENT_HASH);
  });

  it('is order-insensitive at the input level (canonical sort)', () => {
    const reordered: AgreementTerms = {
      sla: { minQualityBps: 9000, deadlineSeconds: 3600 },
      input: { maxTokens: 500, lang: 'en' },
      request: { url: 'https://example.com/doc', service: 'summarize' },
      schemaVersion: '1.0.0'
    };
    expect(computeAgreementHash(reordered)).toBe(GOLDEN_AGREEMENT_HASH);
  });

  it('exposes the frozen schema version + zero sentinel', () => {
    expect(AGREEMENT_SCHEMA_VERSION).toBe('1.0.0');
    expect(ZERO_AGREEMENT_HASH).toBe('0x' + '0'.repeat(64));
  });

  it('rejects a missing required key', () => {
    expect(() => validateAgreement({ schemaVersion: '1.0.0', request: {}, input: {} })).toThrow(
      InvalidAgreementError
    );
  });

  it('rejects an unexpected extra key (no additional properties)', () => {
    expect(() =>
      validateAgreement({ schemaVersion: '1.0.0', request: {}, input: {}, sla: {}, quote: {} })
    ).toThrow(InvalidAgreementError);
  });

  it('rejects a non-object', () => {
    expect(() => validateAgreement('nope' as unknown)).toThrow(InvalidAgreementError);
    expect(() => validateAgreement([] as unknown)).toThrow(InvalidAgreementError);
  });

  it('rejects an unsupported major schema version', () => {
    expect(() =>
      computeAgreementHash({ schemaVersion: '2.0.0', request: {}, input: {}, sla: {} })
    ).toThrow(UnsupportedAgreementVersionError);
  });
});
