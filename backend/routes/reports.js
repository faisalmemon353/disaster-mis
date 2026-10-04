const express = require('express');
const router = express.Router();
const { query, transaction, sql } = require('../db/connection');
const { authenticate, authorize } = require('../middleware/auth');

// ─── LIST REPORTS ────────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, severity, type, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const params = {};

    if (status) { 
      const statuses = status.split(',').map(s => `'${s.trim()}'`).join(',');
      whereClause += ` AND r.Status IN (${statuses})`;
    }
    if (severity) { 
      const sevMap = { 'Critical': 5, 'High': 4, 'Medium': 3, 'Low': 2 };
      whereClause += ' AND r.SeverityLevel = @severity'; 
      params.severity = sevMap[severity] || 1; 
    }
    if (type) { whereClause += ' AND r.DisasterType = @type'; params.type = type; }

    params.offset = { type: sql.Int, value: parseInt(offset) };
    params.limit = { type: sql.Int, value: parseInt(limit) };

    const result = await query(
      `SELECT r.ReportID, r.Location, r.DisasterType,
              CASE r.SeverityLevel WHEN 5 THEN 'Critical' WHEN 4 THEN 'High' WHEN 3 THEN 'Medium' ELSE 'Low' END AS SeverityLevel, 
              r.TimeOfReport AS ReportTime,
              r.Status, r.EventID,
              c.Name AS ReporterName, c.ContactInfo AS ReporterContact,
              d.Status AS DisasterStatus
       FROM EMERGENCY_REPORT r
       LEFT JOIN CITIZEN c ON r.CitizenID = c.CitizenID
       LEFT JOIN DISASTER_EVENT d ON r.EventID = d.EventID
       ${whereClause}
       ORDER BY r.SeverityLevel DESC, r.TimeOfReport DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) AS total FROM EMERGENCY_REPORT r ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: result.recordset,
      pagination: {
        total: countResult.recordset[0].total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(countResult.recordset[0].total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── SUBMIT REPORT (No disaster link — just intake) ─────────────────────────

router.post('/', authenticate, async (req, res, next) => {
  submitReport(req, res, next, req.user.userID);
});

router.post('/public', async (req, res, next) => {
  submitReport(req, res, next, null);
});

async function submitReport(req, res, next, userID) {
  try {
    const { location, disasterType, severityLevel, description, reporterName, reporterContact } = req.body;
    if (!location || !disasterType || !severityLevel) {
      return res.status(400).json({ success: false, message: 'Location, type, and severity are required.' });
    }

    const sevMap = { 'Critical': 5, 'High': 4, 'Medium': 3, 'Low': 2 };
    const sev = sevMap[severityLevel] || 1;

    const result = await transaction(async (txn, sql) => {
      // 1. Create Citizen
      const citReq = new sql.Request(txn);
      const fakeCNIC = 'UNK-' + Date.now().toString().slice(-8);
      citReq.input('name', reporterName || 'Anonymous');
      citReq.input('cnic', fakeCNIC);
      citReq.input('contact', reporterContact || null);
      const citInsert = await citReq.query(`INSERT INTO CITIZEN (Name, CNIC, ContactInfo) OUTPUT INSERTED.CitizenID VALUES (@name, @cnic, @contact)`);
      const citizenID = citInsert.recordset[0].CitizenID;

      // 2. Create Report — NO disaster link (EventID = NULL, Status = Pending)
      const rptReq = new sql.Request(txn);
      rptReq.input('citID', citizenID);
      rptReq.input('type', disasterType);
      rptReq.input('loc', location);
      rptReq.input('sev', sev);
      const rptInsert = await rptReq.query(`
        INSERT INTO EMERGENCY_REPORT (CitizenID, DisasterType, Location, SeverityLevel, Status)
        OUTPUT INSERTED.ReportID, INSERTED.TimeOfReport
        VALUES (@citID, @type, @loc, @sev, 'Pending')
      `);
      return rptInsert.recordset[0];
    });

    res.status(201).json({ success: true, message: 'Report submitted.', data: result });
  } catch (err) {
    next(err);
  }
}

// ─── STATS (Dashboard) ──────────────────────────────────────────────────────

router.get('/stats/summary', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN Status = 'Pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN Status = 'Active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN Status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
         SUM(CASE WHEN SeverityLevel = 5 THEN 1 ELSE 0 END) AS critical,
         SUM(CASE WHEN SeverityLevel = 4 THEN 1 ELSE 0 END) AS high,
         SUM(CASE WHEN TimeOfReport >= DATEADD(hour, -24, GETDATE()) THEN 1 ELSE 0 END) AS last24h
       FROM EMERGENCY_REPORT`
    );
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    next(err);
  }
});

// Active reports for dropdowns (patient registration etc.)
router.get('/my-active', authenticate, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT r.ReportID, r.Location, r.Status, r.DisasterType
      FROM EMERGENCY_REPORT r
      WHERE r.Status IN ('Pending', 'Active')
      ORDER BY r.ReportID DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
