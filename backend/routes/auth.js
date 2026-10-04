const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, transaction, sql } = require('../db/connection');
const { authenticate, authorize } = require('../middleware/auth');

router.post('/login', async (req, res, next) => {
  try {
    const username = req.body.username || req.body.email;
    const password = req.body.password;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    // Treat the 'username' input from frontend as 'Email' in the new schema
    const result = await query(
      `SELECT u.UserID, u.Email AS Username, u.Password AS PasswordHash, u.Name AS FullName, u.Email, u.IsActive,
              r.RoleName, r.RoleID
       FROM [USER] u
       JOIN [ROLE] r ON u.RoleID = r.RoleID
       WHERE u.Email = @email`,
      { email: username }
    );

    if (!result.recordset.length) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const user = result.recordset[0];

    if (!user.IsActive) {
      return res.status(403).json({ success: false, message: 'Account is deactivated.' });
    }

    const isMatch = await bcrypt.compare(password, user.PasswordHash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    await query(
      `INSERT INTO AUDIT_LOG (UserID, Action, TableName, RecordID)
       VALUES (@userID, 'LOGIN', 'USER', @userID)`,
      { userID: user.UserID }
    );

    const token = jwt.sign(
      { userID: user.UserID, username: user.Username, role: user.RoleName, roleID: user.RoleID },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      token,
      user: {
        userID: user.UserID,
        username: user.Username,
        fullName: user.FullName,
        email: user.Email,
        role: user.RoleName,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.UserID, u.Email AS Username, u.Name AS FullName, u.Email, u.CreatedAt, r.RoleName
       FROM [USER] u JOIN [ROLE] r ON u.RoleID = r.RoleID
       WHERE u.UserID = @userID`,
      { userID: req.user.userID }
    );
    if (!result.recordset.length) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/users', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.UserID, u.Email AS Username, u.Name AS FullName, u.Email, u.IsActive, u.CreatedAt, r.RoleName
       FROM [USER] u
       JOIN [ROLE] r ON u.RoleID = r.RoleID
       ORDER BY u.CreatedAt DESC`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.post('/users', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { username, fullName, password, roleID } = req.body;
    if (!username || !fullName || !password || !roleID) {
      return res.status(400).json({ success: false, message: 'Required fields missing.' });
    }

    const dup = await query(`SELECT 1 FROM [USER] WHERE Email = @email`, { email: username });
    if (dup.recordset.length) return res.status(409).json({ success: false, message: 'Email already exists.' });

    const roleRes = await query(`SELECT RoleName FROM [ROLE] WHERE RoleID = @roleID`, { roleID });
    if (!roleRes.recordset.length) return res.status(400).json({ success: false, message: 'Invalid Role.' });
    
    // Map role to UserType
    const rName = roleRes.recordset[0].RoleName;
    let userType = 'Operator';
    if (rName === 'Admin') userType = 'Admin';
    if (rName === 'Field Officer') userType = 'FieldOfficer';
    if (rName === 'Warehouse Manager') userType = 'WHManager';
    if (rName === 'Finance Officer') userType = 'FinanceOfficer';

    const hash = await bcrypt.hash(password, 12);
    
    const result = await transaction(async (txn, sql) => {
       const req1 = new sql.Request(txn);
       req1.input('name', fullName);
       req1.input('email', username);
       req1.input('hash', hash);
       req1.input('roleID', roleID);
       req1.input('uType', userType);
       const ins = await req1.query(`
         INSERT INTO [USER] (RoleID, Name, Email, Password, UserType, IsActive)
         OUTPUT INSERTED.UserID, INSERTED.Email AS Username, INSERTED.Name AS FullName, INSERTED.Email, INSERTED.IsActive, INSERTED.CreatedAt
         VALUES (@roleID, @name, @email, @hash, @uType, 1)
       `);
       const newID = ins.recordset[0].UserID;
       
       // Insert into disjoint sub-tables
       const req2 = new sql.Request(txn);
       req2.input('uid', newID);
       if (userType === 'Admin') await req2.query(`INSERT INTO ADMINISTRATOR (AdminID) VALUES (@uid)`);
       if (userType === 'Operator') await req2.query(`INSERT INTO EMERGENCY_OPERATOR (OperatorID) VALUES (@uid)`);
       if (userType === 'FieldOfficer') await req2.query(`INSERT INTO FIELD_OFFICER (FieldOfficerID) VALUES (@uid)`);
       if (userType === 'WHManager') await req2.query(`INSERT INTO WAREHOUSE_MANAGER (WarehouseMgrID) VALUES (@uid)`);
       if (userType === 'FinanceOfficer') await req2.query(`INSERT INTO FINANCE_OFFICER (FinanceOfficerID) VALUES (@uid)`);

       return ins.recordset[0];
    });

    res.status(201).json({ success: true, message: 'User created.', data: result });
  } catch (err) {
    next(err);
  }
});

router.put('/users/:id', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { fullName, username, email, password } = req.body;
    const userID = parseInt(req.params.id);

    if (!fullName || !username) {
      return res.status(400).json({ success: false, message: 'Full name and username are required.' });
    }

    if (password && password.length > 0) {
      if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
      const hash = await bcrypt.hash(password, 12);
      await query(`UPDATE [USER] SET Name = @name, Email = @username, Password = @hash WHERE UserID = @userID`, { name: fullName, username, hash, userID });
    } else {
      await query(`UPDATE [USER] SET Name = @name, Email = @username WHERE UserID = @userID`, { name: fullName, username, userID });
    }
    
    await query(
      `INSERT INTO AUDIT_LOG (UserID, Action, TableName, RecordID, NewValue)
       VALUES (@uid, 'UPDATE', 'USER', @recordID, 'Updated user profile')`,
      { uid: req.user.userID, recordID: userID }
    );

    res.json({ success: true, message: 'User updated successfully.' });
  } catch (err) {
    if (err.number === 2627) return res.status(400).json({ success: false, message: 'Username already exists.' });
    next(err);
  }
});

router.put('/users/:id/status', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { isActive } = req.body;
    const userID = parseInt(req.params.id);
    if (userID === req.user.userID && !isActive) {
      return res.status(403).json({ success: false, message: 'Cannot deactivate yourself.' });
    }
    await query(`UPDATE [USER] SET IsActive = @isActive WHERE UserID = @userID`, { isActive: isActive ? 1 : 0, userID });
    res.json({ success: true, message: `User status updated.` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
