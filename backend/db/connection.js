require('dotenv').config();
const sql = process.env.DB_USE_WINDOWS_AUTH === 'true' ? require('mssql/msnodesqlv8') : require('mssql');

function buildConfig() {
  const baseConfig = {
    server: process.env.DB_SERVER || 'localhost',
    database: process.env.DB_DATABASE || 'disaster_mis',
    options: {
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true',
      enableArithAbort: true,
    },
    pool: {
      max: 20,
      min: 2,
      idleTimeoutMillis: 30000,
    },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  };

  if (process.env.DB_USE_WINDOWS_AUTH === 'true') {
    baseConfig.driver = 'msnodesqlv8';
    baseConfig.options.trustedConnection = true;
    // When using named pipes/local connections with msnodesqlv8, port is often omitted
    if (process.env.DB_PORT) {
       baseConfig.port = parseInt(process.env.DB_PORT);
    }
  } else {
    baseConfig.port = parseInt(process.env.DB_PORT) || 1433;
    baseConfig.user = process.env.DB_USER;
    baseConfig.password = process.env.DB_PASSWORD;
  }
  return baseConfig;
}

const config = buildConfig();
let pool = null;

const getPool = async () => {
  if (pool && pool.connected) return pool;
  try {
    if (process.env.DB_USE_WINDOWS_AUTH === 'true') {
      const connStr = `Server=${config.server};Database=${config.database};Trusted_Connection=yes;Driver={SQL Server Native Client 11.0};`;
      // Let's rely on config object first, but add connectionString
      config.connectionString = `Driver={ODBC Driver 17 for SQL Server};Server=${config.server};Database=${config.database};Trusted_Connection=yes;TrustServerCertificate=yes;`;
    }
    pool = await sql.connect(config);
    console.log('[DB] Connected to MSSQL:', config.database);
    return pool;
  } catch (err) {
    console.error('[DB] Connection failed:', err);
    throw err;
  }
};

const query = async (queryString, params = {}) => {
  const db = await getPool();
  const request = db.request();

  for (const [key, val] of Object.entries(params)) {
    if (val && typeof val === 'object' && val.type) {
      request.input(key, val.type, val.value);
    } else {
      request.input(key, val);
    }
  }

  return await request.query(queryString);
};

const transaction = async (callback) => {
  const db = await getPool();
  const txn = new sql.Transaction(db);
  await txn.begin();
  try {
    const result = await callback(txn, sql);
    await txn.commit();
    return result;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
};

const closePool = async () => {
  if (pool) {
    await pool.close();
    pool = null;
    console.log('[DB] Pool closed.');
  }
};

module.exports = { getPool, query, transaction, closePool, sql };
