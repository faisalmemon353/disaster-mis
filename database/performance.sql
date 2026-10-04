-- ============================================================
-- DisasterMIS — Triggers, Stored Procedures & Views
-- Run this file AFTER schema.sql has been executed.
-- ============================================================
USE DisasterMIS;
GO

-- ============================================================
-- SECTION 1: VIEWS
-- ============================================================

CREATE VIEW v_ActiveRescueMissions AS
SELECT
    TA.AssignmentID,
    RT.TeamName,
    DE.Location AS DisasterLocation,
    DE.DisasterType,
    TA.Status AS AssignmentStatus
FROM TEAM_ASSIGNMENT TA
JOIN RESCUE_TEAM RT ON TA.TeamID = RT.TeamID
JOIN DISASTER_EVENT DE ON TA.EventID = DE.EventID
WHERE TA.Status != 'Completed';
GO

CREATE VIEW v_WarehouseStockSummary AS
SELECT
    W.Name AS WarehouseName,
    R.ResourceName,
    R.QtyAvailable,
    R.Threshold,
    CASE
        WHEN R.QtyAvailable <= R.Threshold THEN 'CRITICAL'
        ELSE 'OK'
    END AS StockStatus
FROM RESOURCE R
JOIN WAREHOUSE W ON R.WarehouseID = W.WarehouseID;
GO

CREATE VIEW v_HospitalStatus AS
SELECT
    Name,
    TotalBeds,
    AvailableBeds,
    (TotalBeds - AvailableBeds) AS OccupiedBeds
FROM HOSPITAL;
GO

-- ============================================================
-- SECTION 2: TRIGGERS
-- ============================================================

-- Decrements AvailableBeds when a new patient is admitted to a hospital.
CREATE TRIGGER trg_AfterPatientAdmission
ON PATIENT
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE h
    SET h.AvailableBeds = h.AvailableBeds - 1
    FROM HOSPITAL h
    INNER JOIN inserted i ON h.HospitalID = i.HospitalID
    WHERE h.AvailableBeds > 0;
END;
GO

-- Automatically frees up 1 hospital bed capacity when a patient's medical case
-- is marked as 'Discharged'. The backend discharge route does NOT update
-- AvailableBeds directly — this trigger is the single source of truth for that.
CREATE TRIGGER trg_UpdatePatientDischarge
ON PATIENT
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE h
    SET h.AvailableBeds = h.AvailableBeds + 1
    FROM HOSPITAL h
    INNER JOIN inserted i ON h.HospitalID = i.HospitalID
    INNER JOIN deleted  d ON i.PatientID  = d.PatientID
    WHERE i.CaseStatus = 'Discharged' AND d.CaseStatus != 'Discharged';
END;
GO

-- Decrements resource stock quantity when an allocation is created.
-- Also raises a STOCK_ALERT if stock falls at or below the threshold.
CREATE TRIGGER trg_AfterResourceAllocation
ON RESOURCE_ALLOCATION
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE r
    SET r.QtyAvailable = r.QtyAvailable - i.QtyDispatched
    FROM RESOURCE r
    INNER JOIN inserted i ON r.ResourceID = i.ResourceID;

    INSERT INTO STOCK_ALERT (ResourceID, AlertLevel, Message)
    SELECT i.ResourceID, 'URGENT', 'Stock level critical after allocation.'
    FROM inserted i
    INNER JOIN RESOURCE r ON i.ResourceID = r.ResourceID
    WHERE r.QtyAvailable <= r.Threshold;
END;
GO

-- Automates operational auditing by logging any status changes of a Rescue Team
-- to track their deployments.
CREATE TRIGGER trg_TrackTeamStatusChange
ON RESCUE_TEAM
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO TEAM_ACTIVITY_LOG (TeamID, PreviousStatus, NewStatus)
    SELECT i.TeamID, d.AvailabilityStatus, i.AvailabilityStatus
    FROM inserted i
    INNER JOIN deleted d ON i.TeamID = d.TeamID
    WHERE i.AvailabilityStatus != d.AvailabilityStatus;
END;
GO

-- Logs role or active-status changes on the USER table to the AUDIT_LOG.
CREATE TRIGGER trg_AfterUserUpdate
ON [USER]
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO AUDIT_LOG (UserID, Action, TableName, RecordID, OldValue, NewValue)
    SELECT
        i.UserID, 'UPDATE', 'USER', i.UserID,
        CONCAT('Role:', d.RoleID, ', Active:', d.IsActive),
        CONCAT('Role:', i.RoleID, ', Active:', i.IsActive)
    FROM inserted i
    INNER JOIN deleted d ON i.UserID = d.UserID
    WHERE d.RoleID != i.RoleID OR d.IsActive != i.IsActive;
END;
GO

-- ============================================================
-- SECTION 3: STORED PROCEDURES (TRANSACTIONS)
-- ============================================================

-- Executes a safe transaction to assign a rescue team to an emergency,
-- updating team status concurrently.
CREATE PROCEDURE sp_AssignRescueTeam
    @p_TeamID   INT,
    @p_EventID  INT,
    @p_Score    DECIMAL(5,2)
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRY
        BEGIN TRANSACTION;

        INSERT INTO TEAM_ASSIGNMENT (TeamID, EventID, ProximityScore, Status)
        VALUES (@p_TeamID, @p_EventID, @p_Score, 'En Route');

        UPDATE RESCUE_TEAM
        SET AvailabilityStatus = 'On Mission'
        WHERE TeamID = @p_TeamID;

        UPDATE DISASTER_EVENT
        SET Status = 'Assigned'
        WHERE EventID = @p_EventID;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END;
GO

-- Atomic transaction for recording a donation and updating the event budget.
CREATE PROCEDURE sp_ProcessDonation
    @p_EventID          INT,
    @p_FinanceOfficerID INT,
    @p_Amount           DECIMAL(12,2),
    @p_DonorType        NVARCHAR(50),
    @p_DonorContact     NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @NewTxID INT;

        INSERT INTO FINANCIAL_TRANSACTION (EventID, FinanceOfficerID, TransType, Amount, Description)
        VALUES (@p_EventID, @p_FinanceOfficerID, 'Donation', @p_Amount, 'Emergency Relief Fund');

        SET @NewTxID = SCOPE_IDENTITY();

        INSERT INTO DONATION (TransactionID, DonorType)
        VALUES (@NewTxID, @p_DonorType);

        UPDATE DISASTER_EVENT
        SET Budget = Budget + @p_Amount
        WHERE EventID = @p_EventID;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END;
GO

-- Transfers a patient from one hospital to another, adjusting bed counts atomically.
CREATE PROCEDURE sp_EscalatePatient
    @p_PatientID        INT,
    @p_SourceHospitalID INT,
    @p_TargetHospitalID INT,
    @p_EscalationReason NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRY
        BEGIN TRANSACTION;

        INSERT INTO ESCALATION (PatientID, SourceHospitalID, TargetHospitalID, Reason)
        VALUES (@p_PatientID, @p_SourceHospitalID, @p_TargetHospitalID, @p_EscalationReason);

        UPDATE PATIENT
        SET HospitalID = @p_TargetHospitalID
        WHERE PatientID = @p_PatientID;

        UPDATE HOSPITAL
        SET AvailableBeds = AvailableBeds + 1
        WHERE HospitalID = @p_SourceHospitalID;

        UPDATE HOSPITAL
        SET AvailableBeds = AvailableBeds - 1
        WHERE HospitalID = @p_TargetHospitalID;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END;
GO
