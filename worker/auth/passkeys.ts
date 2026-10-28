import { getAuthenticatorName, passkey } from "@better-auth/passkey";
import { APIError } from "better-auth/api";
import type { Identity } from "./security";

/** One WebAuthn ceremony: the trusted page origin it binds to and the signed-in owner, if any. */
export interface Ceremony { origin: string; owner: Identity | null }

/** Signed out, a verified ceremony creates the user; signed in, it adds a passkey to the owner. */
export function passkeys({ origin, owner }: Ceremony) {
  const refuse = () => { throw new APIError("FORBIDDEN", { message: "Invalid passkey registration" }); };
  return passkey({
    rpID: new URL(origin).hostname, rpName: "BazaarGhost", origin,
    schema: { passkey: { modelName: "user_passkeys" } },
    registration: {
      requireSession: false,
      resolveUser: async ({ context }) => {
        if (owner) return { id: owner.userId, name: owner.name, displayName: owner.name };
        if (!context) return refuse();
        // Provisional only: the user row is created after the attestation verifies.
        return { id: crypto.randomUUID(), name: context, displayName: context };
      },
      afterVerification: async ({ ctx, user, context, verification }) => {
        const name = getAuthenticatorName(verification.registrationInfo?.aaguid);
        if (owner) { if (user.id !== owner.userId || context) refuse(); return { name }; }
        if (!context) return refuse();
        const created = await ctx.context.internalAdapter.createUser({
          name: context, email: `${user.id}@passkey.bazaarghost.invalid`, emailVerified: false }, { method: "passkey" });
        return { userId: created.id, name };
      },
    },
  });
}
