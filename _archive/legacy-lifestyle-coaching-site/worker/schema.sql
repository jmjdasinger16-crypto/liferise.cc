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

/* ── Client portal (unlocked after a trial signup via Stripe) ── */

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  name TEXT,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'trial' CHECK(status IN ('trial','active','past_due','canceled')),
  trial_ends_at TEXT,
  activation_nonce TEXT,
  activation_nonce_expires TEXT,
  source_lead_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS client_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  author TEXT NOT NULL DEFAULT 'coach',
  content TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'client' CHECK(visibility IN ('client','internal')),
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS client_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS call_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  reason TEXT,
  preferred_time TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','scheduled','completed','canceled')),
  scheduled_at TEXT,
  coach_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS portal_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer ON clients(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_clients_activation_nonce ON clients(activation_nonce);
CREATE INDEX IF NOT EXISTS idx_client_notes_client ON client_notes(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_goals_client ON client_goals(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_requests_client ON call_requests(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_requests_status ON call_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_chat_client ON portal_chat_messages(client_id, created_at);
