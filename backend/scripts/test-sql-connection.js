const sql = require('mssql/msnodesqlv8');

const serversToTry = [
  'localhost',
  '(local)',
  '(localdb)\\MSSQLLocalDB',
  'localhost\\SQLEXPRESS',
  '127.0.0.1'
];

async function testConnection(server) {
  const config = {
    server: server,
    database: 'master',
    driver: 'msnodesqlv8',
    options: {
      trustedConnection: true,
      trustServerCertificate: true
    }
  };

  try {
    const pool = await sql.connect(config);
    console.log(`✅ Success with server: ${server}`);
    await pool.close();
    return true;
  } catch (err) {
    console.log(`❌ Failed with server: ${server} (${err.message})`);
    return false;
  }
}

async function runTests() {
  for (const s of serversToTry) {
    console.log(`Testing ${s}...`);
    const success = await testConnection(s);
    if (success) {
      console.log(`\n\nUSE "${s}" in your .env for DB_SERVER!`);
      process.exit(0);
    }
  }
  console.log('\n\nAll automated connection attempts failed. You may need to manually specify your SQL Server Instance Name.');
  process.exit(1);
}

runTests();
