CREATE TABLE IF NOT EXISTS coaching_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  area TEXT,
  message TEXT,
  comfort TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_representative TEXT,
  representative_notes TEXT,
  submitted_at TEXT NOT NULL,
  contacted_at TEXT,
  updated_at TEXT,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_coaching_leads_status
  ON coaching_leads(status);

CREATE INDEX IF NOT EXISTS idx_coaching_leads_submitted_at
  ON coaching_leads(submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_coaching_leads_email
  ON coaching_leads(email);
