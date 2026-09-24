// CLI auth-profile resolution helpers, split out of prepare.ts to keep that
// grandfathered file within its line cap. Decides whether a CLI backend run must
// resolve a materialized auth profile, and builds the re-authentication error when a
// selected profile cannot be resolved.
import { buildOAuthRefreshFailureLoginCommand } from "../auth-profiles/oauth-refresh-failure.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { CliAuthProfilePreparationError } from "./auth-profile-preparation-error.js";
import type { BundledCliBackendAuthPolicy } from "./cli-backend-auth-policy.js";

export function shouldResolveAuthProfileForExecution(params: {
  policy?: BundledCliBackendAuthPolicy;
  authCredential?: AuthProfileCredential;
}): boolean {
  if (!params.policy) {
    return false;
  }
  if (!params.authCredential) {
    return params.policy.strictSelectedProfile;
  }
  if (params.authCredential.type === "oauth") {
    return params.policy.oauthRefreshOwner === "core";
  }
  return params.authCredential.type === "api_key" || params.authCredential.type === "token";
}

type CliAuthProfileResolutionFailure =
  | { kind: "unmaterialized" }
  | { kind: "resolved-as-other"; resolvedProfileId: string };

function describeCliAuthProfileResolutionFailure(
  profileId: string,
  failure: CliAuthProfileResolutionFailure,
): string {
  switch (failure.kind) {
    case "resolved-as-other":
      return `selected auth profile "${profileId}" resolved as "${failure.resolvedProfileId}"`;
    case "unmaterialized":
      return `could not materialize selected auth profile "${profileId}"`;
  }
  return failure satisfies never;
}

export function buildCliAuthProfileResolutionError(params: {
  backendId: string;
  profileId: string;
  provider: string;
  agentDir: string;
  failure: CliAuthProfileResolutionFailure;
}): CliAuthProfilePreparationError {
  const loginCommand = buildOAuthRefreshFailureLoginCommand(params.provider, {
    profileId: params.profileId,
  });
  const reason = describeCliAuthProfileResolutionFailure(params.profileId, params.failure);
  return new CliAuthProfilePreparationError({
    message: `CLI backend "${params.backendId}" ${reason}. Re-authenticate with: ${loginCommand}. OpenClaw did not start the run.`,
    profileId: params.profileId,
    provider: params.provider,
    agentDir: params.agentDir,
  });
}
