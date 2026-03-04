CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    last_active_at TIMESTAMP,
    role VARCHAR(20) CHECK (role IN ('super_admin', 'admin', 'user')) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;

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

CREATE INDEX IF NOT EXISTS idx_pdf_fields_template_id ON pdf_fields(template_id);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_template_id ON generated_pdfs(template_id);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_status ON generated_pdfs(status);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_template_status ON generated_pdfs(template_id, status);
CREATE INDEX IF NOT EXISTS idx_status_history_generated_pdf_id ON status_history(generated_pdf_id);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_created_at ON generated_pdfs(created_at);
CREATE INDEX IF NOT EXISTS idx_generated_pdfs_user_id ON generated_pdfs(user_id);
CREATE INDEX IF NOT EXISTS idx_field_presets_created_by ON field_presets(created_by);
