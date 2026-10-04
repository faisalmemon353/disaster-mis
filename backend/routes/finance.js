const express = require('express');
const router = express.Router();
const { query, transaction, sql } = require('../db/connection');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/transactions', authenticate, authorize('Admin', 'Finance Officer'), async (req, res, next) => {
  try {
    const { type, page = 1, limit = 25 } = req.query;
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params = {};

    if (type) { where += ' AND t.TransType = @type'; params.type = type; }
    params.offset = { type: sql.Int, value: parseInt(offset) };
    params.limit = { type: sql.Int, value: parseInt(limit) };

    const result = await query(
      `SELECT t.TransactionID, t.TransType AS TransactionType, t.Amount, 'PKR' AS Currency,
              t.Description, t.TxDate AS TransactionDate,
              u.Name AS RecordedBy,
              d.DisasterType AS DisasterEvent,
              COALESCE(e.Category, p.ItemDescription, 'Donation') AS Category,
              don.DonorType AS DonorType,
              COALESCE(ind.DonorName, org.OrgName, e.Vendor, p.Supplier, '—') AS PartyName,
              COALESCE(ind.DonorContact, org.OrgContact, '') AS PartyContact
       FROM FINANCIAL_TRANSACTION t
       LEFT JOIN FINANCE_OFFICER fo ON t.FinanceOfficerID = fo.FinanceOfficerID
       LEFT JOIN [USER] u ON fo.FinanceOfficerID = u.UserID
       LEFT JOIN DISASTER_EVENT d ON t.EventID = d.EventID
       LEFT JOIN EXPENSE e ON t.TransactionID = e.TransactionID
       LEFT JOIN PROCUREMENT p ON t.TransactionID = p.TransactionID
       LEFT JOIN DONATION don ON t.TransactionID = don.TransactionID
       LEFT JOIN INDIVIDUAL_DONATION ind ON don.TransactionID = ind.TransactionID
       LEFT JOIN ORG_DONATION org ON don.TransactionID = org.TransactionID
       ${where}
       ORDER BY t.TxDate DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      params
    );

    const totalResult = await query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN TransType='Donation' THEN Amount ELSE 0 END) AS totalDonations,
              SUM(CASE WHEN TransType='Expense' THEN Amount ELSE 0 END) AS totalExpenses,
              SUM(CASE WHEN TransType='Procurement' THEN Amount ELSE 0 END) AS totalProcurement
       FROM FINANCIAL_TRANSACTION t ${where}`,
      params
    );

    res.json({
      success: true,
      data: result.recordset,
      summary: totalResult.recordset[0],
      pagination: { total: totalResult.recordset[0].total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/events', authenticate, async (req, res, next) => {
  try {
    const result = await query(`SELECT EventID, DisasterType, Location, Status FROM DISASTER_EVENT WHERE Status != 'Closed' ORDER BY StartTime DESC`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.post('/transactions', authenticate, authorize('Admin', 'Finance Officer'), async (req, res, next) => {
  try {
    const { transactionType, amount, description, category, disasterEventID, entityName, quantity, donorType, donorId } = req.body;
    if (!transactionType || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Type and positive amount required.' });
    }

    const result = await transaction(async (txn, sql) => {
      // Create Base Transaction
      const base = new sql.Request(txn);
      base.input('evID', disasterEventID || 1); // default event if not specified
      base.input('uid', req.user.userID); // Will map to FinanceOfficerID
      base.input('type', transactionType);
      base.input('amt', amount);
      base.input('desc', description || null);

      // Ensure user exists in FINANCE_OFFICER
      const checkFO = new sql.Request(txn);
      checkFO.input('uid', req.user.userID);
      const foRes = await checkFO.query(`SELECT FinanceOfficerID FROM FINANCE_OFFICER WHERE FinanceOfficerID = @uid`);
      if (foRes.recordset.length === 0) {
        const insFO = new sql.Request(txn);
        insFO.input('uid', req.user.userID);
        await insFO.query(`INSERT INTO FINANCE_OFFICER (FinanceOfficerID, Department) VALUES (@uid, 'Admin Override')`);
      }

      const txnRes = await base.query(`
        INSERT INTO FINANCIAL_TRANSACTION (EventID, FinanceOfficerID, TransType, Amount, Description)
        OUTPUT INSERTED.TransactionID, INSERTED.TxDate
        VALUES (@evID, @uid, @type, @amt, @desc)
      `);
      const tID = txnRes.recordset[0].TransactionID;

      // Create Subtype
      const sub = new sql.Request(txn);
      sub.input('tid', tID);
      sub.input('cat', category || 'General');
      sub.input('entity', entityName || 'Unknown');
      sub.input('qty', quantity || 1);
      
      if (transactionType === 'Expense') {
        await sub.query(`INSERT INTO EXPENSE (TransactionID, Category, Vendor) VALUES (@tid, @cat, @entity)`);
      } else if (transactionType === 'Procurement') {
        await sub.query(`INSERT INTO PROCUREMENT (TransactionID, ItemDescription, Supplier, Quantity) VALUES (@tid, @cat, @entity, @qty)`);
      } else if (transactionType === 'Donation') {
        const dType = donorType === 'Organization' ? 'Organization' : 'Individual';
        await sub.query(`INSERT INTO DONATION (TransactionID, DonorType) VALUES (@tid, '${dType}')`);
        
        const donSub = new sql.Request(txn);
        donSub.input('tid', tID);
        donSub.input('name', entityName === 'Unknown' ? 'Anonymous' : entityName);
        donSub.input('did', donorId || null);
        donSub.input('contact', req.body.donorContact || null);

        if (dType === 'Organization') {
          await donSub.query(`INSERT INTO ORG_DONATION (TransactionID, OrgName, OrgNTN, OrgContact) VALUES (@tid, @name, @did, @contact)`);
        } else {
          await donSub.query(`INSERT INTO INDIVIDUAL_DONATION (TransactionID, DonorName, DonorCNIC, DonorContact) VALUES (@tid, @name, @did, @contact)`);
        }
      }

      // Financial Audit
      const aud = new sql.Request(txn);
      aud.input('tid', tID);
      aud.input('uid', req.user.userID);
      await aud.query(`INSERT INTO FINANCIAL_AUDIT (TransactionID, ApprovedBy, Remarks) VALUES (@tid, @uid, 'Auto-approved')`);

      return txnRes.recordset[0];
    });

    res.status(201).json({ success: true, message: 'Transaction recorded.', data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/summary', authenticate, authorize('Admin', 'Finance Officer'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         SUM(CASE WHEN TransType='Donation' THEN Amount ELSE 0 END) AS totalDonations,
         SUM(CASE WHEN TransType='Expense' THEN Amount ELSE 0 END) AS totalExpenses,
         SUM(CASE WHEN TransType='Procurement' THEN Amount ELSE 0 END) AS totalProcurement,
         SUM(CASE WHEN TransType='Donation' THEN Amount ELSE 0 END) -
         SUM(CASE WHEN TransType IN ('Expense','Procurement') THEN Amount ELSE 0 END) AS netBalance,
         COUNT(*) AS totalTransactions
       FROM FINANCIAL_TRANSACTION`
    );

    const trend = await query(
      `SELECT FORMAT(TxDate, 'yyyy-MM') AS Month,
              SUM(CASE WHEN TransType='Donation' THEN Amount ELSE 0 END) AS donations,
              SUM(CASE WHEN TransType='Expense' THEN Amount ELSE 0 END) AS expenses
       FROM FINANCIAL_TRANSACTION
       WHERE TxDate >= DATEADD(month, -6, GETDATE())
       GROUP BY FORMAT(TxDate, 'yyyy-MM')
       ORDER BY Month`
    );

    res.json({ success: true, data: { ...result.recordset[0], monthlyTrend: trend.recordset } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
