/*USE master;
GO
IF EXISTS (SELECT name FROM sys.databases WHERE name = 'DisasterMIS')
BEGIN
    ALTER DATABASE DisasterMIS SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE DisasterMIS;
END
GO
CREATE DATABASE DisasterMIS;
GO
*/
USE DisasterMIS;
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