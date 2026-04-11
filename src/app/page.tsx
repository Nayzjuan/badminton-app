// ============================================================
// Home Page — Player Login / Profile Setup
// ============================================================
// If already authenticated, redirects to /play.
// Otherwise shows the name + skill level entry form.
// ============================================================

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { LoginForm } from "@/components/login-form";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Already logged in — go straight to session picker.
  if (user) {
    redirect("/play");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-8 text-center">
        {/* Branding */}
        <div className="space-y-2">
          <div className="mx-auto h-16 w-16 rounded-2xl bg-primary flex items-center justify-center">
            <span className="text-2xl">&#127992;</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Badminton Queue
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter your name and skill level to get started.
          </p>
        </div>

        {/* Login Form */}
        <LoginForm />
      </div>
    </main>
  );
}
