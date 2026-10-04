const express = require('express');
const router = express.Router();
const { query, transaction, sql } = require('../db/connection');
const { authenticate, authorize } = require('../middleware/auth');

// 0. WAREHOUSES
router.get('/warehouses', authenticate, async (req, res, next) => {
  try {
    let where = '';
    const params = {};
    if (req.user.role === 'Warehouse Manager') {
      where = 'WHERE w.WarehouseMgrID = @uid';
      params.uid = req.user.userID;
    }
    const result = await query(`
      SELECT w.WarehouseID, w.Name, w.Location, u.Name AS ManagerName
      FROM WAREHOUSE w
      LEFT JOIN [USER] u ON w.WarehouseMgrID = u.UserID
      ${where}
      ORDER BY w.Name
    `, params);
    res.json({ success: true, data: result.recordset });
  } catch (err) { next(err); }
});

router.patch('/warehouses/:id/assign', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { managerID } = req.body;
    await query(`UPDATE WAREHOUSE SET WarehouseMgrID = @mgr WHERE WarehouseID = @id`, { mgr: managerID || null, id: req.params.id });
    res.json({ success: true, message: 'Warehouse manager assigned successfully.' });
  } catch (err) { next(err); }
});

router.post('/warehouses', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { name, location, managerID } = req.body;
    if (!name || !location) return res.status(400).json({ success: false, message: 'Name and location are required.' });
    
    await query(`
      INSERT INTO WAREHOUSE (Name, Location, WarehouseMgrID)
      VALUES (@name, @loc, @mgr)
    `, { name, loc: location, mgr: managerID || null });
    
    res.status(201).json({ success: true, message: 'Warehouse created successfully.' });
  } catch (err) { next(err); }
});

// 1. Create NEW Resource (Strict: Errors if name exists)
router.post('/stock-entry', authenticate, authorize('Admin', 'Warehouse Manager'), async (req, res, next) => {
  try {
    const { name, type, unit, quantity, threshold, warehouseID } = req.body;
    if (!name || !quantity || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Name and positive quantity required.' });
    }
    
    // Check Access Control: Admin can add anywhere, WHManager only to their warehouse
    if (req.user.role === 'Warehouse Manager') {
      const whCheck = await query(`SELECT 1 FROM WAREHOUSE WHERE WarehouseID = @wh AND WarehouseMgrID = @uid`, { wh: warehouseID, uid: req.user.userID });
      if (!whCheck.recordset.length) return res.status(403).json({ success: false, message: 'Access Denied: You can only add stock to your assigned warehouses.' });
    }

    const existing = await query(`SELECT ResourceID FROM RESOURCE WHERE ResourceName = @name AND WarehouseID = @wh`, { name, wh: warehouseID });
    if (existing.recordset.length) {
      return res.status(400).json({ success: false, message: `Resource "${name}" already exists. Use the Update button on the card to add stock.` });
    }

    await query(`
      INSERT INTO RESOURCE (ResourceName, ResourceType, Unit, QtyAvailable, Threshold, WarehouseID)
      VALUES (@name, @type, @unit, @qty, @th, @wh)
    `, { name, type, unit, qty: quantity, th: threshold, wh: warehouseID });

    await query(`
      INSERT INTO AUDIT_LOG (UserID, Action, TableName, NewValue)
      VALUES (@uid, 'CREATE', 'RESOURCE', @details)
    `, { uid: req.user.userID, details: `Registered new resource: ${name} (Qty: ${quantity} ${unit}) in WH#${warehouseID}` });

    res.status(201).json({ success: true, message: 'New resource registered.' });
  } catch (err) {
    next(err);
  }
});

// 2. Update Stock Quantity for Existing Resource
router.patch('/:id/add-qty', authenticate, authorize('Admin', 'Warehouse Manager'), async (req, res, next) => {
  try {
    const { quantity } = req.body;
    if (!quantity || quantity <= 0) return res.status(400).json({ success: false, message: 'Positive quantity required.' });

    if (req.user.role === 'Warehouse Manager') {
      const whCheck = await query(`
        SELECT 1 FROM RESOURCE r 
        JOIN WAREHOUSE w ON r.WarehouseID = w.WarehouseID 
        WHERE r.ResourceID = @id AND w.WarehouseMgrID = @uid
      `, { id: req.params.id, uid: req.user.userID });
      if (!whCheck.recordset.length) return res.status(403).json({ success: false, message: 'Access Denied: You can only modify stock in your assigned warehouses.' });
    }

    await query(`UPDATE RESOURCE SET QtyAvailable = QtyAvailable + @qty WHERE ResourceID = @id`, { qty: quantity, id: req.params.id });

    await query(`
      INSERT INTO AUDIT_LOG (UserID, Action, TableName, RecordID, NewValue)
      VALUES (@uid, 'UPDATE', 'RESOURCE', @id, @details)
    `, { uid: req.user.userID, id: req.params.id, details: `Added stock: +${quantity} units to Resource #${req.params.id}` });

    res.json({ success: true, message: 'Stock quantity updated successfully.' });
  } catch (err) {
    next(err);
  }
});

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { warehouseID, type, lowStock } = req.query;
    let where = 'WHERE 1=1';
    const params = {};

    if (warehouseID) { where += ' AND r.WarehouseID = @warehouseID'; params.warehouseID = warehouseID; }
    if (type) { where += ' AND r.ResourceType = @type'; params.type = type; }
    if (lowStock === 'true') { where += ' AND r.QtyAvailable <= r.Threshold'; }

    if (req.user.role === 'Warehouse Manager') {
      where += ' AND w.WarehouseMgrID = @uid';
      params.uid = req.user.userID;
    }

    const result = await query(
      `SELECT r.ResourceID, r.ResourceName, r.ResourceType, r.QtyAvailable AS CurrentQuantity,
              r.Threshold AS MinimumThreshold, r.Unit,
              w.Name AS WarehouseName, w.Location AS WarehouseLocation,
              CASE WHEN r.QtyAvailable <= r.Threshold THEN 1 ELSE 0 END AS IsLowStock
       FROM RESOURCE r
       JOIN WAREHOUSE w ON r.WarehouseID = w.WarehouseID
       ${where}
       ORDER BY IsLowStock DESC, r.ResourceType, r.ResourceName`,
      params
    );

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.post('/allocate', authenticate, authorize('Admin', 'Warehouse Manager'), async (req, res, next) => {
  try {
    const { resourceID, quantity, eventID, notes } = req.body;
    if (!resourceID || !quantity || quantity <= 0 || !eventID) {
      return res.status(400).json({ success: false, message: 'Resource, Event ID and positive quantity required.' });
    }

    // Ensure schema is up to date (Silent fix for missing columns)
    try {
      await query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('RESOURCE_ALLOCATION') AND name = 'ReportID') ALTER TABLE RESOURCE_ALLOCATION ADD ReportID INT`);
      await query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('RESOURCE_ALLOCATION') AND name = 'QtyConsumed') ALTER TABLE RESOURCE_ALLOCATION ADD QtyConsumed INT DEFAULT 0`);
      await query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('RESOURCE_ALLOCATION') AND name = 'Notes') ALTER TABLE RESOURCE_ALLOCATION ADD Notes NVARCHAR(MAX)`);
    } catch (e) { /* Ignore if already exists or no permission */ }

    const result = await transaction(async (txn, sql) => {
      // 1. Verify Disaster Status (Must be Active)
      const evQuery = new sql.Request(txn);
      evQuery.input('ev', eventID);
      const evRes = await evQuery.query(`SELECT EventID, Status FROM DISASTER_EVENT WHERE EventID = @ev`);
      if (!evRes.recordset.length) throw new Error('Target disaster not found.');
      
      const evStatus = evRes.recordset[0].Status;
      if (evStatus === 'Resolved' || evStatus === 'Closed') {
        throw new Error(`Resources cannot be allocated to resolved or closed disasters.`);
      }

      // 2. Insert Allocation (Dispatched vs Consumed Tracking)
      const alloc = new sql.Request(txn);
      alloc.input('res', resourceID);
      alloc.input('ev', eventID);
      alloc.input('qty', quantity);
      alloc.input('notes', notes || '');
      
      const resAlloc = await alloc.query(`
        INSERT INTO RESOURCE_ALLOCATION (ResourceID, EventID, ReportID, QtyDispatched, QtyConsumed, AllocationDate, Status, Notes)
        VALUES (@res, @ev, NULL, @qty, 0, GETDATE(), 'Dispatched', @notes);
        SELECT SCOPE_IDENTITY() AS AllocationID;
      `);

      const audit = new sql.Request(txn);
      audit.input('uid', req.user.userID);
      audit.input('allocID', resAlloc.recordset[0].AllocationID);
      audit.input('details', `Direct Allocation: ${quantity} units of Resource #${resourceID} to EVT-${eventID}`);
      await audit.query(`
        INSERT INTO AUDIT_LOG (UserID, Action, TableName, RecordID, NewValue)
        VALUES (@uid, 'ALLOCATE', 'RESOURCE_ALLOCATION', @allocID, @details)
      `);

      return resAlloc.recordset[0];
    });

    res.status(201).json({ success: true, message: 'Resource allocated and dispatched to incident site.', data: result });
  } catch (err) {
    if (err.message.includes('report') || err.message.includes('Active')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// 5. Track Consumption (Update QtyConsumed) - ONLY Field Officer
router.patch('/allocate/:id/consume', authenticate, authorize('Field Officer'), async (req, res, next) => {
  try {
    const { quantity } = req.body;
    if (!quantity || quantity <= 0) return res.status(400).json({ success: false, message: 'Positive quantity required.' });

    await transaction(async (txn, sql) => {
      const alloc = new sql.Request(txn);
      alloc.input('id', req.params.id);
      const resAlloc = await alloc.query(`SELECT ResourceID, QtyDispatched, QtyConsumed, Status FROM RESOURCE_ALLOCATION WHERE AllocationID = @id`);
      
      if (!resAlloc.recordset.length) throw new Error('Allocation record not found.');
      const record = resAlloc.recordset[0];

      if (record.QtyConsumed + quantity > record.QtyDispatched) {
        throw new Error(`Cannot consume more than dispatched (Dispatched: ${record.QtyDispatched}, Already Consumed: ${record.QtyConsumed}).`);
      }

      // Update consumption
      const upd = new sql.Request(txn);
      upd.input('id', req.params.id);
      upd.input('qty', quantity);
      await upd.query(`
        UPDATE RESOURCE_ALLOCATION 
        SET QtyConsumed = QtyConsumed + @qty,
            Status = CASE WHEN QtyConsumed + @qty >= QtyDispatched THEN 'Completed' ELSE 'Dispatched' END
        WHERE AllocationID = @id
      `);
    });

    res.json({ success: true, message: 'Resource consumption recorded.' });
  } catch (err) {
    if (err.message.includes('consume') || err.message.includes('found')) return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
});

router.get('/allocations', authenticate, async (req, res, next) => {
  try {
    const { reportID, warehouseID } = req.query;
    let where = `WHERE de.Status NOT IN ('Resolved', 'Closed')`;
    const params = {};

    if (reportID) { where += ' AND ra.ReportID = @reportID'; params.reportID = reportID; }
    if (warehouseID) { where += ' AND r.WarehouseID = @warehouseID'; params.warehouseID = warehouseID; }

    const result = await query(`
      SELECT ra.AllocationID, ra.QtyDispatched, ra.QtyConsumed, ra.AllocationDate, ra.Status, ra.Notes,
             r.ResourceName, r.Unit, ra.EventID, ra.ReportID
      FROM RESOURCE_ALLOCATION ra
      JOIN RESOURCE r ON ra.ResourceID = r.ResourceID
      LEFT JOIN DISASTER_EVENT de ON ra.EventID = de.EventID
      LEFT JOIN EMERGENCY_REPORT er ON ra.ReportID = er.ReportID
      ${where}
      ORDER BY ra.AllocationDate DESC
    `, params);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.post('/request', authenticate, authorize('Admin', 'Warehouse Manager', 'Emergency Operator', 'Field Officer'), async (req, res, next) => {
  try {
    const { resourceID, quantity, justification, urgency, eventID } = req.body;
    const notes = JSON.stringify({ resourceID, quantity, justification, urgency, eventID });

    const result = await query(
      `INSERT INTO APPROVAL_REQUEST (RequestedBy, RequestType, Status, Notes)
       OUTPUT INSERTED.ApprovalID
       VALUES (@uid, 'Resource Allocation', 'Pending', @notes)`,
      { uid: req.user.userID, notes }
    );
    res.status(201).json({ success: true, message: 'Request submitted for approval.', data: result.recordset[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/request', authenticate, async (req, res, next) => {
  try {
    const { status, warehouseID } = req.query;
    let where = `WHERE a.RequestType = 'Resource Allocation'`;
    const params = {};

    if (status) {
      // Need a clean way to handle IN clause safely or just keep the map if simple statuses
      const statuses = status.split(',').map(s => `'${s.trim()}'`).join(',');
      where += ` AND a.Status IN (${statuses})`;
    }
    
    if (warehouseID) {
      where += ` AND r.WarehouseID = @warehouseID`;
      params.warehouseID = warehouseID;
    }

    const result = await query(
      `SELECT a.ApprovalID AS RequestID, a.Status, a.RequestDate AS RequestedAt, a.DecisionDate AS ApprovedAt,
              a.Notes, u.Name AS RequestedBy,
              JSON_VALUE(a.Notes, '$.resourceID') AS ResourceID,
              JSON_VALUE(a.Notes, '$.quantity') AS RequestedQuantity,
              JSON_VALUE(a.Notes, '$.justification') AS Justification,
              JSON_VALUE(a.Notes, '$.urgency') AS Urgency,
              JSON_VALUE(a.Notes, '$.eventID') AS EventID,
              r.ResourceName
       FROM APPROVAL_REQUEST a
       LEFT JOIN [USER] u ON a.RequestedBy = u.UserID
       LEFT JOIN [RESOURCE] r ON r.ResourceID = TRY_CAST(JSON_VALUE(a.Notes, '$.resourceID') AS INT)
       ${where}
       ORDER BY a.RequestDate DESC`,
      params
    );
    
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    next(err);
  }
});

router.put('/request/:id/approve', authenticate, authorize('Admin', 'Warehouse Manager'), async (req, res, next) => {
  try {
    const { action, notes } = req.body;
    
    try {
      await query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('APPROVAL_HISTORY') AND name = 'ActionBy') ALTER TABLE APPROVAL_HISTORY ADD ActionBy INT`);
    } catch (e) {}
    if (action === 'approve') {
      await transaction(async (txn, sql) => {
        // Update request
        const upd = new sql.Request(txn);
        upd.input('id', req.params.id);
        const reqRes = await upd.query(`
          UPDATE APPROVAL_REQUEST SET Status = 'Approved', DecisionDate = GETDATE() 
          OUTPUT INSERTED.Notes
          WHERE ApprovalID = @id AND Status = 'Pending'
        `);
        if (!reqRes.recordset.length) throw new Error('Request not found or already processed.');
        
        // Parse notes to get resource details
        const rData = JSON.parse(reqRes.recordset[0].Notes);
        
        // Add to history
        const hist = new sql.Request(txn);
        hist.input('aid', req.params.id);
        hist.input('uid', req.user.userID);
        hist.input('com', notes || 'Approved');
        await hist.query(`INSERT INTO APPROVAL_HISTORY (ApprovalID, ActionTaken, Comments, ActionBy) VALUES (@aid, 'Approved', @com, @uid)`);

        // Allocate (trigger deductions)
        const alloc = new sql.Request(txn);
        alloc.input('res', rData.resourceID);
        alloc.input('qty', rData.quantity);
        alloc.input('aid', req.params.id);
        alloc.input('ev', rData.eventID || 1);
        await alloc.query(`
          INSERT INTO RESOURCE_ALLOCATION (ResourceID, EventID, ApprovalID, ReportID, QtyDispatched, QtyConsumed, AllocationDate, Status, Notes)
          VALUES (@res, @ev, @aid, NULL, @qty, 0, GETDATE(), 'Dispatched', 'Approved via request #' + CAST(@aid AS VARCHAR))
        `);
      });
      res.json({ success: true, message: 'Request approved.' });
    } else {
      await query(`UPDATE APPROVAL_REQUEST SET Status = 'Rejected', DecisionDate = GETDATE() WHERE ApprovalID = @id`, { id: req.params.id });
      await query(`INSERT INTO APPROVAL_HISTORY (ApprovalID, ActionTaken, Comments, ActionBy) VALUES (@id, 'Rejected', @notes, @uid)`, { id: req.params.id, notes, uid: req.user.userID });
      res.json({ success: true, message: 'Request rejected.' });
    }
  } catch (err) {
    next(err);
  }
});

router.get('/stats/summary', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) AS totalItems,
         SUM(CASE WHEN QtyAvailable <= Threshold THEN 1 ELSE 0 END) AS lowStockItems,
         (SELECT COUNT(*) FROM WAREHOUSE) AS activeWarehouses,
         (SELECT COUNT(*) FROM APPROVAL_REQUEST WHERE Status = 'Pending') AS pendingRequests
       FROM RESOURCE`
    );
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
