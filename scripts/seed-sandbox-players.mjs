import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://usxftpexoimletqmrggb.supabase.co";
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzeGZ0cGV4b2ltbGV0cW1yZ2diIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTgwMDQ5NywiZXhwIjoyMDkxMzc2NDk3fQ.ZAyG17CyItcIRG1AEhGIzDoAoiVFOzYsZ3Vl_afMfvo";
const SESSION_ID = "6903896c-7cb1-466b-94a1-4009d07f88d8";

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PLAYERS = [
  // beginner (6)
  { name: "Marco Reyes",         skill: "beginner" },
  { name: "Pia Santos",          skill: "beginner" },
  { name: "Kuya Jun",            skill: "beginner" },
  { name: "Ate Nena",            skill: "beginner" },
  { name: "Dodong Cruz",         skill: "beginner" },
  { name: "Lanie Flores",        skill: "beginner" },
  // lower_intermediate (8)
  { name: "Rodel Garcia",        skill: "lower_intermediate" },
  { name: "Cherry Lim",          skill: "lower_intermediate" },
  { name: "Bong Villanueva",     skill: "lower_intermediate" },
  { name: "Marites Tan",         skill: "lower_intermediate" },
  { name: "JR Castillo",         skill: "lower_intermediate" },
  { name: "Peachy Dizon",        skill: "lower_intermediate" },
  { name: "Nestor Aquino",       skill: "lower_intermediate" },
  { name: "Tina Corpuz",         skill: "lower_intermediate" },
  // intermediate (10)
  { name: "Carlo Mendoza",       skill: "intermediate" },
  { name: "Jackie Bautista",     skill: "intermediate" },
  { name: "Paolo Ramos",         skill: "intermediate" },
  { name: "Gina dela Cruz",      skill: "intermediate" },
  { name: "Rex Abad",            skill: "intermediate" },
  { name: "Melissa Torres",      skill: "intermediate" },
  { name: "Ronnie Pascual",      skill: "intermediate" },
  { name: "Cathy Navarro",       skill: "intermediate" },
  { name: "Dennis Guerrero",     skill: "intermediate" },
  { name: "Aileen Santiago",     skill: "intermediate" },
  // upper_intermediate (8)
  { name: "Alex Vega",           skill: "upper_intermediate" },
  { name: "Rica Morales",        skill: "upper_intermediate" },
  { name: "Vincent Ong",         skill: "upper_intermediate" },
  { name: "Joanna Aguilar",      skill: "upper_intermediate" },
  { name: "Manny Soriano",       skill: "upper_intermediate" },
  { name: "Beth Valdez",         skill: "upper_intermediate" },
  { name: "Aaron Chua",          skill: "upper_intermediate" },
  { name: "Lyra Espiritu",       skill: "upper_intermediate" },
  // lower_advanced (5)
  { name: "Jared Padilla",       skill: "lower_advanced" },
  { name: "Kristine Lao",        skill: "lower_advanced" },
  { name: "Ramon Sy",            skill: "lower_advanced" },
  { name: "Tricia Evangelista",  skill: "lower_advanced" },
  { name: "Erwin Buenaventura",  skill: "lower_advanced" },
  // advanced (3)
  { name: "Miguel Sicat",        skill: "advanced" },
  { name: "Dana Yap",            skill: "advanced" },
  { name: "Leo Fajardo",         skill: "advanced" },
];

const ts = Date.now();
let created = 0;
let failed = 0;

for (let i = 0; i < PLAYERS.length; i++) {
  const { name, skill } = PLAYERS[i];
  const email = `sandbox-player-${ts}-${i}@e2e.local`;
  const pin = String(1000 + i).padStart(4, "0");

  // 1. Create auth user
  const { data: authData, error: authErr } = await db.auth.admin.createUser({
    email,
    password: "E2E_Player_2024!",
    email_confirm: true,
    user_metadata: { display_name: name },
  });

  if (authErr || !authData.user) {
    console.error(`  ✗ [${i + 1}/40] ${name} — auth: ${authErr?.message}`);
    failed++;
    continue;
  }

  const uid = authData.user.id;

  // 2. Upsert profile
  const { error: profErr } = await db
    .from("profiles")
    .upsert({ id: uid, display_name: name, skill_level: skill, pin }, { onConflict: "id" });

  if (profErr) {
    console.error(`  ✗ [${i + 1}/40] ${name} — profile: ${profErr.message}`);
    failed++;
    continue;
  }

  // 3. Insert queue entry
  const { error: qErr } = await db.from("queue_entries").insert({
    session_id: SESSION_ID,
    player_id: uid,
    status: "waiting",
    games_played: 0,
    joined_at: new Date().toISOString(),
  });

  if (qErr) {
    console.error(`  ✗ [${i + 1}/40] ${name} — queue: ${qErr.message}`);
    failed++;
    continue;
  }

  const label = `[${String(i + 1).padStart(2)}/${PLAYERS.length}]`;
  console.log(`  ✓ ${label} ${name.padEnd(24)} (${skill})`);
  created++;
}

console.log();
console.log(`Done: ${created} created, ${failed} failed.`);

const { count } = await db
  .from("queue_entries")
  .select("*", { count: "exact", head: true })
  .eq("session_id", SESSION_ID);
console.log(`Total queue entries in sandbox: ${count}`);
