import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TypedDataEncoder, verifyTypedData, Wallet } from 'ethers';
import { receiptAuthorizationTypedData, type ReceiptAuthorizationInput } from '../src/dispute/ReceiptAuthorization';

const vector = JSON.parse(readFileSync(resolve(__dirname,
  '../../../DISPUTE SYSTEM/test-vectors/dispute/receipt-authorization-v1.json'), 'utf8')) as {
  input: ReceiptAuthorizationInput;
  typedData: ReturnType<typeof receiptAuthorizationTypedData>;
  digest: string;
  signature: string;
};

it('pins the shared receipt typed data, digest and deterministic signature exactly', async () => {
  const typed = receiptAuthorizationTypedData(vector.input);
  expect(typed).toEqual(vector.typedData);
  expect(TypedDataEncoder.hash(typed.domain, typed.types, typed.message)).toBe(vector.digest);
  const payer = new Wallet('0x' + '01'.repeat(32));
  expect(payer.address).toBe(vector.input.payer);
  expect(await payer.signTypedData(typed.domain, typed.types, typed.message)).toBe(vector.signature);
  expect(verifyTypedData(typed.domain, typed.types, typed.message, vector.signature)).toBe(vector.input.payer);
});

it('detects receipt field-order drift even when message values stay unchanged', () => {
  const typed = receiptAuthorizationTypedData(vector.input);
  const fields = typed.types.ReceiptAuthorization;
  if (!fields) throw new Error('Missing receipt type');
  const mutated = { ...typed, types: { ...typed.types, ReceiptAuthorization: [...fields].reverse() } };
  expect(mutated.message).toEqual(vector.typedData.message);
  expect(TypedDataEncoder.hash(mutated.domain, mutated.types, mutated.message)).not.toBe(vector.digest);
  expect(verifyTypedData(mutated.domain, mutated.types, mutated.message, vector.signature)).not.toBe(vector.input.payer);
});
