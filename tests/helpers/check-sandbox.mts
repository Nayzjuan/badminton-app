import "dotenv/config";
import * as dotenv from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: resolve(process.cwd(), ".env.test") });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const sessionId = process.env.TEST_SESSION_ID!;

const [{ data: session }, { count: matches }, { count: queue }, { count: courts }] =
  await Promise.all([
    db.from("sessions").select("name, is_active").eq("id", sessionId).single(),
    db.from("matches").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
    db
      .from("queue_entries")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId),
    db.from("courts").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
  ]);

console.log(`Session : ${session?.name} | active: ${session?.is_active}`);
console.log(`Matches : ${matches} | Queue entries: ${queue} | Courts: ${courts}`);
