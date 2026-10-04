"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import { FieldError, FormMessage, previous } from "@/components/FormStatus";
import type { KycLaunch } from "@/lib/types";
import type { ActionState } from "@/server/actionState";

import type { KycStart } from "./actions";
import { markKycSubmittedAction, startKycAction } from "./actions";

interface SmileIdentityOptions {
  readonly token: string;
  readonly product: string;
  readonly callback_url: string;
  readonly environment: "sandbox" | "live";
  readonly partner_details: { readonly partner_id: string; readonly name: string; readonly policy_url: string; readonly theme_color: string };
  readonly onSuccess: () => void;
  readonly onClose: () => void;
  readonly onError: (error: unknown) => void;
}

declare global {
  interface Window {
    SmileIdentity?: (options: SmileIdentityOptions) => void;
  }
}

const SMILE_SCRIPT = "https://cdn.smileidentity.com/inline/v1/js/script.min.js";

function loadSmileScript(): Promise<void> {
  if (window.SmileIdentity !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SMILE_SCRIPT;
    script.async = true;
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      reject(new Error("script Smile ID indisponible"));
    };
    document.head.appendChild(script);
  });
}

/** Lance la capture chez le prestataire, puis signale la fin de capture à l'API. */
function CaptureSession({ verificationId, launch, onDone }: { readonly verificationId: string; readonly launch: KycLaunch; readonly onDone: (message: string) => void }): React.ReactNode {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let tearDown: (() => Promise<void>) | null = null;
    let cancelled = false;
    const finish = (): void => {
      void markKycSubmittedAction(verificationId).then((result) => {
        onDone(result.status === "error" ? result.message : "Documents transmis : la vérification est en cours.");
      });
    };

    if (launch.provider === "onfido") {
      import("onfido-sdk-ui")
        .then(({ Onfido }) => {
          if (cancelled || container.current === null) return;
          const handle = Onfido.init({
            token: launch.sdkToken,
            workflowRunId: launch.workflowRunId,
            containerEl: container.current,
            language: "fr_FR",
            onComplete: finish,
            onError: () => {
              setError("La capture a échoué. Rechargez la page pour réessayer.");
            },
          });
          tearDown = () => handle.tearDown();
        })
        .catch(() => {
          setError("Le module de vérification n'a pas pu être chargé.");
        });
    } else {
      const webToken = launch.webToken;
      if (webToken === null) return;
      loadSmileScript()
        .then(() => {
          if (cancelled || window.SmileIdentity === undefined) return;
          window.SmileIdentity({
            token: webToken,
            product: launch.product,
            callback_url: launch.callbackUrl,
            environment: launch.environment === "production" ? "live" : "sandbox",
            partner_details: { partner_id: launch.partnerId, name: "TransfertPlus", policy_url: `${window.location.origin}/confidentialite`, theme_color: "#0b6e4f" },
            onSuccess: finish,
            onClose: () => {
              onDone("Vérification interrompue : vous pourrez la reprendre plus tard.");
            },
            onError: () => {
              setError("La capture a échoué. Rechargez la page pour réessayer.");
            },
          });
        })
        .catch(() => {
          setError("Le module de vérification n'a pas pu être chargé.");
        });
    }
    return () => {
      cancelled = true;
      if (tearDown !== null) void tearDown();
    };
  }, [launch, verificationId, onDone]);

  const unavailable = launch.provider === "smile_id" && launch.webToken === null ? "Vérification web indisponible pour ce pays : utilisez l'application mobile." : null;
  const shown = unavailable ?? error;
  return (
    <div className="stack">
      {shown !== null && (
        <p className="alert error" role="alert">
          {shown}
        </p>
      )}
      <div ref={container} style={{ minHeight: 480 }} />
    </div>
  );
}

export function KycLauncher(props: { readonly nextTier: "tier_1" | "tier_2"; readonly needsIdentity: boolean }): React.ReactNode {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState<KycStart>, FormData>(startKycAction, { status: "idle" });
  const [done, setDone] = useState<string | null>(null);
  const fields = state.status === "error" ? state.fields : undefined;

  if (done !== null) {
    return (
      <div className="stack">
        <p className="alert success" role="status">
          {done}
        </p>
        <button type="button" onClick={() => router.refresh()}>
          Actualiser
        </button>
      </div>
    );
  }
  if (state.status === "success") {
    return <CaptureSession verificationId={state.data.verification.id} launch={state.data.launch} onDone={setDone} />;
  }
  return (
    <form action={action} className="stack" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="tier" value={props.nextTier} />
      {props.needsIdentity && (
        <>
          <p className="muted">Indiquez votre identité exactement comme sur votre pièce d&apos;identité. Elle ne pourra plus être modifiée ensuite.</p>
          <div className="grid">
            <label>
              Prénom(s)
              <input name="firstName" defaultValue={previous(state, "firstName")} autoComplete="given-name" required aria-invalid={fields?.["firstName"] !== undefined} />
              <FieldError fields={fields} name="firstName" />
            </label>
            <label>
              Nom
              <input name="lastName" defaultValue={previous(state, "lastName")} autoComplete="family-name" required aria-invalid={fields?.["lastName"] !== undefined} />
              <FieldError fields={fields} name="lastName" />
            </label>
            <label>
              Date de naissance
              <input name="dateOfBirth" defaultValue={previous(state, "dateOfBirth")} type="date" autoComplete="bday" required aria-invalid={fields?.["dateOfBirth"] !== undefined} />
              <FieldError fields={fields} name="dateOfBirth" />
            </label>
          </div>
        </>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Préparation…" : "Commencer la vérification"}
      </button>
    </form>
  );
}
