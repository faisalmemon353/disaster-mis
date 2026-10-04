const express = require('express');
const router = express.Router();
const { query, transaction, sql } = require('../db/connection');
const { authenticate, authorize } = require('../middleware/auth');

// ─── LIST DISASTERS ──────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status } = req.query;
    let where = 'WHERE 1=1';
    const params = {};
    if (status) { 
      const statuses = status.split(',').map(s => `'${s.trim()}'`).join(',');
      where += ` AND e.Status IN (${statuses})`; 
    }

    // Field Officers only see their assigned disasters
    if (req.user && req.user.role === 'Field Officer') {
      where += ' AND EXISTS (SELECT 1 FROM DISASTER_OFFICER do WHERE do.EventID = e.EventID AND do.OfficerID = @uid)';
      params.uid = req.user.userID;
    }

    const result = await query(`
      SELECT e.EventID, e.DisasterType, e.Location, e.StartTime, e.EndTime,
             e.Status, e.Budget,
             (SELECT STRING_AGG(u.Name, ', ') FROM DISASTER_OFFICER do JOIN [USER] u ON do.OfficerID = u.UserID WHERE do.EventID = e.EventID) AS OfficerNames,
             (SELECT COUNT(*) FROM EMERGENCY_REPORT r WHERE r.EventID = e.EventID) AS ReportCount,
             (SELECT COUNT(*) FROM TEAM_ASSIGNMENT ta WHERE ta.EventID = e.EventID AND ta.Status != 'Completed') AS ActiveTeams,
             (SELECT STRING_AGG(rt.TeamName, ', ') FROM TEAM_ASSIGNMENT ta2 JOIN RESCUE_TEAM rt ON ta2.TeamID = rt.TeamID WHERE ta2.EventID = e.EventID AND ta2.Status != 'Completed') AS AssignedTeams
      FROM DISASTER_EVENT e
      ${where}
      ORDER BY
        CASE e.Status
          WHEN 'Active' THEN 1
          WHEN 'Assigned' THEN 2
          WHEN 'Resolved' THEN 3
          WHEN 'Closed' THEN 4
        END,
        e.StartTime DESC
    `, params);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

// ─── PENDING REPORTS (grouped by disaster type for disaster creation) ────────

router.get('/pending-reports', authenticate, async (req, res, next) => {
  try {
    // Get all pending reports NOT linked to any disaster, grouped by type
    const result = await query(`
      SELECT r.ReportID, r.DisasterType, r.Location, r.SeverityLevel, r.TimeOfReport,
             c.Name AS ReporterName
      FROM EMERGENCY_REPORT r
      LEFT JOIN CITIZEN c ON r.CitizenID = c.CitizenID
      WHERE r.Status = 'Pending' AND r.EventID IS NULL
      ORDER BY r.DisasterType, r.SeverityLevel DESC, r.TimeOfReport DESC
    `);

    // Group by disaster type with counts
    const grouped = {};
    for (const r of result.recordset) {
      if (!grouped[r.DisasterType]) {
        grouped[r.DisasterType] = { type: r.DisasterType, count: 0, reports: [] };
      }
      grouped[r.DisasterType].count++;
      grouped[r.DisasterType].reports.push(r);
    }

    // Sort by count descending (most reports first)
    const sorted = Object.values(grouped).sort((a, b) => b.count - a.count);

    res.json({ success: true, data: sorted });
  } catch (err) {
    next(err);
  }
});

// ─── CREATE DISASTER (from selected reports) ─────────────────────────────────

router.post('/', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const { reportIDs, location, officerID } = req.body;
    if (!reportIDs || !reportIDs.length) {
      return res.status(400).json({ success: false, message: 'At least 1 report is required to create a disaster.' });
    }
    if (!officerID) {
      return res.status(400).json({ success: false, message: 'A Field Officer must be assigned to the disaster.' });
    }

    await transaction(async (txn, sql) => {
      // 1. Verify all reports are Pending and unlinked, and get disaster type
      const check = new sql.Request(txn);
      const idList = reportIDs.join(',');
      const reports = await check.query(`
        SELECT ReportID, DisasterType, Location, Status, EventID
        FROM EMERGENCY_REPORT
        WHERE ReportID IN (${idList})
      `);

      if (reports.recordset.length !== reportIDs.length) {
        throw new Error('One or more reports not found.');
      }

      // All reports must be same disaster type
      const types = [...new Set(reports.recordset.map(r => r.DisasterType))];
      if (types.length > 1) throw new Error('All reports must be the same disaster type.');

      // All must be Pending and unlinked
      const invalid = reports.recordset.find(r => r.Status !== 'Pending' || r.EventID !== null);
      if (invalid) throw new Error(`Report #${invalid.ReportID} is already linked to a disaster or not Pending.`);

      const disasterType = types[0];
      const disasterLocation = location || reports.recordset[0].Location;

      // 2. Create the disaster event (status = Active)
      const create = new sql.Request(txn);
      create.input('type', disasterType);
      create.input('loc', disasterLocation);
      const evResult = await create.query(`
        INSERT INTO DISASTER_EVENT (DisasterType, Location, StartTime, Status)
        OUTPUT INSERTED.EventID
        VALUES (@type, @loc, GETDATE(), 'Active')
      `);
      const eventID = evResult.recordset[0].EventID;

      // 3. Assign initial Field Officer
      const assignOfficer = new sql.Request(txn);
      assignOfficer.input('eid', eventID);
      assignOfficer.input('oid', officerID);
      await assignOfficer.query(`
        INSERT INTO DISASTER_OFFICER (EventID, OfficerID)
        VALUES (@eid, @oid)
      `);

      // 4. Link reports to this disaster and set their status to Active
      const link = new sql.Request(txn);
      link.input('eid', eventID);
      await link.query(`
        UPDATE EMERGENCY_REPORT
        SET EventID = ${eventID}, Status = 'Active'
        WHERE ReportID IN (${idList})
      `);
    });

    res.status(201).json({ success: true, message: 'Disaster created. Reports linked and activated.' });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('same disaster') || err.message.includes('already linked') || err.message.includes('At least')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// ─── ASSIGN ADDITIONAL OFFICER ──────────────────────────────────────────────────

router.post('/:id/officers', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const eventID = req.params.id;
    const { officerID } = req.body;

    if (!officerID) return res.status(400).json({ success: false, message: 'Officer ID is required.' });

    // Check if already assigned
    const check = await query(`SELECT * FROM DISASTER_OFFICER WHERE EventID = @eid AND OfficerID = @oid`, { eid: eventID, oid: officerID });
    if (check.recordset.length) {
      return res.status(400).json({ success: false, message: 'This officer is already assigned to this disaster.' });
    }

    await query(`INSERT INTO DISASTER_OFFICER (EventID, OfficerID) VALUES (@eid, @oid)`, { eid: eventID, oid: officerID });

    res.json({ success: true, message: 'Officer successfully added to the disaster operation.' });
  } catch (err) {
    next(err);
  }
});

// ─── GET REPORTS FOR A DISASTER ──────────────────────────────────────────────

router.get('/:id/reports', authenticate, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT r.ReportID, r.DisasterType, r.Location, r.SeverityLevel, r.TimeOfReport, r.Status,
             c.Name AS ReporterName, c.ContactInfo AS ReporterContact
      FROM EMERGENCY_REPORT r
      LEFT JOIN CITIZEN c ON r.CitizenID = c.CitizenID
      WHERE r.EventID = @eid
      ORDER BY r.TimeOfReport DESC
    `, { eid: req.params.id });
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

// ─── DISASTER LIFECYCLE ──────────────────────────────────────────────────────

// Update disaster status (forward-only transitions)
router.put('/:id/status', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const { status } = req.body;
    const eventID = req.params.id;
    const STAGES = { 'Active': 1, 'Assigned': 2, 'Resolved': 3, 'Closed': 4 };

    await transaction(async (txn, sql) => {
      const check = new sql.Request(txn);
      check.input('eid', eventID);
      const ev = await check.query(`SELECT Status FROM DISASTER_EVENT WHERE EventID = @eid`);
      if (!ev.recordset.length) throw new Error('Disaster not found.');
      const current = ev.recordset[0].Status;
      if (!STAGES[status] || STAGES[status] <= STAGES[current]) {
        throw new Error(`Cannot move from ${current} to ${status}.`);
      }

      const upd = new sql.Request(txn);
      upd.input('eid', eventID);
      upd.input('st', status);
      await upd.query(`UPDATE DISASTER_EVENT SET Status = @st WHERE EventID = @eid`);

      // If closing, set end time
      if (status === 'Closed') {
        const end = new sql.Request(txn);
        end.input('eid', eventID);
        await end.query(`UPDATE DISASTER_EVENT SET EndTime = GETDATE() WHERE EventID = @eid`);
      }

      // Sync report statuses to match disaster status
      const sync = new sql.Request(txn);
      sync.input('eid', eventID);
      sync.input('st', status);
      await sync.query(`UPDATE EMERGENCY_REPORT SET Status = @st WHERE EventID = @eid`);

      // Unassign Field Officer to history on Resolved or Closed
      if (status === 'Resolved' || status === 'Closed') {
        const hist = new sql.Request(txn);
        hist.input('eid', eventID);
        await hist.query(`
          IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'OFFICER_HISTORY')
          BEGIN
            CREATE TABLE OFFICER_HISTORY (
              HistoryID INT IDENTITY(1,1) PRIMARY KEY,
              OfficerID INT,
              EventID INT,
              AssignedAt DATETIME2,
              UnassignedAt DATETIME2 DEFAULT GETDATE(),
              Reason NVARCHAR(50)
            );
          END;

          INSERT INTO OFFICER_HISTORY (OfficerID, EventID, AssignedAt, Reason)
          SELECT OfficerID, EventID, AssignedAt, 'Disaster ' + Status
          FROM DISASTER_OFFICER 
          CROSS JOIN (SELECT Status FROM DISASTER_EVENT WHERE EventID = @eid) AS EV
          WHERE EventID = @eid;

          DELETE FROM DISASTER_OFFICER WHERE EventID = @eid;
        `);
      }
    });

    res.json({ success: true, message: `Disaster ${status.toUpperCase()} successfully.` });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('Cannot move')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// Resolve disaster (release teams, recover resources)
router.post('/:id/resolve', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const eventID = req.params.id;

    await transaction(async (txn, sql) => {
      const check = new sql.Request(txn);
      check.input('eid', eventID);
      const ev = await check.query(`SELECT EventID, Status FROM DISASTER_EVENT WHERE EventID = @eid`);
      if (!ev.recordset.length) throw new Error('Disaster not found.');
      if (ev.recordset[0].Status !== 'Assigned') throw new Error('Only assigned disasters can be resolved.');

      // Release all assigned teams
      const teams = new sql.Request(txn);
      teams.input('eid', eventID);
      const teamRows = await teams.query(`
        SELECT ta.AssignmentID, ta.TeamID
        FROM TEAM_ASSIGNMENT ta WHERE ta.EventID = @eid AND ta.Status != 'Completed'
      `);
      for (const t of teamRows.recordset) {
        const rel = new sql.Request(txn);
        rel.input('aid', t.AssignmentID);
        rel.input('tid', t.TeamID);
        await rel.query(`UPDATE TEAM_ASSIGNMENT SET Status = 'Completed', CompletedAt = GETDATE() WHERE AssignmentID = @aid`);
        await rel.query(`UPDATE RESCUE_TEAM SET AvailabilityStatus = 'Available' WHERE TeamID = @tid`);
      }

      // Recover resources
      const resources = new sql.Request(txn);
      resources.input('eid', eventID);
      const resRows = await resources.query(`
        SELECT AllocationID, ResourceID, QtyDispatched, QtyConsumed
        FROM RESOURCE_ALLOCATION WHERE EventID = @eid AND Status != 'Recovered'
      `);
      for (const r of resRows.recordset) {
        const recovered = r.QtyDispatched - (r.QtyConsumed || 0);
        if (recovered > 0) {
          const rec = new sql.Request(txn);
          rec.input('aid', r.AllocationID);
          rec.input('rid', r.ResourceID);
          rec.input('qty', recovered);
          await rec.query(`UPDATE RESOURCE_ALLOCATION SET Status = 'Recovered' WHERE AllocationID = @aid`);
          await rec.query(`UPDATE RESOURCE SET QtyAvailable = QtyAvailable + @qty WHERE ResourceID = @rid`);
        }
      }

      // Mark disaster as Resolved
      const resolve = new sql.Request(txn);
      resolve.input('eid', eventID);
      await resolve.query(`UPDATE DISASTER_EVENT SET Status = 'Resolved' WHERE EventID = @eid`);

      // Sync linked reports
      const sync = new sql.Request(txn);
      sync.input('eid', eventID);
      await sync.query(`UPDATE EMERGENCY_REPORT SET Status = 'Resolved' WHERE EventID = @eid`);

      // Unassign Field Officer and add to history
      const hist = new sql.Request(txn);
      hist.input('eid', eventID);
      await hist.query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'OFFICER_HISTORY')
        BEGIN
          CREATE TABLE OFFICER_HISTORY (
            HistoryID INT IDENTITY(1,1) PRIMARY KEY,
            OfficerID INT,
            EventID INT,
            AssignedAt DATETIME2,
            UnassignedAt DATETIME2 DEFAULT GETDATE(),
            Reason NVARCHAR(50)
          );
        END;

        INSERT INTO OFFICER_HISTORY (OfficerID, EventID, AssignedAt, Reason)
        SELECT OfficerID, EventID, AssignedAt, 'Disaster Resolved'
        FROM DISASTER_OFFICER WHERE EventID = @eid;

        DELETE FROM DISASTER_OFFICER WHERE EventID = @eid;
      `);
    });

    res.json({ success: true, message: 'Disaster resolved. Teams released, resources recovered.' });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('Only assigned')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// Active disasters for dropdowns (teams, resources pages)
router.get('/active', authenticate, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT EventID, DisasterType, Location, Status
      FROM DISASTER_EVENT
      WHERE Status IN ('Active', 'Assigned')
      ORDER BY StartTime DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
