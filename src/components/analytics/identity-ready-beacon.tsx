"use client";

import { useEffect } from "react";
import {
  trackRegistration,
  type RegistrationEntry,
  type RegistrationOutcome,
} from "@/lib/registration-analytics";

/** Fires identity_ready once after a server page has loaded an authenticated profile. */
export function IdentityReadyBeacon({
  entry,
  completeOutcome,
}: {
  entry?: RegistrationEntry;
  completeOutcome?: RegistrationOutcome;
}) {
  useEffect(() => {
    trackRegistration({ step: "identity_ready", entry });
    if (completeOutcome) {
      trackRegistration({ step: "completed", entry, outcome: completeOutcome });
    }
  }, [entry, completeOutcome]);
  return null;
}
