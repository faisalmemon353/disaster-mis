require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const sql = require('mssql/msnodesqlv8');

async function fixPasswords() {
  const connStr = `Driver={ODBC Driver 17 for SQL Server};Server=${process.env.DB_SERVER};Database=${process.env.DB_DATABASE};Trusted_Connection=yes;TrustServerCertificate=yes;`;
  
  const config = {
    driver: 'msnodesqlv8',
    connectionString: connStr,
  };

  const pool = await sql.connect(config);
  console.log('Connected to DB:', process.env.DB_DATABASE);

  const hash = await bcrypt.hash('Admin@123', 10);
  console.log('Generated bcrypt hash:', hash);
  console.log('Verify test:', await bcrypt.compare('Admin@123', hash));

  // Update all users with the correct bcrypt hash
  const users = await pool.request().query('SELECT UserID, Email FROM [USER]');
  
  for (const user of users.recordset) {
    await pool.request()
      .input('hash', sql.NVarChar, hash)
      .input('uid', sql.Int, user.UserID)
      .query('UPDATE [USER] SET Password = @hash WHERE UserID = @uid');
    console.log(`✅ Updated password for: ${user.Email}`);
  }

  // Also update emails to match the demo credentials shown on the login page
  const emailMap = [
    { id: 1, email: 'admin@dismis.pk' },
    { id: 2, email: 'operator@dismis.pk' },
    { id: 3, email: 'field01@dismis.pk' },
    { id: 4, email: 'warehouse@dismis.pk' },
    { id: 5, email: 'finance@dismis.pk' },
  ];

  for (const u of emailMap) {
    await pool.request()
      .input('email', sql.NVarChar, u.email)
      .input('uid', sql.Int, u.id)
      .query('UPDATE [USER] SET Email = @email WHERE UserID = @uid');
    console.log(`📧 Updated email for UserID ${u.id} → ${u.email}`);
  }

  console.log('\n🎉 Done! You can now login with:');
  console.log('   admin@dismis.pk     / Admin@123');
  console.log('   operator@dismis.pk  / Admin@123');
  console.log('   field01@dismis.pk   / Admin@123');
  console.log('   warehouse@dismis.pk / Admin@123');
  console.log('   finance@dismis.pk   / Admin@123');

  await pool.close();
}

fixPasswords().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
