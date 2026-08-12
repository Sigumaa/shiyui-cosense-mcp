import { createRemoteJWKSet, jwtVerify } from "jose";

import type { Env } from "./env";

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getIssuer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".cloudflareaccess.com") ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("TEAM_DOMAIN is invalid");
  }
  return url.origin;
}

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", `${issuer}/`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

export async function verifyAccessRequest(
  request: Request,
  env: Env,
): Promise<void> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  const audience = env.POLICY_AUD.trim();
  if (!assertion || !audience) {
    throw new Error("Access assertion is missing");
  }

  const issuer = getIssuer(env.TEAM_DOMAIN);
  await jwtVerify(assertion, getJwks(issuer), {
    algorithms: ["RS256"],
    issuer,
    audience,
    requiredClaims: ["exp"],
  });
}
