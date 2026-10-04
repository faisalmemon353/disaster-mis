const express = require('express');
const router = express.Router();
const { query } = require('../db/connection');
const { authenticate } = require('../middleware/auth');

// Get Users with optional role filter
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { role } = req.query;
    let sqlQuery = `SELECT * FROM [USER]`; // Start simple
    
    // We'll try the join, but wrap it in an error message catch
    try {
      sqlQuery = `
        SELECT u.UserID, u.Name, u.Email, r.RoleName AS Role
      FROM [USER] u
      JOIN [ROLE] r ON u.RoleID = r.RoleID
    `;
    const params = {};

    if (role) {
      sqlQuery += ` WHERE r.RoleName = '${role}'`;
    }
      
    const result = await query(sqlQuery);
      return res.json({ success: true, data: result.recordset });
    } catch (dbErr) {
      // If JOIN fails, maybe tables are named differently?
      console.error('User list query failed:', dbErr.message);
      return res.status(500).json({ 
        success: false, 
        message: `DB Error: ${dbErr.message}`,
        suggestion: 'Ensure [USER] and [ROLE] tables exist and RoleID column matches.'
      });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
