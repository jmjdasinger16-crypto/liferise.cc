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
  next_follow_up_at TEXT,
  submitted_at TEXT NOT NULL,
  contacted_at TEXT,
  updated_at TEXT,
  ip_address TEXT,
  user_agent TEXT,
  lead_source TEXT DEFAULT 'contact_form',
  preferred_contact TEXT,
  best_contact_time TEXT,
  chat_summary TEXT,
  sms_consent INTEGER DEFAULT 0,
  conversation_id TEXT
);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'collecting',
  name TEXT,
  email TEXT,
  phone TEXT,
  area TEXT,
  concern TEXT,
  preferred_contact TEXT,
  best_contact_time TEXT,
  sms_consent INTEGER DEFAULT 0,
  lead_id INTEGER,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT NOT NULL,
  page_path TEXT,
  session_id TEXT,
  lead_id INTEGER,
  conversation_id TEXT,
  metadata TEXT,
  occurred_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_coaching_leads_status ON coaching_leads(status);
CREATE INDEX IF NOT EXISTS idx_coaching_leads_submitted_at ON coaching_leads(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_leads_email ON coaching_leads(email);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_events_name_time ON site_events(event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_events_session ON site_events(session_id, occurred_at DESC);
