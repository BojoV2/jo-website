CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    favorite_template_id UUID,
    last_active_at TIMESTAMP,
    role VARCHAR(20) CHECK (role IN ('super_admin', 'admin', 'user')) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_template_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS section_permissions JSONB DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMP NULL;

CREATE TABLE IF NOT EXISTS account_audit (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMP NOT NULL DEFAULT NOW(),
    action VARCHAR(60) NOT NULL,
    actor_id UUID,
    actor_name VARCHAR(150),
    target_name VARCHAR(150),
    detail TEXT,
    ip VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS account_audit_at_idx ON account_audit (at DESC);

CREATE TABLE IF NOT EXISTS pdf_templates (
    id UUID PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    file_path TEXT NOT NULL,
    version INT DEFAULT 1,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pdf_fields (
    id UUID PRIMARY KEY,
    template_id UUID REFERENCES pdf_templates(id) ON DELETE CASCADE,
    template_version INT DEFAULT 1,
    field_name VARCHAR(150) NOT NULL,
    field_type VARCHAR(50) DEFAULT 'text',
    field_options JSONB DEFAULT '[]'::jsonb,
    validation_rules JSONB DEFAULT '{}'::jsonb,
    page_number INT NOT NULL,
    x_position FLOAT NOT NULL,
    y_position FLOAT NOT NULL,
    box_width FLOAT,
    box_height FLOAT,
    font_size INT DEFAULT 12,
    auto_font BOOLEAN DEFAULT TRUE,
    required BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE pdf_fields ADD COLUMN IF NOT EXISTS box_width FLOAT;
ALTER TABLE pdf_fields ADD COLUMN IF NOT EXISTS box_height FLOAT;
ALTER TABLE pdf_fields ADD COLUMN IF NOT EXISTS auto_font BOOLEAN DEFAULT TRUE;
ALTER TABLE pdf_fields ADD COLUMN IF NOT EXISTS field_options JSONB DEFAULT '[]'::jsonb;
ALTER TABLE pdf_fields ADD COLUMN IF NOT EXISTS validation_rules JSONB DEFAULT '{}'::jsonb;
ALTER TABLE pdf_templates ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;
-- 2026-09-17: per-template spreadsheet auto-create never worked (a bare
-- service account has no Drive storage of its own) - replaced with a
-- shared, human-provisioned spreadsheet (one tab per template, see
-- googleSheetsService.js), so these columns are no longer needed.
ALTER TABLE pdf_templates DROP COLUMN IF EXISTS google_spreadsheet_id;
ALTER TABLE pdf_templates DROP COLUMN IF EXISTS google_spreadsheet_url;
ALTER TABLE pdf_fields ADD COLUMN IF NOT EXISTS template_version INT DEFAULT 1;

CREATE TABLE IF NOT EXISTS generated_pdfs (
    id UUID PRIMARY KEY,
    template_id UUID REFERENCES pdf_templates(id) ON DELETE CASCADE,
    template_version INT DEFAULT 1,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    submitted_data JSONB NOT NULL,
    status VARCHAR(20) CHECK (status IN ('pending', 'done', 'cancelled', 'rescheduled')) DEFAULT 'pending',
    status_note TEXT,
    reschedule_date TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE generated_pdfs ADD COLUMN IF NOT EXISTS template_version INT DEFAULT 1;
ALTER TABLE generated_pdfs ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS status_history (
    id UUID PRIMARY KEY,
    generated_pdf_id UUID REFERENCES generated_pdfs(id) ON DELETE CASCADE,
    old_status VARCHAR(20),
    new_status VARCHAR(20),
    changed_by UUID REFERENCES users(id),
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS field_presets (
    id UUID PRIMARY KEY,
    name VARCHAR(150) UNIQUE NOT NULL,
    field_type VARCHAR(50) DEFAULT 'text',
    field_options JSONB DEFAULT '[]'::jsonb,
    validation_rules JSONB DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS template_predefined_pdfs (
    id UUID PRIMARY KEY,
    template_id UUID REFERENCES pdf_templates(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    file_path TEXT NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pdf_fields_template_id ON pdf_fields(template_id);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_template_id ON generated_pdfs(template_id);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_status ON generated_pdfs(status);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_template_status ON generated_pdfs(template_id, status);
CREATE INDEX IF NOT EXISTS idx_status_history_generated_pdf_id ON status_history(generated_pdf_id);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_created_at ON generated_pdfs(created_at);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_user_id ON generated_pdfs(user_id);
CREATE INDEX IF NOT EXISTS idx_field_presets_created_by ON field_presets(created_by);
CREATE INDEX IF NOT EXISTS idx_template_predefined_pdfs_template_id ON template_predefined_pdfs(template_id);

CREATE TABLE IF NOT EXISTS auto_reply_messages (
    id UUID PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    message_text TEXT NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auto_reply_images (
    id UUID PRIMARY KEY,
    message_id UUID REFERENCES auto_reply_messages(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_images_message_id ON auto_reply_images(message_id);

CREATE TABLE IF NOT EXISTS qr_links (
    id UUID PRIMARY KEY,
    url TEXT NOT NULL,
    label VARCHAR(200),
    is_published BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS template_document_requirements (
    id UUID PRIMARY KEY,
    template_id UUID REFERENCES pdf_templates(id) ON DELETE CASCADE,
    document_name VARCHAR(200) NOT NULL,
    required BOOLEAN DEFAULT TRUE,
    allowed_types VARCHAR(20) DEFAULT 'image_or_pdf' CHECK (allowed_types IN ('image', 'pdf', 'image_or_pdf')),
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS generated_pdf_attachments (
    id UUID PRIMARY KEY,
    generated_pdf_id UUID REFERENCES generated_pdfs(id) ON DELETE CASCADE,
    requirement_id UUID REFERENCES template_document_requirements(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    file_path TEXT NOT NULL,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_template_doc_reqs_template_id ON template_document_requirements(template_id);
CREATE INDEX IF NOT EXISTS idx_generated_pdf_attachments_pdf_id ON generated_pdf_attachments(generated_pdf_id);

CREATE TABLE IF NOT EXISTS tracker_settings (
    id UUID PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    base_url TEXT NOT NULL,
    username TEXT,
    password TEXT,
    enabled BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tracker_settings_enabled ON tracker_settings(enabled);

ALTER TABLE tracker_settings ADD COLUMN IF NOT EXISTS refresh_interval_seconds INT DEFAULT 60;
ALTER TABLE tracker_settings ADD COLUMN IF NOT EXISTS cached_vehicles JSONB;
ALTER TABLE tracker_settings ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP;
ALTER TABLE tracker_settings ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50);
ALTER TABLE tracker_settings ADD COLUMN IF NOT EXISTS sync_error TEXT;
ALTER TABLE tracker_settings ADD COLUMN IF NOT EXISTS api_url TEXT;
ALTER TABLE tracker_settings ADD COLUMN IF NOT EXISTS login_mode VARCHAR(20) DEFAULT 'account';
ALTER TABLE tracker_settings ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Monthly-resetting order number counter (one row per month, month_key YYYYMM).
-- current_value holds the last number issued. A new month inserts a fresh row
-- starting at 1, so the sequence resets automatically when the month rolls over.
-- NOTE keep these comment lines free of the statement separator character
-- because bootstrap.js splits the schema file on that character.
CREATE TABLE IF NOT EXISTS order_number_counters (
    month_key VARCHAR(6) PRIMARY KEY,
    current_value INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Generic key/value settings store (used to remember the auto-created tickets sheet).
CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(120) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- CSR support tickets.
-- status open by default. Closing sets closed_at/closed_by and drops it from the
-- live queue. sheet_tab/sheet_row remember where the row lives in the Google Sheet
-- so a close can update that exact row instead of searching.
CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY,
    ticket_number VARCHAR(30) UNIQUE NOT NULL,
    customer_name VARCHAR(200) NOT NULL,
    customer_address TEXT,
    customer_contact VARCHAR(120),
    concern TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    closed_at TIMESTAMP NULL,
    sheet_tab VARCHAR(20),
    sheet_row INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at);

-- TSR troubleshooting checklist ticked by the CSR. Array of {category, group, item}.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tsr_checklist JSONB DEFAULT '[]'::jsonb;

-- Live-chat messages attached to a ticket.
CREATE TABLE IF NOT EXISTS ticket_messages (
    id UUID PRIMARY KEY,
    ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    author_name VARCHAR(200),
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id ON ticket_messages(ticket_id);

-- Optional image attachment on a chat message.
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS image_path TEXT;
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS image_name TEXT;
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS mime_type TEXT;

-- Monthly-resetting ticket number counter (same pattern as order_number_counters).
CREATE TABLE IF NOT EXISTS ticket_counters (
    month_key VARCHAR(6) PRIMARY KEY,
    current_value INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profiling_folders (
    id UUID PRIMARY KEY,
    parent_id UUID REFERENCES profiling_folders(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    kind VARCHAR(10) NOT NULL DEFAULT 'manual',
    year INTEGER,
    month INTEGER,
    locked BOOLEAN DEFAULT FALSE,
    hidden BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiling_folders_root_name
    ON profiling_folders (lower(name)) WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiling_folders_child_name
    ON profiling_folders (parent_id, lower(name)) WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiling_folders_parent ON profiling_folders(parent_id);

CREATE TABLE IF NOT EXISTS profiling_files (
    id UUID PRIMARY KEY,
    folder_id UUID REFERENCES profiling_folders(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    date_installed DATE,
    file_path TEXT NOT NULL,
    original_name TEXT,
    mime_type VARCHAR(120),
    size_bytes BIGINT,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_profiling_files_folder ON profiling_files(folder_id);

ALTER TABLE profiling_folders ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES pdf_templates(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_profiling_folders_template ON profiling_folders(template_id);

ALTER TABLE generated_pdfs ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN DEFAULT FALSE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0;

-- Field Engineering (FE) job monitor. Additive only: nothing here alters or
-- drops existing data. Seeds run once, only while their table is empty, so
-- names the FE team renames or retires are never re-added on reboot.

ALTER TABLE generated_pdfs ADD COLUMN IF NOT EXISTS order_number VARCHAR(40);

CREATE TABLE IF NOT EXISTS fe_teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    legacy BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fe_teams_name ON fe_teams (lower(name));

CREATE TABLE IF NOT EXISTS fe_team_members (
    id SERIAL PRIMARY KEY,
    team_id INT NOT NULL REFERENCES fe_teams(id),
    name VARCHAR(120) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fe_team_members_team ON fe_team_members(team_id);

INSERT INTO fe_teams (name)
SELECT t.name FROM (VALUES ('Team Main'), ('Team Julugan'), ('Team Kawit'), ('Team Trece')) AS t(name)
WHERE NOT EXISTS (SELECT 1 FROM fe_teams);

CREATE TABLE IF NOT EXISTS fe_options (
    id SERIAL PRIMARY KEY,
    kind VARCHAR(30) NOT NULL,
    value VARCHAR(120) NOT NULL,
    sort INT NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (kind, value)
);

INSERT INTO fe_options (kind, value, sort)
SELECT v.kind, v.value, v.sort FROM (VALUES
    ('area', 'TANZA', 1), ('area', 'KAWIT', 2), ('area', 'TRECE', 3), ('area', 'NAIC', 4),
    ('install_status', 'Pending', 1), ('install_status', 'Installed', 2), ('install_status', 'Reschedule', 3),
    ('install_status', 'Not Installed', 4), ('install_status', 'Cancelled', 5), ('install_status', 'Reassigned', 6),
    ('repair_status', 'Pending', 1), ('repair_status', 'Repaired', 2), ('repair_status', 'Reschedule', 3),
    ('repair_status', 'Unresolved', 4), ('repair_status', 'Escalated', 5), ('repair_status', 'Reassigned', 6),
    ('pullout_status', 'Pending', 1), ('pullout_status', 'Nakuha ang Modem', 2), ('pullout_status', 'Hindi Nakuha ang Modem', 3),
    ('install_reason', 'Customer Not Around', 1), ('install_reason', 'Customer Cancelled', 2), ('install_reason', 'No Available Port', 3),
    ('install_reason', 'No Facility', 4), ('install_reason', 'No Signal', 5), ('install_reason', 'No Access', 6),
    ('install_reason', 'Wrong Address', 7), ('install_reason', 'Weather', 8), ('install_reason', 'Emergency Splicing', 9),
    ('install_reason', 'Called to Repair', 10), ('install_reason', 'Called to OSP', 11), ('install_reason', 'PMO Project', 12),
    ('install_reason', 'Relocate to Partners', 13), ('install_reason', 'Customer Request Reschedule', 14), ('install_reason', 'Others', 15),
    ('repair_reason', 'Customer Not Around', 1), ('repair_reason', 'No Access', 2), ('repair_reason', 'Waiting for OSP', 3),
    ('repair_reason', 'Waiting for Splicing', 4), ('repair_reason', 'Waiting for Materials', 5), ('repair_reason', 'No Power', 6),
    ('repair_reason', 'Emergency Assignment', 7), ('repair_reason', 'Others', 8),
    ('pullout_reason', 'Walang tao', 1), ('pullout_reason', 'Customer not around', 2), ('pullout_reason', 'Nagbayad na', 3),
    ('pullout_reason', 'Walang nakatira', 4), ('pullout_reason', 'Others', 5),
    ('problem', 'LOS Red', 1), ('problem', 'LOS Blinking', 2), ('problem', 'No Internet', 3), ('problem', 'Busted Modem', 4),
    ('problem', 'Busted Adaptor', 5), ('problem', 'High Reading', 6), ('problem', 'Fiber Cut', 7), ('problem', 'Broken Drop Core', 8),
    ('problem', 'Damaged ONU', 9), ('problem', 'Loose SC Connector', 10), ('problem', 'No Power', 11), ('problem', 'Slow Connection', 12),
    ('problem', 'Packet Loss', 13), ('problem', 'ONU Reconfiguration', 14), ('problem', 'WiFi Issue', 15), ('problem', 'No 2.4G & 5G WIFI', 16),
    ('problem', 'Router Issue', 17), ('problem', 'Relocation Modem', 18), ('problem', 'Relocation House', 19), ('problem', 'Fiber Relocation', 20),
    ('problem', 'Open Nap Box', 21), ('problem', 'Activation', 22), ('problem', 'No Access', 23), ('problem', 'Customer Cancelled', 24),
    ('problem', 'Others', 25)
) AS v(kind, value, sort)
WHERE NOT EXISTS (SELECT 1 FROM fe_options);

CREATE TABLE IF NOT EXISTS fe_jobs (
    id UUID PRIMARY KEY,
    generated_pdf_id UUID UNIQUE REFERENCES generated_pdfs(id) ON DELETE SET NULL,
    job_type VARCHAR(10) NOT NULL CHECK (job_type IN ('INSTALL', 'REPAIR', 'PULLOUT', 'RELOC')),
    reloc_kind VARCHAR(10) CHECK (reloc_kind IN ('install', 'repair')),
    history_only BOOLEAN NOT NULL DEFAULT FALSE,
    template_title TEXT,
    order_number VARCHAR(60),
    customer_name TEXT,
    customer_address TEXT,
    customer_contact TEXT,
    account_number TEXT,
    plan TEXT,
    jo_reason TEXT,
    jo_date DATE,
    team_id INT REFERENCES fe_teams(id),
    area VARCHAR(60),
    status VARCHAR(40) NOT NULL DEFAULT 'Pending',
    reason VARCHAR(120),
    closed_at TIMESTAMP,
    source VARCHAR(10) NOT NULL DEFAULT 'app',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fe_jobs_status ON fe_jobs(status);
CREATE INDEX IF NOT EXISTS idx_fe_jobs_team ON fe_jobs(team_id);
CREATE INDEX IF NOT EXISTS idx_fe_jobs_jo_date ON fe_jobs(jo_date);

CREATE TABLE IF NOT EXISTS fe_visits (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES fe_jobs(id),
    visit_date DATE,
    team_id INT REFERENCES fe_teams(id),
    status VARCHAR(40) NOT NULL,
    reason VARCHAR(120),
    problem VARCHAR(120),
    difficulty VARCHAR(10),
    start_time TIME,
    end_time TIME,
    drop_core_m NUMERIC(8, 2),
    f_clamp INT,
    house_clamp INT,
    sc_connector INT,
    onu INT,
    modem_serial VARCHAR(80),
    remarks TEXT,
    source VARCHAR(10) NOT NULL DEFAULT 'app',
    source_ref VARCHAR(40),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fe_visits_job ON fe_visits(job_id);
CREATE INDEX IF NOT EXISTS idx_fe_visits_date ON fe_visits(visit_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fe_visits_source_ref ON fe_visits(source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS fe_audit (
    id BIGSERIAL PRIMARY KEY,
    entity VARCHAR(10) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    job_id UUID,
    action VARCHAR(40) NOT NULL,
    detail JSONB DEFAULT '{}'::jsonb,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    user_name VARCHAR(150),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fe_audit_job ON fe_audit(job_id);

-- Each team works an area and the Teams page groups by it. Seeded once, while
-- no team has an area yet: the four current teams by name, and the old Excel
-- teams by the area most of their visits were in.
ALTER TABLE fe_teams ADD COLUMN IF NOT EXISTS area VARCHAR(120);

UPDATE fe_teams t SET area = s.area
FROM (
    SELECT id, CASE lower(name) WHEN 'team kawit' THEN 'KAWIT' WHEN 'team trece' THEN 'TRECE'
                                WHEN 'team main' THEN 'TANZA' WHEN 'team julugan' THEN 'TANZA' END AS area
      FROM fe_teams WHERE NOT legacy
    UNION ALL
    SELECT * FROM (
        SELECT DISTINCT ON (v.team_id) v.team_id AS id, j.area
          FROM fe_visits v
          JOIN fe_jobs j ON j.id = v.job_id
          JOIN fe_teams lt ON lt.id = v.team_id AND lt.legacy
         WHERE j.area IS NOT NULL
         GROUP BY v.team_id, j.area
         ORDER BY v.team_id, COUNT(*) DESC, j.area
    ) crews
) s
WHERE s.id = t.id AND s.area IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM fe_teams WHERE area IS NOT NULL);

-- End-of-day materials per team, typed from the team's report card. One card
-- per team per day; the materials reports read only these (fresh start: the
-- per-visit materials from the old Excel stay on the visits but are not summed).
CREATE TABLE IF NOT EXISTS fe_team_materials (
    id SERIAL PRIMARY KEY,
    team_id INT NOT NULL REFERENCES fe_teams(id),
    work_date DATE NOT NULL,
    drop_core_m NUMERIC(10,2) NOT NULL DEFAULT 0,
    f_clamp INT NOT NULL DEFAULT 0,
    house_clamp INT NOT NULL DEFAULT 0,
    sc_connector INT NOT NULL DEFAULT 0,
    onu INT NOT NULL DEFAULT 0,
    remarks TEXT,
    created_by UUID,
    updated_by UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (team_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_fe_team_materials_date ON fe_team_materials(work_date);

-- Board fresh start: open / unassigned / 3+ days old count only jobs generated
-- after board_start (UTC, like every timestamp here). Set once, the first time
-- this runs; older open jobs stay reachable under "Old backlog".
CREATE TABLE IF NOT EXISTS fe_settings (
    key VARCHAR(60) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO fe_settings (key, value)
VALUES ('board_start', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'))
ON CONFLICT (key) DO NOTHING;

-- Set when the FE job was closed because its JO was cancelled in the workflow,
-- so un-cancelling the JO can reopen it (FE never writes the JO's own status).
ALTER TABLE fe_jobs ADD COLUMN IF NOT EXISTS jo_cancelled BOOLEAN NOT NULL DEFAULT FALSE;

-- Quick Cancel / Reschedule from the board: a reschedule carries its new date,
-- and every job type can now be cancelled or rescheduled. Added once; a value
-- someone retired later stays retired.
ALTER TABLE fe_visits ADD COLUMN IF NOT EXISTS reschedule_date DATE;

INSERT INTO fe_options (kind, value, sort)
SELECT v.kind, v.value, (SELECT COALESCE(MAX(sort), 0) + 1 FROM fe_options o WHERE o.kind = v.kind)
  FROM (VALUES ('repair_status', 'Cancelled'), ('pullout_status', 'Cancelled'), ('pullout_status', 'Reschedule')) AS v(kind, value)
 WHERE EXISTS (SELECT 1 FROM fe_options)
ON CONFLICT (kind, value) DO NOTHING;

-- Today tab fresh start: it counts only visits and report cards entered after
-- today_start (UTC). Set once, the first time this runs.
INSERT INTO fe_settings (key, value)
VALUES ('today_start', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'))
ON CONFLICT (key) DO NOTHING;

-- JO status sync: the JO's state before a Field Eng visit changed it, so
-- removing that visit (Undo) can put the JO back.
ALTER TABLE fe_visits ADD COLUMN IF NOT EXISTS jo_prev JSONB;
