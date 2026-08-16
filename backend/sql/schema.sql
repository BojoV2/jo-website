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

CREATE TABLE IF NOT EXISTS pdf_templates (
    id UUID PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    file_path TEXT NOT NULL,
    google_spreadsheet_id TEXT,
    google_spreadsheet_url TEXT,
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
ALTER TABLE pdf_templates ADD COLUMN IF NOT EXISTS google_spreadsheet_id TEXT;
ALTER TABLE pdf_templates ADD COLUMN IF NOT EXISTS google_spreadsheet_url TEXT;
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
