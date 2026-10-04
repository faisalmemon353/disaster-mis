const express = require('express');
const router = express.Router();
const { query } = require('../db/connection');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/dashboard', authenticate, async (req, res, next) => {
  try {
    const [reports, teams, resources, hospitals, finance] = await Promise.all([
      query(`SELECT
               COUNT(*) AS total,
               SUM(CASE WHEN Status='Pending' THEN 1 ELSE 0 END) AS pending,
               SUM(CASE WHEN Status='Active' THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN Status='Resolved' THEN 1 ELSE 0 END) AS resolved,
               SUM(CASE WHEN SeverityLevel=5 THEN 1 ELSE 0 END) AS critical,
               SUM(CASE WHEN TimeOfReport >= DATEADD(hour,-24,GETDATE()) THEN 1 ELSE 0 END) AS last24h
             FROM EMERGENCY_REPORT`),
      query(`SELECT
               COUNT(*) AS total,
               SUM(CASE WHEN AvailabilityStatus='Available' THEN 1 ELSE 0 END) AS available,
               SUM(CASE WHEN AvailabilityStatus='On Mission' THEN 1 ELSE 0 END) AS assigned
             FROM RESCUE_TEAM`),
      query(`SELECT
               COUNT(*) AS totalItems,
               SUM(CASE WHEN QtyAvailable<=Threshold THEN 1 ELSE 0 END) AS lowStock,
               (SELECT COUNT(*) FROM APPROVAL_REQUEST WHERE Status='Pending') AS pendingRequests
             FROM RESOURCE`),
      query(`SELECT
               SUM(TotalBeds) AS totalBeds,
               SUM(AvailableBeds) AS availableBeds,
               COUNT(*) AS totalHospitals
             FROM HOSPITAL WHERE HospitalStatus='Functional'`),
      query(`SELECT
               SUM(CASE WHEN TransType='Donation' THEN Amount ELSE 0 END) AS donations,
               SUM(CASE WHEN TransType='Expense' THEN Amount ELSE 0 END) AS expenses,
               SUM(CASE WHEN TransType='Donation' THEN Amount ELSE 0 END) -
               SUM(CASE WHEN TransType IN ('Expense','Procurement') THEN Amount ELSE 0 END) AS balance
             FROM FINANCIAL_TRANSACTION`),
    ]);

    res.json({
      success: true,
      data: {
        reports: reports.recordset[0],
        teams: teams.recordset[0],
        resources: resources.recordset[0],
        hospitals: hospitals.recordset[0],
        finance: finance.recordset[0],
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/incidents', authenticate, async (req, res, next) => {
  try {
    const [byType, bySeverity, byDay, responseTime] = await Promise.all([
      query(`SELECT ISNULL(d.DisasterType, 'Other') AS DisasterType, COUNT(*) AS count
             FROM EMERGENCY_REPORT r LEFT JOIN DISASTER_EVENT d ON r.EventID = d.EventID
             GROUP BY d.DisasterType ORDER BY count DESC`),
      query(`SELECT CASE SeverityLevel WHEN 5 THEN 'Critical' WHEN 4 THEN 'High' WHEN 3 THEN 'Medium' ELSE 'Low' END AS SeverityLevel, COUNT(*) AS count
             FROM EMERGENCY_REPORT
             GROUP BY SeverityLevel`),
      query(`SELECT FORMAT(TimeOfReport,'yyyy-MM-dd') AS day, COUNT(*) AS count
             FROM EMERGENCY_REPORT
             WHERE TimeOfReport >= DATEADD(day,-30,GETDATE())
             GROUP BY FORMAT(TimeOfReport,'yyyy-MM-dd')
             ORDER BY day`),
      query(`SELECT
               AVG(DATEDIFF(minute, r.TimeOfReport, ta.AssignedAt)) AS avgResponseMinutes,
               MIN(DATEDIFF(minute, r.TimeOfReport, ta.AssignedAt)) AS minResponseMinutes,
               MAX(DATEDIFF(minute, r.TimeOfReport, ta.AssignedAt)) AS maxResponseMinutes
             FROM EMERGENCY_REPORT r
             JOIN TEAM_ASSIGNMENT ta ON r.EventID = ta.EventID
             WHERE ta.AssignedAt IS NOT NULL`),
    ]);

    res.json({
      success: true,
      data: {
        byType: byType.recordset,
        bySeverity: bySeverity.recordset,
        dailyTrend: byDay.recordset,
        responseTime: responseTime.recordset[0],
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/resources-usage', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT r.ResourceName, r.ResourceType, r.Unit,
              ISNULL(SUM(ra.QtyDispatched),0) AS totalAllocated,
              r.QtyAvailable AS remaining
       FROM RESOURCE r
       LEFT JOIN RESOURCE_ALLOCATION ra ON r.ResourceID = ra.ResourceID
       GROUP BY r.ResourceID, r.ResourceName, r.ResourceType, r.Unit, r.QtyAvailable
       ORDER BY totalAllocated DESC`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.get('/audit-log', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const result = await query(
      `SELECT * FROM (
        SELECT 
          al.LogID, 
          al.Action, 
          al.TableName, 
          COALESCE(al.NewValue, CASE WHEN al.Action = 'LOGIN' THEN 'User authenticated via web portal' ELSE '—' END) AS Details, 
          NULL AS IPAddress,
          al.Timestamp, 
          u.Name AS UserFullName, 
          u.Email AS Username
        FROM AUDIT_LOG al
        LEFT JOIN [USER] u ON al.UserID = u.UserID

        UNION ALL

        SELECT 
          ah.HistoryID + 100000 AS LogID, 
          ah.ActionTaken AS Action, 
          'APPROVAL_REQUEST' AS TableName, 
          CONCAT('Decision on Request #', ah.ApprovalID) AS Details, 
          NULL AS IPAddress,
          ah.ActionDate AS Timestamp, 
          u.Name AS UserFullName, 
          u.Email AS Username
        FROM APPROVAL_HISTORY ah
        LEFT JOIN [USER] u ON ah.ActionBy = u.UserID

        UNION ALL

        SELECT 
          fa.AuditID + 200000 AS LogID, 
          'TRANSACTION' AS Action, 
          'FINANCIAL' AS TableName, 
          CONCAT('Recorded ', ft.TransType, ' of PKR ', ft.Amount) AS Details, 
          NULL AS IPAddress,
          fa.AuditDate AS Timestamp, 
          u.Name AS UserFullName, 
          u.Email AS Username
        FROM FINANCIAL_AUDIT fa
        JOIN FINANCIAL_TRANSACTION ft ON fa.TransactionID = ft.TransactionID
        LEFT JOIN [USER] u ON fa.ApprovedBy = u.UserID
      ) Combined
      ORDER BY Timestamp DESC
      OFFSET ${parseInt(offset)} ROWS FETCH NEXT ${parseInt(limit)} ROWS ONLY`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.get('/approvals/history', authenticate, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        a.ApprovalID AS RequestID, 
        a.RequestType, 
        a.Status, 
        a.RequestDate AS RequestedAt, 
        a.DecisionDate AS ApprovedAt,
        u.Name AS RequestedBy,
        h.ActionTaken,
        h.Comments AS ApprovalNotes,
        a.Notes AS OriginalNotes
      FROM APPROVAL_REQUEST a
      LEFT JOIN [USER] u ON a.RequestedBy = u.UserID
      LEFT JOIN APPROVAL_HISTORY h ON a.ApprovalID = h.ApprovalID
      ORDER BY a.RequestDate DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.get('/my-audit-log', authenticate, async (req, res, next) => {
  try {
    const uid = req.user.userID;
    const result = await query(`
      SELECT 
        'APPROVAL' AS ActionType,
        ah.ActionTaken AS Action,
        CONCAT('Decision on Request #', ah.ApprovalID) AS Details,
        ah.ActionDate AS Timestamp
      FROM APPROVAL_HISTORY ah
      WHERE ah.ActionBy = @uid

      UNION ALL

      SELECT 
        'SYSTEM' AS ActionType,
        al.Action,
        al.NewValue AS Details,
        al.Timestamp
      FROM AUDIT_LOG al
      WHERE al.UserID = @uid AND al.Action != 'LOGIN'

      UNION ALL

      SELECT 
        'FINANCE' AS ActionType,
        'TRANSACTION' AS Action,
        CONCAT('Recorded ', ft.TransType, ' of PKR ', ft.Amount) AS Details,
        fa.AuditDate AS Timestamp
      FROM FINANCIAL_AUDIT fa
      JOIN FINANCIAL_TRANSACTION ft ON fa.TransactionID = ft.TransactionID
      WHERE fa.ApprovedBy = @uid

      ORDER BY Timestamp DESC
    `, { uid });
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
