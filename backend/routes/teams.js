const express = require('express');
const router = express.Router();
const { query, transaction, sql } = require('../db/connection');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, type } = req.query;
    let where = 'WHERE 1=1';
    const params = {};
    if (status) { where += ' AND t.AvailabilityStatus = @status'; params.status = status; }
    if (type) { where += ' AND t.TeamType = @type'; params.type = type; }

    const result = await query(
      `SELECT t.TeamID, t.TeamName, t.TeamType, t.CurrentLocation, t.AvailabilityStatus AS Status,
              (SELECT COUNT(*) FROM TEAM_MEMBER tm WHERE tm.TeamID = t.TeamID) AS MemberCount,
              (SELECT TOP 1 tm.MemberName FROM TEAM_MEMBER tm WHERE tm.TeamID = t.TeamID AND tm.MemberRole = 'Leader') AS LeaderName,
              (SELECT TOP 1 ta.EventID FROM TEAM_ASSIGNMENT ta WHERE ta.TeamID = t.TeamID AND ta.Status != 'Completed') AS AssignedEventID,
              (SELECT TOP 1 de.DisasterType + ' @ ' + de.Location FROM TEAM_ASSIGNMENT ta2 JOIN DISASTER_EVENT de ON ta2.EventID = de.EventID WHERE ta2.TeamID = t.TeamID AND ta2.Status != 'Completed') AS AssignedDisaster
       FROM RESCUE_TEAM t
       ${where}
       ORDER BY t.AvailabilityStatus, t.TeamType`,
      params
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { teamName, teamType, currentLocation, memberCount } = req.body;
    if (!teamName || !teamType) {
      return res.status(400).json({ success: false, message: 'Team name and type are required.' });
    }

    const result = await transaction(async (txn, sql) => {
      const ins = new sql.Request(txn);
      ins.input('name', teamName);
      ins.input('type', teamType);
      ins.input('loc', currentLocation || null);
      const rt = await ins.query(`
        INSERT INTO RESCUE_TEAM (TeamName, TeamType, CurrentLocation, AvailabilityStatus)
        OUTPUT INSERTED.TeamID
        VALUES (@name, @type, @loc, 'Available')
      `);
      const teamID = rt.recordset[0].TeamID;

      // Assign existing members to team
      if (req.body.memberIDs && req.body.memberIDs.length > 0) {
        const idList = req.body.memberIDs.join(',');
        const m = new sql.Request(txn);
        m.input('tid', teamID);
        await m.query(`UPDATE TEAM_MEMBER SET TeamID = @tid WHERE MemberID IN (${idList})`);
        
        // Auto-assign first member as Leader if needed
        await m.query(`
          IF NOT EXISTS (SELECT 1 FROM TEAM_MEMBER WHERE TeamID = @tid AND MemberRole = 'Leader')
          BEGIN
             UPDATE TOP (1) TEAM_MEMBER SET MemberRole = 'Leader' WHERE TeamID = @tid;
          END
        `);
      }
      return { TeamID: teamID };
    });

    res.status(201).json({ success: true, message: 'Team created.', data: result });
  } catch (err) {
    next(err);
  }
});

// Get Team Assignment History
router.get('/:id/history', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const result = await query(`
      SELECT ta.AssignmentID, ta.EventID, ta.AssignedAt, ta.CompletedAt, ta.Status,
             de.DisasterType, de.Location AS DisasterLocation, de.Status AS DisasterStatus,
             de.StartTime
      FROM TEAM_ASSIGNMENT ta
      JOIN DISASTER_EVENT de ON ta.EventID = de.EventID
      WHERE ta.TeamID = @tid
      ORDER BY ta.AssignedAt DESC
    `, { tid: req.params.id });
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

// Assign team to a DISASTER EVENT (not a report)
router.post('/:id/assign', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const { eventID } = req.body;
    const teamID = req.params.id;
    if (!eventID) return res.status(400).json({ success: false, message: 'Disaster Event ID is required.' });

    await transaction(async (txn, sql) => {
      // 1. Check if team is actually available and has members
      const check = new sql.Request(txn);
      check.input('tid', teamID);
      const teamRes = await check.query(`
        SELECT AvailabilityStatus, 
               (SELECT COUNT(*) FROM TEAM_MEMBER WHERE TeamID = @tid) AS MemberCount
        FROM RESCUE_TEAM WHERE TeamID = @tid
      `);
      if (!teamRes.recordset.length) throw new Error('Team not found.');
      if (teamRes.recordset[0].AvailabilityStatus !== 'Available') {
        throw new Error('Team is no longer available for assignment.');
      }
      if (teamRes.recordset[0].MemberCount === 0) {
        throw new Error('Cannot assign an empty team. Please add personnel to the team first.');
      }

      // 2. Check if disaster is 'Active' or 'Assigned'
      const evCheck = new sql.Request(txn);
      evCheck.input('eid', eventID);
      const evRes = await evCheck.query(`SELECT Status FROM DISASTER_EVENT WHERE EventID = @eid`);
      if (!evRes.recordset.length) throw new Error('Disaster not found.');
      const evStatus = evRes.recordset[0].Status;
      if (evStatus !== 'Active' && evStatus !== 'Assigned') {
        throw new Error('Teams can only be deployed to Active or Assigned disasters.');
      }

      // 3. Create Assignment record (now linked to EventID)
      const assign = new sql.Request(txn);
      assign.input('tid', teamID);
      assign.input('eid', eventID);
      await assign.query(`
        INSERT INTO TEAM_ASSIGNMENT (TeamID, EventID, AssignedAt, Status)
        VALUES (@tid, @eid, GETDATE(), 'Active')
      `);

      // 4. Update Team Status to 'On Mission'
      await txn.request().input('tid', teamID).query(`UPDATE RESCUE_TEAM SET AvailabilityStatus = 'On Mission' WHERE TeamID = @tid`);

      // 5. Update Disaster Status to 'Assigned'
      await txn.request().input('eid', eventID).query(`UPDATE DISASTER_EVENT SET Status = 'Assigned' WHERE EventID = @eid`);

      // 6. Write Audit Log
      const audit = new sql.Request(txn);
      audit.input('uid', req.user.userID);
      audit.input('tid', teamID);
      audit.input('details', `Assigned Team #${teamID} to Disaster EVT-${eventID}`);
      await audit.query(`
        INSERT INTO AUDIT_LOG (UserID, Action, TableName, RecordID, NewValue)
        VALUES (@uid, 'ASSIGN', 'TEAM_ASSIGNMENT', @tid, @details)
      `);
    });

    res.json({ success: true, message: 'Team deployed to disaster. Mission is now ACTIVE.' });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('available') || err.message.includes('Active')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

router.put('/:id/status', authenticate, authorize('Admin', 'Emergency Operator', 'Field Officer'), async (req, res, next) => {
  try {
    const { status } = req.body;
    const teamID = req.params.id;

    const current = await query(`SELECT AvailabilityStatus FROM RESCUE_TEAM WHERE TeamID = @id`, { id: teamID });
    if (!current.recordset.length) return res.status(404).json({ success: false, message: 'Team not found.' });

    if (current.recordset[0].AvailabilityStatus === 'On Mission') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot manually change status of a team "On Mission". Resolve their assigned disaster to release them.' 
      });
    }

    await query(
      `UPDATE RESCUE_TEAM SET AvailabilityStatus = @status WHERE TeamID = @id`,
      { status, id: teamID }
    );
    res.json({ success: true, message: 'Team status updated.' });
  } catch (err) {
    next(err);
  }
});

router.post('/request', authenticate, authorize('Admin', 'Emergency Operator', 'Field Officer'), async (req, res, next) => {
  try {
    const { eventID, teamType, urgency, justification } = req.body;
    if (!eventID || !teamType) return res.status(400).json({ success: false, message: 'Disaster Event ID and Team Type required.' });

    const notes = JSON.stringify({ eventID, teamType, urgency, justification });
    await query(
      `INSERT INTO APPROVAL_REQUEST (RequestedBy, RequestType, Status, Notes)
       VALUES (@uid, 'Team Assignment', 'Pending', @notes)`,
      { uid: req.user.userID, notes }
    );
    res.status(201).json({ success: true, message: 'Team request submitted for approval.' });
  } catch (err) {
    next(err);
  }
});

router.get('/requests', authenticate, async (req, res, next) => {
  try {
    const { status } = req.query;
    let where = `WHERE a.RequestType = 'Team Assignment'`;
    if (status) where += ` AND a.Status = @status`;

    const result = await query(
      `SELECT a.ApprovalID, a.Status, a.RequestDate, u.Name AS RequestedBy,
              JSON_VALUE(a.Notes, '$.eventID') AS EventID,
              JSON_VALUE(a.Notes, '$.teamType') AS TeamType,
              JSON_VALUE(a.Notes, '$.urgency') AS Urgency,
              JSON_VALUE(a.Notes, '$.justification') AS Justification
       FROM APPROVAL_REQUEST a
       JOIN [USER] u ON a.RequestedBy = u.UserID
       ${where}
       ORDER BY a.RequestDate DESC`,
      { status }
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.put('/requests/:id/approve', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const { action, notes } = req.body;
    const newStatus = action === 'approve' ? 'Approved' : 'Rejected';
    
    await query(
      `UPDATE APPROVAL_REQUEST SET Status = @st, DecisionDate = GETDATE() WHERE ApprovalID = @id AND Status = 'Pending'`,
      { st: newStatus, id: req.params.id }
    );
    
    await query(
      `INSERT INTO APPROVAL_HISTORY (ApprovalID, ActionTaken, Comments) VALUES (@id, @act, @notes)`,
      { id: req.params.id, act: newStatus, notes: notes || newStatus }
    );

    res.json({ success: true, message: `Team request ${newStatus.toLowerCase()}.` });
  } catch (err) {
    next(err);
  }
});

// Field Officer: get all MY requests (team + resource)
router.get('/requests/my-log', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT a.ApprovalID, a.RequestType, a.Status, a.RequestDate, a.DecisionDate,
              JSON_VALUE(a.Notes, '$.teamType') AS TeamType,
              JSON_VALUE(a.Notes, '$.eventID') AS EventID,
              JSON_VALUE(a.Notes, '$.urgency') AS Urgency,
              JSON_VALUE(a.Notes, '$.justification') AS Justification
       FROM APPROVAL_REQUEST a
       WHERE a.RequestedBy = @uid
       ORDER BY a.RequestDate DESC`,
      { uid: req.user.userID }
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

// ─── TEAM MEMBERS (PERSONNEL) ────────────────────────────────────────────────

router.get('/members', authenticate, async (req, res, next) => {
  try {
    const { status } = req.query; // 'unassigned' or 'all'
    let where = '';
    if (status === 'unassigned') where = 'WHERE tm.TeamID IS NULL';

    const result = await query(`
      SELECT tm.MemberID, tm.MemberName, tm.MemberRole, tm.MemberContact,
             tm.TeamID, rt.TeamName
      FROM TEAM_MEMBER tm
      LEFT JOIN RESCUE_TEAM rt ON tm.TeamID = rt.TeamID
      ${where}
      ORDER BY tm.MemberName
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.post('/members', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const { name, role, contact } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Member name is required.' });

    await query(`
      INSERT INTO TEAM_MEMBER (MemberName, MemberRole, MemberContact, TeamID)
      VALUES (@name, @role, @contact, NULL)
    `, { name, role: role || 'Member', contact });

    res.status(201).json({ success: true, message: 'Personnel registered successfully.' });
  } catch (err) {
    next(err);
  }
});

router.put('/members/:id/assign', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const { teamID, role } = req.body;
    await query(`
      UPDATE TEAM_MEMBER 
      SET TeamID = @tid, MemberRole = COALESCE(@role, MemberRole)
      WHERE MemberID = @mid
    `, { tid: teamID || null, role, mid: req.params.id });

    res.json({ success: true, message: 'Personnel team assignment updated.' });
  } catch (err) {
    next(err);
  }
});

router.delete('/members/:id', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    await query(`DELETE FROM TEAM_MEMBER WHERE MemberID = @mid`, { mid: req.params.id });
    res.json({ success: true, message: 'Personnel deleted successfully.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
