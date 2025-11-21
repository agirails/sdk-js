/**
 * Update Schema UID After Deployment
 * Run after deployEASSchema.ts completes
 *
 * Usage:
 *   npx tsx scripts/updateSchemaUID.ts <SCHEMA_UID>
 *
 * Example:
 *   npx tsx scripts/updateSchemaUID.ts 0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab
 */

import fs from 'fs';
import path from 'path';

const SCHEMA_UID_REGEX = /^0x[a-fA-F0-9]{64}$/;

async function main() {
  const schemaUID = process.argv[2];

  // Validate input
  if (!schemaUID) {
    console.error('❌ ERROR: Schema UID required');
    console.error('\nUsage:');
    console.error('  npx tsx scripts/updateSchemaUID.ts <SCHEMA_UID>');
    console.error('\nExample:');
    console.error('  npx tsx scripts/updateSchemaUID.ts 0xabcd1234...');
    process.exit(1);
  }

  if (!SCHEMA_UID_REGEX.test(schemaUID)) {
    console.error('❌ ERROR: Invalid schema UID format');
    console.error('Expected: 0x followed by 64 hex characters');
    console.error(`Got: ${schemaUID}`);
    process.exit(1);
  }

  console.log('🔧 Updating schema UID in all files...\n');

  // Files to update
  const updates = [
    {
      file: path.join(__dirname, '../src/builders/DeliveryProofBuilder.ts'),
      search: /export const AGIRAILS_DELIVERY_SCHEMA_UID = '0x0+';.*$/m,
      replace: `export const AGIRAILS_DELIVERY_SCHEMA_UID = '${schemaUID}';`
    },
    {
      file: path.join(__dirname, '../../docs/schemas/aip-4-delivery.eip712.json'),
      search: /"schemaUID":\s*"<PENDING>"/,
      replace: `"schemaUID": "${schemaUID}"`
    },
    {
      file: path.join(__dirname, '../../docs/AIP-4.md'),
      search: /Schema UID:\s*`<PENDING[^`]*>`/,
      replace: `Schema UID: \`${schemaUID}\``
    }
  ];

  let successCount = 0;
  let failCount = 0;

  for (const { file, search, replace } of updates) {
    try {
      if (!fs.existsSync(file)) {
        console.warn(`⚠️  File not found: ${file}`);
        failCount++;
        continue;
      }

      const content = fs.readFileSync(file, 'utf8');

      if (!search.test(content)) {
        console.warn(`⚠️  Pattern not found in: ${file}`);
        console.warn(`    Looking for: ${search}`);
        failCount++;
        continue;
      }

      const updated = content.replace(search, replace);
      fs.writeFileSync(file, updated, 'utf8');

      console.log(`✅ Updated: ${path.relative(process.cwd(), file)}`);
      successCount++;
    } catch (error) {
      console.error(`❌ Error updating ${file}:`, error);
      failCount++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   ✅ ${successCount} files updated`);
  console.log(`   ❌ ${failCount} files failed`);

  if (failCount > 0) {
    console.log('\n⚠️  Some files were not updated. Please check warnings above.');
    process.exit(1);
  }

  console.log('\n✅ All files updated successfully!');
  console.log('\n📝 Next Steps:');
  console.log('1. Review changes:');
  console.log('   git diff src/builders/DeliveryProofBuilder.ts');
  console.log('   git diff ../docs/schemas/aip-4-delivery.eip712.json');
  console.log('   git diff ../docs/AIP-4.md');
  console.log('\n2. Rebuild SDK:');
  console.log('   npm run build');
  console.log('\n3. Run tests:');
  console.log('   npm test');
  console.log('\n4. Commit changes:');
  console.log(`   git add -A && git commit -m "chore: update EAS schema UID to ${schemaUID.substring(0, 10)}..."`);
  console.log('\n5. Verify attestation creation:');
  console.log('   npm run test:eas-attestation');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
