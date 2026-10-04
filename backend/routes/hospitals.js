const express = require('express');
const router = express.Router();
const { query, transaction, sql } = require('../db/connection');
const { authenticate, authorize } = require('../middleware/auth');

// ─── HOSPITAL CRUD ───────────────────────────────────────────────────────────

// Register New Hospital (Admin Only)
router.post('/', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { name, location, contact, totalBeds } = req.body;
    if (!name || !location || !totalBeds) {
      return res.status(400).json({ success: false, message: 'Name, location, and total beds are required.' });
    }

    await query(`
      INSERT INTO HOSPITAL (Name, Location, ContactInfo, TotalBeds, AvailableBeds, HospitalStatus)
      VALUES (@name, @loc, @contact, @beds, @beds, 'Functional')
    `, { name, loc: location, contact, beds: totalBeds });

    res.status(201).json({ success: true, message: 'Hospital registered successfully.' });
  } catch (err) {
    next(err);
  }
});

// List All Hospitals
router.get('/', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT HospitalID, Name AS HospitalName, Location, ContactInfo AS ContactNumber,
              TotalBeds, AvailableBeds, HospitalStatus AS EmergencyStatus,
              ROUND(CAST(TotalBeds - AvailableBeds AS FLOAT) / NULLIF(TotalBeds,0) * 100, 1) AS OccupancyRate,
              (SELECT COUNT(*) FROM PATIENT p WHERE p.HospitalID = h.HospitalID AND p.CaseStatus = 'Admitted') AS currentPatients
       FROM HOSPITAL h
       ORDER BY AvailableBeds DESC`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

// Best-match hospital (most beds available)
router.get('/best-match', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT TOP 3 HospitalID, Name AS HospitalName, Location, AvailableBeds,
              ROUND(CAST(TotalBeds - AvailableBeds AS FLOAT) / NULLIF(TotalBeds,0) * 100, 1) AS OccupancyRate
       FROM HOSPITAL
       WHERE AvailableBeds > 0 AND HospitalStatus = 'Functional'
       ORDER BY AvailableBeds DESC`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

// ─── PATIENT LIFECYCLE (all /patients/* routes BEFORE /:hospitalId routes) ───

// STEP 1: Register Patient (no hospital assigned yet)
router.post('/patients/register', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const { patientName, condition, reportID } = req.body;
    if (!patientName || !condition) {
      return res.status(400).json({ success: false, message: 'Patient name and condition are required.' });
    }

    const result = await query(`
      INSERT INTO PATIENT (PatientName, MedicalCondition, CaseStatus, ReportID)
      VALUES (@name, @condition, 'Registered', @reportID);
      SELECT SCOPE_IDENTITY() AS PatientID;
    `, { name: patientName, condition, reportID: reportID || null });

    const patientID = result.recordset[0].PatientID;
    await query(`
      INSERT INTO AUDIT_LOG (UserID, Action, TableName, RecordID, NewValue)
      VALUES (@uid, 'REGISTER', 'PATIENT', @pid, @details)
    `, { uid: req.user.userID, pid: patientID, details: `Registered patient: ${patientName} (${condition})` });

    res.status(201).json({ success: true, message: 'Patient registered.', data: { PatientID: patientID } });
  } catch (err) {
    next(err);
  }
});

// Get All Patients (with optional status filter)
router.get('/patients', authenticate, async (req, res, next) => {
  try {
    const { status } = req.query;
    let where = 'WHERE 1=1';
    const params = {};
    if (status) { where += ` AND p.CaseStatus = @status`; params.status = status; }

    const result = await query(`
      SELECT
        p.PatientID, p.PatientName, p.CaseStatus,
        p.MedicalCondition, p.AdmissionDate, p.DischargeDate,
        h.Name AS HospitalName, h.HospitalID,
        r.ReportID, r.Location AS DisasterLocation,
        ISNULL(d.DisasterType, 'Unclassified') AS DisasterType
      FROM PATIENT p
      LEFT JOIN HOSPITAL h ON p.HospitalID = h.HospitalID
      LEFT JOIN EMERGENCY_REPORT r ON p.ReportID = r.ReportID
      LEFT JOIN DISASTER_EVENT d ON r.EventID = d.EventID
      ${where}
      ORDER BY
        CASE p.CaseStatus
          WHEN 'Registered' THEN 1
          WHEN 'Admitted' THEN 2
          WHEN 'Discharged' THEN 3
          ELSE 4
        END,
        COALESCE(p.AdmissionDate, GETDATE()) DESC
    `, params);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

// STEP 3: Discharge an Admitted Patient
router.put('/patients/:id/discharge', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const patientId = req.params.id;

    await transaction(async (txn, sql) => {
      // Verify patient exists and is currently admitted
      const check = new sql.Request(txn);
      check.input('pid', patientId);
      const patient = await check.query(`SELECT PatientID, HospitalID, CaseStatus FROM PATIENT WHERE PatientID = @pid`);
      if (!patient.recordset.length) throw new Error('Patient not found.');

      // Allow discharge for 'Admitted' status or legacy data (has hospital assigned)
      const cs = patient.recordset[0].CaseStatus;
      const hasHospital = patient.recordset[0].HospitalID != null;
      if (cs === 'Discharged') throw new Error('Patient is already discharged.');
      if (cs === 'Registered' && !hasHospital) throw new Error('Patient has not been admitted yet.');

      const hospitalID = patient.recordset[0].HospitalID;

      // Update patient status to Discharged
      const discharge = new sql.Request(txn);
      discharge.input('pid', patientId);
      await discharge.query(`
        UPDATE PATIENT
        SET CaseStatus = 'Discharged', DischargeDate = GETDATE()
        WHERE PatientID = @pid
      `);
      // NOTE: AvailableBeds is freed automatically by trg_UpdatePatientDischarge trigger.
      // Do NOT update it here to avoid double-counting.

      // Write Audit Log
      const audit = new sql.Request(txn);
      audit.input('uid', req.user.userID);
      audit.input('pid', patientId);
      audit.input('details', `Discharged Patient #${patientId}`);
      await audit.query(`
        INSERT INTO AUDIT_LOG (UserID, Action, TableName, RecordID, NewValue)
        VALUES (@uid, 'DISCHARGE', 'PATIENT', @pid, @details)
      `);
    });

    res.json({ success: true, message: 'Patient discharged successfully.' });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('already discharged') || err.message.includes('not been admitted')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// STEP 4: Escalate Patient to Another Hospital
router.post('/patients/:id/escalate', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const patientId = req.params.id;
    const { targetHospitalID, reason } = req.body;
    if (!targetHospitalID) {
      return res.status(400).json({ success: false, message: 'Target hospital is required.' });
    }

    await transaction(async (txn, sql) => {
      // Get current patient info
      const check = new sql.Request(txn);
      check.input('pid', patientId);
      const patient = await check.query(`SELECT PatientID, HospitalID, CaseStatus FROM PATIENT WHERE PatientID = @pid`);
      if (!patient.recordset.length) throw new Error('Patient not found.');
      
      const cs = patient.recordset[0].CaseStatus;
      if (cs === 'Discharged') throw new Error('Discharged patients cannot be escalated.');
      if (!patient.recordset[0].HospitalID) throw new Error('Patient must be admitted to a hospital before escalation.');
      
      const sourceHospitalID = patient.recordset[0].HospitalID;
      if (sourceHospitalID == targetHospitalID) throw new Error('Cannot escalate to the same hospital.');

      // Check target hospital has beds
      const targCheck = new sql.Request(txn);
      targCheck.input('tid', targetHospitalID);
      const target = await targCheck.query(`SELECT HospitalID, AvailableBeds FROM HOSPITAL WHERE HospitalID = @tid`);
      if (!target.recordset.length) throw new Error('Target hospital not found.');
      if (target.recordset[0].AvailableBeds <= 0) throw new Error('No beds available at target hospital.');

      // Create escalation record (using ESCALATION table from ERD)
      const esc = new sql.Request(txn);
      esc.input('pid', patientId);
      esc.input('src', sourceHospitalID);
      esc.input('tgt', targetHospitalID);
      esc.input('reason', reason || 'Medical escalation');
      await esc.query(`
        INSERT INTO ESCALATION (PatientID, SourceHospitalID, TargetHospitalID, Reason, Status)
        VALUES (@pid, @src, @tgt, @reason, 'Completed')
      `);

      // Move patient to new hospital
      const move = new sql.Request(txn);
      move.input('pid', patientId);
      move.input('tgt', targetHospitalID);
      await move.query(`UPDATE PATIENT SET HospitalID = @tgt WHERE PatientID = @pid`);

      // Free bed at source hospital
      const srcBed = new sql.Request(txn);
      srcBed.input('src', sourceHospitalID);
      await srcBed.query(`UPDATE HOSPITAL SET AvailableBeds = AvailableBeds + 1 WHERE HospitalID = @src`);

      // Deduct bed at target hospital
      const tgtBed = new sql.Request(txn);
      tgtBed.input('tgt', targetHospitalID);
      await tgtBed.query(`UPDATE HOSPITAL SET AvailableBeds = AvailableBeds - 1 WHERE HospitalID = @tgt`);
    });

    res.json({ success: true, message: 'Patient escalated to new hospital successfully.' });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('Discharged') || err.message.includes('must be admitted') || err.message.includes('same hospital') || err.message.includes('No beds')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// ─── PARAMETERIZED HOSPITAL ROUTES (must come AFTER /patients/* routes) ──────

// STEP 2: Admit a Registered Patient to a Hospital
router.post('/:hospitalId/admit/:patientId', authenticate, authorize('Admin', 'Emergency Operator'), async (req, res, next) => {
  try {
    const { hospitalId, patientId } = req.params;

    await transaction(async (txn, sql) => {
      // Verify patient exists and is in 'Registered' status
      const patCheck = new sql.Request(txn);
      patCheck.input('pid', patientId);
      const patient = await patCheck.query(`SELECT PatientID, CaseStatus FROM PATIENT WHERE PatientID = @pid`);
      if (!patient.recordset.length) throw new Error('Patient not found.');
      if (patient.recordset[0].CaseStatus !== 'Registered') {
        throw new Error(`Patient cannot be admitted. Current status: ${patient.recordset[0].CaseStatus}`);
      }

      // Verify hospital has available beds
      const hospCheck = new sql.Request(txn);
      hospCheck.input('hid', hospitalId);
      const hospital = await hospCheck.query(`SELECT HospitalID, AvailableBeds FROM HOSPITAL WHERE HospitalID = @hid`);
      if (!hospital.recordset.length) throw new Error('Hospital not found.');
      if (hospital.recordset[0].AvailableBeds <= 0) throw new Error('No beds available at this hospital.');

      // Update patient: assign hospital, set admitted status
      const upd = new sql.Request(txn);
      upd.input('pid', patientId);
      upd.input('hid', hospitalId);
      await upd.query(`
        UPDATE PATIENT
        SET HospitalID = @hid, CaseStatus = 'Admitted', AdmissionDate = GETDATE()
        WHERE PatientID = @pid
      `);

      // Write Audit Log
      const audit = new sql.Request(txn);
      audit.input('uid', req.user.userID);
      audit.input('pid', patientId);
      audit.input('details', `Admitted Patient #${patientId} to Hospital #${hospitalId}`);
      await audit.query(`
        INSERT INTO AUDIT_LOG (UserID, Action, TableName, RecordID, NewValue)
        VALUES (@uid, 'ADMIT', 'PATIENT', @pid, @details)
      `);

      // Deduct one bed from hospital
      const bedUpd = new sql.Request(txn);
      bedUpd.input('hid', hospitalId);
      await bedUpd.query(`UPDATE HOSPITAL SET AvailableBeds = AvailableBeds - 1 WHERE HospitalID = @hid`);
    });

    res.json({ success: true, message: 'Patient admitted to hospital successfully.' });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('cannot be admitted') || err.message.includes('No beds')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
