-- ============================================================
-- DisasterMIS_Test — Self-Contained Test Database
-- Combines: schema + performance objects + verification queries
-- This file targets DisasterMIS_Test (NOT the live DisasterMIS DB)
-- Run the entire file in SSMS, or highlight blocks individually.
-- ============================================================
USE master;
GO
IF EXISTS (SELECT name FROM sys.databases WHERE name = 'DisasterMIS_Test')
BEGIN
    ALTER DATABASE DisasterMIS_Test SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE DisasterMIS_Test;
END
GO
CREATE DATABASE DisasterMIS_Test;
GO
USE DisasterMIS_Test;
GO

-- 1. USER MANAGEMENT (Disjoint Sub-types 'd')
CREATE TABLE [ROLE] (
    RoleID INT IDENTITY(1,1) PRIMARY KEY,
    RoleName NVARCHAR(50) NOT NULL UNIQUE,
    Description NVARCHAR(255)
);

CREATE TABLE [PERMISSION] (
    PermissionID INT IDENTITY(1,1) PRIMARY KEY,
    RoleID INT NOT NULL,
    TableName NVARCHAR(50) NOT NULL,
    CanRead BIT DEFAULT 1,
    CanCreate BIT DEFAULT 0,
    CanUpdate BIT DEFAULT 0,
    CanDelete BIT DEFAULT 0,
    FOREIGN KEY (RoleID) REFERENCES [ROLE](RoleID) ON DELETE CASCADE
);

CREATE TABLE [USER] (
    UserID INT IDENTITY(1,1) PRIMARY KEY,
    RoleID INT NOT NULL,
    Name NVARCHAR(100) NOT NULL,
    Email NVARCHAR(150) NOT NULL UNIQUE,
    Password NVARCHAR(255) NOT NULL,
    UserType NVARCHAR(50) NOT NULL CHECK (UserType IN ('Admin', 'Operator', 'FieldOfficer', 'WHManager', 'FinanceOfficer', 'Citizen')),
    CreatedAt DATETIME2 DEFAULT GETDATE(),
    IsActive BIT DEFAULT 1,
    FOREIGN KEY (RoleID) REFERENCES [ROLE](RoleID)
);

CREATE TABLE ADMINISTRATOR (
    AdminID INT PRIMARY KEY,
    AccessLevel INT DEFAULT 1,
    FOREIGN KEY (AdminID) REFERENCES [USER](UserID) ON DELETE CASCADE
);

CREATE TABLE EMERGENCY_OPERATOR (
    OperatorID INT PRIMARY KEY,
    ShiftSchedule NVARCHAR(50),
    FOREIGN KEY (OperatorID) REFERENCES [USER](UserID) ON DELETE CASCADE
);

CREATE TABLE FIELD_OFFICER (
    FieldOfficerID INT PRIMARY KEY,
    AssignedZone NVARCHAR(100),
    FOREIGN KEY (FieldOfficerID) REFERENCES [USER](UserID) ON DELETE CASCADE
);

CREATE TABLE WAREHOUSE_MANAGER (
    WarehouseMgrID INT PRIMARY KEY,
    WarehouseRef NVARCHAR(100),
    FOREIGN KEY (WarehouseMgrID) REFERENCES [USER](UserID) ON DELETE CASCADE
);

CREATE TABLE FINANCE_OFFICER (
    FinanceOfficerID INT PRIMARY KEY,
    Department NVARCHAR(50),
    FOREIGN KEY (FinanceOfficerID) REFERENCES [USER](UserID) ON DELETE CASCADE
);

-- 2. DISASTER & REPORTING
CREATE TABLE CITIZEN (
    CitizenID INT IDENTITY(1,1) PRIMARY KEY,
    Name NVARCHAR(100) NOT NULL,
    CNIC NVARCHAR(15) NOT NULL UNIQUE,
    ContactInfo NVARCHAR(100),
    ReportSource NVARCHAR(100) DEFAULT 'Web/Mobile'
);

CREATE TABLE CITIZEN_PHONE (
    CitizenID INT,
    Phone NVARCHAR(15),
    PRIMARY KEY (CitizenID, Phone),
    FOREIGN KEY (CitizenID) REFERENCES CITIZEN(CitizenID) ON DELETE CASCADE
);

CREATE TABLE DISASTER_EVENT (
    EventID INT IDENTITY(1,1) PRIMARY KEY,
    DisasterType NVARCHAR(50) NOT NULL,
    Location NVARCHAR(255) NOT NULL,
    StartTime DATETIME2 NOT NULL,
    EndTime DATETIME2,
    Status NVARCHAR(50) DEFAULT 'Pending',
    Budget DECIMAL(12, 2) DEFAULT 0.00
);

CREATE TABLE DISASTER_OFFICER (
    EventID INT,
    OfficerID INT,
    AssignedAt DATETIME2 DEFAULT GETDATE(),
    PRIMARY KEY (EventID, OfficerID),
    FOREIGN KEY (EventID) REFERENCES DISASTER_EVENT(EventID),
    FOREIGN KEY (OfficerID) REFERENCES [USER](UserID)
);

CREATE TABLE EMERGENCY_REPORT (
    ReportID INT IDENTITY(1,1) PRIMARY KEY,
    EventID INT,
    CitizenID INT NOT NULL,
    OperatorID INT,
    DisasterType NVARCHAR(50) NOT NULL,
    Location NVARCHAR(255) NOT NULL,
    SeverityLevel INT CHECK (SeverityLevel BETWEEN 1 AND 5),
    TimeOfReport DATETIME2 DEFAULT GETDATE(),
    Status NVARCHAR(50) DEFAULT 'Pending',
    FOREIGN KEY (EventID) REFERENCES DISASTER_EVENT(EventID),
    FOREIGN KEY (CitizenID) REFERENCES CITIZEN(CitizenID),
    FOREIGN KEY (OperatorID) REFERENCES EMERGENCY_OPERATOR(OperatorID)
);

-- 3. HOSPITAL & MEDICAL ESCALATION
CREATE TABLE HOSPITAL (
    HospitalID INT IDENTITY(1,1) PRIMARY KEY,
    Name NVARCHAR(100) NOT NULL,
    Location NVARCHAR(255),
    TotalBeds INT DEFAULT 0,
    AvailableBeds INT DEFAULT 0,
    HospitalStatus NVARCHAR(50) DEFAULT 'Functional',
    ContactInfo NVARCHAR(100)
);

CREATE TABLE PATIENT (
    PatientID INT IDENTITY(1,1) PRIMARY KEY,
    HospitalID INT,              -- Nullable: patients are registered before admission
    ReportID INT,
    PatientName NVARCHAR(100),
    MedicalCondition NVARCHAR(50),  -- Critical / Serious / Stable / Minor
    AdmissionDate DATETIME2,     -- Set on admission, not registration
    DischargeDate DATETIME2,
    CaseStatus NVARCHAR(50) DEFAULT 'Registered',  -- Lifecycle: Registered / Admitted / Discharged
    FOREIGN KEY (HospitalID) REFERENCES HOSPITAL(HospitalID),
    FOREIGN KEY (ReportID) REFERENCES EMERGENCY_REPORT(ReportID)
);

CREATE TABLE ESCALATION (
    EscalationID INT IDENTITY(1,1) PRIMARY KEY,
    PatientID INT NOT NULL,
    SourceHospitalID INT NOT NULL,
    TargetHospitalID INT NOT NULL,
    Reason NVARCHAR(MAX),
    EscalatedAt DATETIME2 DEFAULT GETDATE(),
    Status NVARCHAR(50) DEFAULT 'Pending',
    FOREIGN KEY (PatientID) REFERENCES PATIENT(PatientID) ON DELETE CASCADE,
    FOREIGN KEY (SourceHospitalID) REFERENCES HOSPITAL(HospitalID),
    FOREIGN KEY (TargetHospitalID) REFERENCES HOSPITAL(HospitalID)
);

-- 4. RESCUE OPERATIONS
CREATE TABLE RESCUE_TEAM (
    TeamID INT IDENTITY(1,1) PRIMARY KEY,
    TeamName NVARCHAR(100) NOT NULL,
    TeamType NVARCHAR(50),
    CurrentLocation NVARCHAR(255),
    AvailabilityStatus NVARCHAR(50) DEFAULT 'Available'
);

CREATE TABLE TEAM_MEMBER (
    MemberID INT IDENTITY(1,1) PRIMARY KEY,
    TeamID INT NULL,
    MemberName NVARCHAR(100) NOT NULL,
    MemberRole NVARCHAR(50),
    MemberContact NVARCHAR(50),
    FOREIGN KEY (TeamID) REFERENCES RESCUE_TEAM(TeamID) ON DELETE SET NULL
);

CREATE TABLE TEAM_ASSIGNMENT (
    AssignmentID INT IDENTITY(1,1) PRIMARY KEY,
    TeamID INT NOT NULL,
    EventID INT NOT NULL,
    AssignedAt DATETIME2 DEFAULT GETDATE(),
    CompletedAt DATETIME2,
    ProximityScore DECIMAL(5,2),
    SeverityMatch BIT,
    Status NVARCHAR(50) DEFAULT 'En Route',
    FOREIGN KEY (TeamID) REFERENCES RESCUE_TEAM(TeamID),
    FOREIGN KEY (EventID) REFERENCES DISASTER_EVENT(EventID)
);

CREATE TABLE TEAM_ACTIVITY_LOG (
    LogID INT IDENTITY(1,1) PRIMARY KEY,
    TeamID INT NOT NULL,
    PreviousStatus NVARCHAR(50),
    NewStatus NVARCHAR(50),
    ChangedAt DATETIME2 DEFAULT GETDATE(),
    ChangedBy INT,
    FOREIGN KEY (TeamID) REFERENCES RESCUE_TEAM(TeamID),
    FOREIGN KEY (ChangedBy) REFERENCES [USER](UserID)
);

-- 5. RESOURCE MANAGEMENT
CREATE TABLE WAREHOUSE (
    WarehouseID INT IDENTITY(1,1) PRIMARY KEY,
    WarehouseMgrID INT,
    Name NVARCHAR(100) NOT NULL,
    Location NVARCHAR(255),
    FOREIGN KEY (WarehouseMgrID) REFERENCES WAREHOUSE_MANAGER(WarehouseMgrID)
);

CREATE TABLE RESOURCE (
    ResourceID INT IDENTITY(1,1) PRIMARY KEY,
    WarehouseID INT NOT NULL,
    ResourceType NVARCHAR(50),
    ResourceName NVARCHAR(100) NOT NULL,
    Unit NVARCHAR(20),
    QtyAvailable INT NOT NULL DEFAULT 0,
    Threshold INT NOT NULL DEFAULT 10,
    FOREIGN KEY (WarehouseID) REFERENCES WAREHOUSE(WarehouseID)
);

CREATE TABLE STOCK_ALERT (
    AlertID INT IDENTITY(1,1) PRIMARY KEY,
    ResourceID INT NOT NULL,
    AlertDate DATETIME2 DEFAULT GETDATE(),
    AlertLevel NVARCHAR(20),
    Message NVARCHAR(255),
    FOREIGN KEY (ResourceID) REFERENCES RESOURCE(ResourceID) ON DELETE CASCADE
);

CREATE TABLE APPROVAL_REQUEST (
    ApprovalID INT IDENTITY(1,1) PRIMARY KEY,
    RequestedBy INT NOT NULL,
    RequestType NVARCHAR(50),
    Status NVARCHAR(50) DEFAULT 'Pending',
    RequestDate DATETIME2 DEFAULT GETDATE(),
    DecisionDate DATETIME2,
    Notes NVARCHAR(MAX),
    FOREIGN KEY (RequestedBy) REFERENCES [USER](UserID)
);

CREATE TABLE APPROVAL_HISTORY (
    HistoryID INT IDENTITY(1,1) PRIMARY KEY,
    ApprovalID INT NOT NULL,
    ActionTaken NVARCHAR(50),
    ActionDate DATETIME2 DEFAULT GETDATE(),
    Comments NVARCHAR(MAX),
    ActionBy INT,
    FOREIGN KEY (ApprovalID) REFERENCES APPROVAL_REQUEST(ApprovalID) ON DELETE CASCADE
);

CREATE TABLE RESOURCE_ALLOCATION (
    AllocationID INT IDENTITY(1,1) PRIMARY KEY,
    ResourceID INT NOT NULL,
    EventID INT NOT NULL,
    ReportID INT NULL,
    ApprovalID INT,
    QtyDispatched INT NOT NULL,
    QtyConsumed INT DEFAULT 0,
    DistributionCost DECIMAL(10,2) DEFAULT 0.00,
    AllocationDate DATETIME2 DEFAULT GETDATE(),
    Status NVARCHAR(50) DEFAULT 'Allocated',
    Notes NVARCHAR(MAX),
    FOREIGN KEY (ResourceID) REFERENCES RESOURCE(ResourceID),
    FOREIGN KEY (EventID) REFERENCES DISASTER_EVENT(EventID),
    FOREIGN KEY (ApprovalID) REFERENCES APPROVAL_REQUEST(ApprovalID),
    FOREIGN KEY (ReportID) REFERENCES EMERGENCY_REPORT(ReportID)
);

-- 6. FINANCIAL TRANSACTIONS
CREATE TABLE FINANCIAL_TRANSACTION (
    TransactionID INT IDENTITY(1,1) PRIMARY KEY,
    EventID INT NOT NULL,
    FinanceOfficerID INT NOT NULL,
    TransType NVARCHAR(50) NOT NULL CHECK (TransType IN ('Donation', 'Expense', 'Procurement')),
    Amount DECIMAL(12, 2) NOT NULL,
    TxDate DATETIME2 DEFAULT GETDATE(),
    Description NVARCHAR(255),
    FOREIGN KEY (EventID) REFERENCES DISASTER_EVENT(EventID),
    FOREIGN KEY (FinanceOfficerID) REFERENCES FINANCE_OFFICER(FinanceOfficerID)
);

CREATE TABLE EXPENSE (
    TransactionID INT PRIMARY KEY,
    Category NVARCHAR(50),
    Vendor NVARCHAR(100),
    FOREIGN KEY (TransactionID) REFERENCES FINANCIAL_TRANSACTION(TransactionID) ON DELETE CASCADE
);

CREATE TABLE PROCUREMENT (
    TransactionID INT PRIMARY KEY,
    ItemDescription NVARCHAR(255),
    Supplier NVARCHAR(100),
    Quantity INT,
    FOREIGN KEY (TransactionID) REFERENCES FINANCIAL_TRANSACTION(TransactionID) ON DELETE CASCADE
);

CREATE TABLE DONATION (
    TransactionID INT PRIMARY KEY,
    DonorType NVARCHAR(50) NOT NULL CHECK (DonorType IN ('Individual', 'Organization')),
    FOREIGN KEY (TransactionID) REFERENCES FINANCIAL_TRANSACTION(TransactionID) ON DELETE CASCADE
);

CREATE TABLE INDIVIDUAL_DONATION (
    TransactionID INT PRIMARY KEY,
    DonorName NVARCHAR(100),
    DonorCNIC NVARCHAR(15),
    DonorContact NVARCHAR(50),
    FOREIGN KEY (TransactionID) REFERENCES DONATION(TransactionID) ON DELETE CASCADE
);

CREATE TABLE ORG_DONATION (
    TransactionID INT PRIMARY KEY,
    OrgName NVARCHAR(100),
    OrgNTN NVARCHAR(20),
    OrgContact NVARCHAR(50),
    FOREIGN KEY (TransactionID) REFERENCES DONATION(TransactionID) ON DELETE CASCADE
);

CREATE TABLE FINANCIAL_AUDIT (
    AuditID INT IDENTITY(1,1) PRIMARY KEY,
    TransactionID INT NOT NULL,
    ApprovedBy INT NOT NULL,
    AuditDate DATETIME2 DEFAULT GETDATE(),
    Remarks NVARCHAR(255),
    FOREIGN KEY (TransactionID) REFERENCES FINANCIAL_TRANSACTION(TransactionID),
    FOREIGN KEY (ApprovedBy) REFERENCES FINANCE_OFFICER(FinanceOfficerID)
);

-- 7. MIS REPORTING & AUDIT LOGGING
CREATE TABLE AUDIT_LOG (
    LogID INT IDENTITY(1,1) PRIMARY KEY,
    UserID INT,
    Action NVARCHAR(50) NOT NULL,
    TableName NVARCHAR(50) NOT NULL,
    RecordID INT,
    OldValue NVARCHAR(MAX),
    NewValue NVARCHAR(MAX),
    Timestamp DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (UserID) REFERENCES [USER](UserID)
);

CREATE TABLE MIS_REPORT (
    ReportID INT IDENTITY(1,1) PRIMARY KEY,
    GeneratedBy INT NOT NULL,
    ReportType NVARCHAR(50),
    Parameters NVARCHAR(MAX),
    GeneratedAt DATETIME2 DEFAULT GETDATE(),
    OutputFormat NVARCHAR(20),
    FOREIGN KEY (GeneratedBy) REFERENCES [USER](UserID)
);

-- ============================================================
-- 8. PERFORMANCE INDEXING STRATEGY
-- ============================================================

-- Single-Column Indexes for fast lookup on unique identifiers and filtered columns
CREATE INDEX idx_citizen_cnic  ON CITIZEN(CNIC);
CREATE INDEX idx_user_email    ON [USER](Email);
CREATE INDEX idx_report_status ON EMERGENCY_REPORT(Status);
CREATE INDEX idx_event_status  ON DISASTER_EVENT(Status);
CREATE INDEX idx_resource_type ON RESOURCE(ResourceType);
CREATE INDEX idx_trans_time    ON FINANCIAL_TRANSACTION(TxDate);

-- Composite Index: optimizes queries that filter by both Location and DisasterType simultaneously
CREATE INDEX idx_report_loc_type ON EMERGENCY_REPORT(Location, DisasterType);
GO

-- ============================================================
-- SEED DATA
-- ============================================================

-- Seed Basic Roles
INSERT INTO [ROLE] (RoleName, Description) VALUES
('Admin',              'Full system access'),
('Emergency Operator', 'Manages reports and team assignments'),
('Field Officer',      'On-ground operations, submits reports'),
('Warehouse Manager',  'Manages inventory and allocations'),
('Finance Officer',    'Manages financial records');

-- Seed Admin User (Password is 'Admin@123' bcrypt hash, rounds=10)
INSERT INTO [USER] (RoleID, Name, Email, Password, UserType) VALUES
(1, 'Hazber Samson',  'admin@dismis.pk',     '$2a$10$I3u7Hea7FnETU3LtEWRPruTMLBhIQ7V8mThg.Yzvws50Jk5UXYHOu', 'Admin'),
(2, 'Sarah Operator', 'operator@dismis.pk',  '$2a$10$I3u7Hea7FnETU3LtEWRPruTMLBhIQ7V8mThg.Yzvws50Jk5UXYHOu', 'Operator'),
(3, 'John Field',     'field01@dismis.pk',   '$2a$10$I3u7Hea7FnETU3LtEWRPruTMLBhIQ7V8mThg.Yzvws50Jk5UXYHOu', 'FieldOfficer'),
(4, 'Mike Warehouse', 'warehouse@dismis.pk', '$2a$10$I3u7Hea7FnETU3LtEWRPruTMLBhIQ7V8mThg.Yzvws50Jk5UXYHOu', 'WHManager'),
(5, 'Elena Finance',  'finance@dismis.pk',   '$2a$10$I3u7Hea7FnETU3LtEWRPruTMLBhIQ7V8mThg.Yzvws50Jk5UXYHOu', 'FinanceOfficer');

INSERT INTO ADMINISTRATOR (AdminID, AccessLevel) VALUES (1, 1);
INSERT INTO EMERGENCY_OPERATOR (OperatorID, ShiftSchedule) VALUES (2, 'Night Shift');
INSERT INTO FIELD_OFFICER (FieldOfficerID, AssignedZone) VALUES (3, 'Zone A');
INSERT INTO WAREHOUSE_MANAGER (WarehouseMgrID, WarehouseRef) VALUES (4, 'Central WH');
INSERT INTO FINANCE_OFFICER (FinanceOfficerID, Department) VALUES (5, 'Accounts');
GO
-- ============================================================
-- DisasterMIS — Triggers, Stored Procedures & Views
-- Run this file AFTER schema.sql has been executed.
-- ============================================================
USE DisasterMIS_Test;
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

-- ============================================================
-- DisasterMIS — Database Verification & Performance Testing
-- Section 12: Run this file in SSMS AFTER schema.sql and
-- performance.sql have been executed.
--
-- NOTE: Highlight and execute these blocks individually in SSMS.
-- ============================================================
USE DisasterMIS_Test;
GO

-- ============================================================
-- A. SEED DUMMY DATA
-- ============================================================
BEGIN TRY
    INSERT INTO HOSPITAL (Name, Location, TotalBeds, AvailableBeds, HospitalStatus) VALUES 
    ('City General Hospital',    'Downtown Block A',  500, 45,  'Functional'),
    ('Mercy Medical Center',     'Westside Avenue',   300, 0,   'Critical Full'),
    ('Red Cross Field Hospital', 'North Zone Camp',   150, 110, 'Functional');

    INSERT INTO WAREHOUSE (Name, Location) VALUES ('Central Relief Depot', 'Industrial Area');

    INSERT INTO RESOURCE (WarehouseID, ResourceType, ResourceName, Unit, QtyAvailable, Threshold) VALUES 
    (1, 'Medical',   'First Aid Kits', 'Boxes',  5,   20),   -- CRITICAL (below threshold)
    (1, 'Food',      'MRE Rations',    'Pallets', 150, 50),   -- OK
    (1, 'Equipment', 'Rescue Tents',   'Units',   2,  10);   -- CRITICAL (below threshold)

    INSERT INTO DISASTER_EVENT (DisasterType, Location, StartTime, Status) VALUES 
    ('Flood', 'Riverbank Colony', GETDATE(), 'Active');

    INSERT INTO CITIZEN (Name, CNIC, ContactInfo) VALUES ('Ali Khan', '35201-1234567-8', '0300-1234567');

    INSERT INTO EMERGENCY_REPORT (EventID, CitizenID, DisasterType, Location, SeverityLevel) VALUES 
    (1, 1, 'Flood', 'Riverbank Colony Sector 4', 5);

    INSERT INTO RESCUE_TEAM (TeamName, TeamType, CurrentLocation, AvailabilityStatus) VALUES 
    ('Alpha Swift Water Rescue', 'Water Rescue',     'HQ',        'Available'),
    ('Bravo Medics',             'Medical Response', 'North Zone', 'Available');

    INSERT INTO PATIENT (HospitalID, ReportID, PatientName, MedicalCondition, AdmissionDate, CaseStatus)
    VALUES (1, 1, 'Sana Malik', 'Stable', GETDATE(), 'Registered');

    IF NOT EXISTS (SELECT 1 FROM ADMINISTRATOR   WHERE AdminID = 1)
        INSERT INTO ADMINISTRATOR (AdminID, AccessLevel) VALUES (1, 1);
    IF NOT EXISTS (SELECT 1 FROM FINANCE_OFFICER WHERE FinanceOfficerID = 1)
        INSERT INTO FINANCE_OFFICER (FinanceOfficerID, Department) VALUES (1, 'Headquarters');
END TRY
BEGIN CATCH
    PRINT 'Dummy data already exists or constraint violation occurred. Skipping seed.';
END CATCH
GO

-- ============================================================
-- B. VIEW DEFINITIONS & PERFORMANCE COMPARISON
-- ============================================================
SET STATISTICS TIME ON;

PRINT '--- [v_WarehouseStockSummary] RUNNING DIRECT QUERY ---';
SELECT W.Name AS WarehouseName, R.ResourceName, R.QtyAvailable, R.Threshold,
    CASE WHEN R.QtyAvailable <= R.Threshold THEN 'CRITICAL' ELSE 'OK' END AS StockStatus
FROM RESOURCE R JOIN WAREHOUSE W ON R.WarehouseID = W.WarehouseID;

PRINT '--- [v_WarehouseStockSummary] RUNNING VIEW QUERY ---';
SELECT * FROM v_WarehouseStockSummary;

PRINT '--- [v_HospitalStatus] RUNNING DIRECT QUERY ---';
SELECT Name, TotalBeds, AvailableBeds, (TotalBeds - AvailableBeds) AS OccupiedBeds FROM HOSPITAL;

PRINT '--- [v_HospitalStatus] RUNNING VIEW QUERY ---';
SELECT * FROM v_HospitalStatus;

PRINT '--- [v_ActiveRescueMissions] RUNNING DIRECT QUERY ---';
SELECT TA.AssignmentID, RT.TeamName, DE.Location AS DisasterLocation, DE.DisasterType, TA.Status AS AssignmentStatus
FROM TEAM_ASSIGNMENT TA
JOIN RESCUE_TEAM RT ON TA.TeamID = RT.TeamID
JOIN DISASTER_EVENT DE ON TA.EventID = DE.EventID
WHERE TA.Status != 'Completed';

PRINT '--- [v_ActiveRescueMissions] RUNNING VIEW QUERY ---';
SELECT * FROM v_ActiveRescueMissions;

SET STATISTICS TIME OFF;
GO

-- ============================================================
-- C. ANALYTICAL QUERIES
-- ============================================================

-- Total resources allocated per disaster type and location
SELECT 
    DE.DisasterType, 
    DE.Location, 
    SUM(RA.QtyDispatched) AS TotalResourcesAllocated
FROM DISASTER_EVENT DE
JOIN RESOURCE_ALLOCATION RA ON DE.EventID = RA.EventID
GROUP BY DE.DisasterType, DE.Location;
GO

-- Hospital occupancy rate
SELECT 
    Name AS HospitalName, 
    TotalBeds, 
    AvailableBeds, 
    CAST(((TotalBeds - AvailableBeds) * 100.0 / TotalBeds) AS DECIMAL(5,2)) AS OccupancyPercentage
FROM HOSPITAL;
GO

-- Financial transaction summary by type
SELECT 
    TransType, 
    COUNT(TransactionID) AS TotalTransactions, 
    SUM(Amount) AS TotalAmount
FROM FINANCIAL_TRANSACTION
GROUP BY TransType;
GO

-- ============================================================
-- D. TRIGGER VERIFICATION
-- ============================================================

-- D1. trg_AfterResourceAllocation: Stock reduction + STOCK_ALERT on critical level
SELECT ResourceID, ResourceName, QtyAvailable, Threshold FROM RESOURCE WHERE ResourceID = 1;
INSERT INTO RESOURCE_ALLOCATION (ResourceID, EventID, QtyDispatched) VALUES (1, 1, 4);
-- Expected: QtyAvailable drops from 5 → 1, STOCK_ALERT row inserted
SELECT ResourceID, ResourceName, QtyAvailable, Threshold FROM RESOURCE WHERE ResourceID = 1;
SELECT * FROM STOCK_ALERT;
GO

-- D2. trg_AfterPatientAdmission: AvailableBeds decrements on INSERT
SELECT HospitalID, Name, TotalBeds, AvailableBeds FROM HOSPITAL WHERE HospitalID = 1;
INSERT INTO PATIENT (HospitalID, PatientName, MedicalCondition, AdmissionDate, CaseStatus)
VALUES (1, 'Ahmed Raza', 'Serious', GETDATE(), 'Admitted');
-- Expected: AvailableBeds decrements by 1
SELECT HospitalID, Name, TotalBeds, AvailableBeds FROM HOSPITAL WHERE HospitalID = 1;
GO

-- D3. trg_AfterUserUpdate: AUDIT_LOG entry on role/status change
SELECT * FROM AUDIT_LOG;
UPDATE [USER] SET IsActive = 0 WHERE UserID = 2;
-- Expected: New AUDIT_LOG row with OldValue/NewValue for UserID=2
SELECT * FROM AUDIT_LOG;
GO

-- D4. trg_TrackTeamStatusChange: TEAM_ACTIVITY_LOG entry on status change
SELECT * FROM TEAM_ACTIVITY_LOG;
UPDATE RESCUE_TEAM SET AvailabilityStatus = 'Maintenance' WHERE TeamID = 1;
-- Expected: New log row with PreviousStatus='Available', NewStatus='Maintenance'
SELECT * FROM TEAM_ACTIVITY_LOG;
GO

-- D5. trg_UpdatePatientDischarge: AvailableBeds increments on discharge
SELECT HospitalID, Name, TotalBeds, AvailableBeds FROM HOSPITAL WHERE HospitalID = 1;
UPDATE PATIENT SET CaseStatus = 'Discharged', DischargeDate = GETDATE() WHERE PatientID = 1;
-- Expected: AvailableBeds increments by 1 (trigger handles this, NOT the backend)
SELECT HospitalID, Name, TotalBeds, AvailableBeds FROM HOSPITAL WHERE HospitalID = 1;
GO

-- ============================================================
-- E. STORED PROCEDURE VERIFICATION
-- ============================================================

-- E1. sp_AssignRescueTeam
EXEC sp_AssignRescueTeam @p_TeamID = 1, @p_EventID = 1, @p_Score = 95.5;
-- Expected: New TEAM_ASSIGNMENT row, RESCUE_TEAM status = 'On Mission', EVENT status = 'Assigned'
SELECT * FROM TEAM_ASSIGNMENT WHERE TeamID = 1;
SELECT TeamID, TeamName, AvailabilityStatus FROM RESCUE_TEAM WHERE TeamID = 1;
SELECT EventID, Location, Status FROM DISASTER_EVENT WHERE EventID = 1;
GO

-- E2. sp_ProcessDonation
EXEC sp_ProcessDonation 
    @p_EventID = 1, @p_FinanceOfficerID = 1, @p_Amount = 50000.00, @p_DonorType = 'Individual';
-- Expected: New FINANCIAL_TRANSACTION + DONATION row, EventID=1 Budget increases by 50000
SELECT TOP 1 * FROM FINANCIAL_TRANSACTION ORDER BY TransactionID DESC;
SELECT EventID, Location, Budget FROM DISASTER_EVENT WHERE EventID = 1;
GO

-- E3. sp_EscalatePatient
EXEC sp_EscalatePatient 
    @p_PatientID = 1, @p_SourceHospitalID = 1, @p_TargetHospitalID = 2, 
    @p_EscalationReason = 'Critical condition requires specialist care';
-- Expected: Patient HospitalID changes to 2, Hospital 1 beds +1, Hospital 2 beds -1
SELECT PatientID, PatientName, HospitalID FROM PATIENT WHERE PatientID = 1;
SELECT HospitalID, Name, AvailableBeds FROM HOSPITAL WHERE HospitalID IN (1, 2);
GO

-- ============================================================
-- F. INDEX PERFORMANCE TESTING (Section 8)
-- ============================================================
SET STATISTICS IO ON;
GO

-- F1. idx_user_email: Table Scan vs Index Seek
PRINT '--- [idx_user_email] BEFORE: Full Table Scan ---';
SELECT * FROM [USER] WITH (INDEX(0)) WHERE Email = 'admin@dismis.pk';
PRINT '--- [idx_user_email] AFTER: Index Seek ---';
SELECT Email FROM [USER] WHERE Email = 'admin@dismis.pk'

GO



-- F2. idx_report_status: Table Scan vs Index Seek
PRINT '--- [idx_report_status] BEFORE: Full Table Scan ---';
SELECT * FROM EMERGENCY_REPORT WITH (INDEX(0)) WHERE Status = 'Pending';
PRINT '--- [idx_report_status] AFTER: Index Seek ---';
SELECT * FROM EMERGENCY_REPORT WHERE Status = 'Pending';
GO

-- F3. idx_resource_type: Table Scan vs Index Seek
PRINT '--- [idx_resource_type] BEFORE: Full Table Scan ---';
SELECT * FROM RESOURCE WITH (INDEX(0)) WHERE ResourceType = 'Medical';
PRINT '--- [idx_resource_type] AFTER: Index Seek ---';
SELECT * FROM RESOURCE WHERE ResourceType = 'Medical';
GO

-- F4. idx_report_loc_type: Composite Index Seek (Location + DisasterType)
PRINT '--- [idx_report_loc_type] Composite Index Seek ---';
SELECT * FROM EMERGENCY_REPORT 
WHERE Location = 'Riverbank Colony Sector 4' AND DisasterType = 'Flood';
GO

-- G. INDEX WRITE OVERHEAD TEST
SET STATISTICS TIME ON;
PRINT '--- INSERT OVERHEAD TEST (measures index maintenance cost) ---';
INSERT INTO RESOURCE (WarehouseID, ResourceType, ResourceName, QtyAvailable, Threshold)
SELECT TOP 1000 1, 'Medical', 'Gauze Roll', 100, 20 
FROM sys.objects AS a CROSS JOIN sys.objects AS b;
SET STATISTICS TIME OFF;
SET STATISTICS IO OFF;
GO


