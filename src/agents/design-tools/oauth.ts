/** Authorization code is returned only after redirect origin, issuer and CSRF state checks. */
export function parseFigmaRedirect(value: string, state: string): string {
  const redirect = new URL(value);
  const code = redirect.searchParams.get("code");
  if (
    redirect.origin !== "http://localhost:1457" ||
    redirect.pathname !== "/callback" ||
    redirect.searchParams.get("state") !== state ||
    !code ||
    (redirect.searchParams.has("iss") &&
      redirect.searchParams.get("iss") !== "https://api.figma.com")
  )
    throw new Error("OAuth redirect/state mismatch");
  return code;
}
