// js/supabaseClient.js
const SUPABASE_URL = "https://jfnemfpehenjvamfykkx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpmbmVtZnBlaGVuanZhbWZ5a2t4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2NjM2OTIsImV4cCI6MjA4MDIzOTY5Mn0.Tn17KgeiJNqAkJUi8hieQPNdJuOaT_b6KdVyADe_17Q";

window.supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);
