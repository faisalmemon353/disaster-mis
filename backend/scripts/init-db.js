

const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('../db/connection');

const SCHEMA_PATH = path.join(__dirname, '../../database/schema.sql');

async function run() {
  console.log('📖 Reading schema file:', SCHEMA_PATH);
  const raw = fs.readFileSync(SCHEMA_PATH, 'utf-8');


  const batches = raw
    .split(/\n\s*GO\s*\n/i)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  console.log(`🔧 Found ${batches.length} batch(es) to execute.\n`);

  const pool = await getPool();
  let executed = 0;
  let skipped = 0;

  for (let i = 0; i < batches.length; i++) {
    let batch = batches[i];

    // Skip CREATE DATABASE blocks — Azure SQL databases are pre-created
    if (/CREATE\s+DATABASE/i.test(batch)) {
      console.log(`⏭️  Batch ${i + 1}: skipped (CREATE DATABASE not allowed on Azure SQL user DB)`);
      skipped++;
      continue;
    }

 
    const hasExecutable = batch.split('\n').some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('--') && !trimmed.startsWith('/*') && !trimmed.startsWith('*') && !trimmed.startsWith('PRINT');
    });
    if (!hasExecutable) {
      console.log(`⏭️  Batch ${i + 1}: skipped (comments/print only)`);
      skipped++;
      continue;
    }

    try {
      await pool.request().batch(batch);
      executed++;
      console.log(` Batch ${i + 1}: executed (${batch.length} chars)`);
    } catch (err) {
      console.error(`\n Batch ${i + 1} FAILED:`);
      console.error(err.message);
      console.error('\n--- BATCH PREVIEW (first 300 chars) ---');
      console.error(batch.substring(0, 300));
      console.error('--- END PREVIEW ---\n');
    
    }
  }

  console.log(`\n Done. Executed: ${executed}, Skipped: ${skipped}, Total: ${batches.length}`);
  await closePool();
  process.exit(0);
}

run().catch((err) => {
  console.error(' Fatal error:', err.message);
  process.exit(1);
});

