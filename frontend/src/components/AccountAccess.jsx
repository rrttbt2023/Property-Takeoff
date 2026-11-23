import { useEffect, useRef, useState } from "react";

import {
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from "../api";

import "./account-access.css";
import PublicDialog from "./PublicDialog";
import SiteComparison from "./SiteComparison";
import { readStartIntent, setStartIntent } from "./startIntent";

const compactAccess = "(max-width: 759px), (max-height: 540px) and (orientation: landscape)";

function AccountAccess({
  checking,
  loginUsername,
  onLoginUsernameChange,
  loginPassword,
  onLoginPasswordChange,
  loginSubmitting,
  onLogin,
  registerSubmitting,
  onRegister,
}) {
  const [intent, setIntent] = useState(readStartIntent);
  const [mode, setMode] = useState(() => intent ? "register" : "login");
  const [compact, setCompact] = useState(() => window.matchMedia(compactAccess).matches);
  const [authOpen, setAuthOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(compactAccess);
    const refresh = () => setCompact(query.matches);
    query.addEventListener("change", refresh);
    return () => query.removeEventListener("change", refresh);
  }, []);
  const start = (choice) => {
    setStartIntent(choice);
    setIntent(choice);
    setAccountMessage("");
    setMode("register");
  };
  const closeSignup = () => {
    setAuthOpen(false);
    setStartIntent("");
    setIntent("");
    setAccountMessage("");
    setMode("login");
    setRegistration(previous => ({ ...previous, password: "", botToken: "", acceptedTerms: false }));
  };
  const submitAuth = async (event, handler, values) => {
    event.preventDefault();
    setAccountMessage("");
    const result = await handler(event, values);
    if (result?.error) setAccountMessage(result.error);
  };
  const [mfaCode, setMfaCode] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const [accountWorking, setAccountWorking] = useState(false);
  const turnstileRef = useRef(null);
  const [registration, setRegistration] = useState({
    displayName: "",
    organizationName: "",
    email: "",
    password: "",
    botToken: "",
    acceptedTerms: false,
  });

  const turnstileSiteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY || "").trim();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verificationToken = String(params.get("verify") || "").trim();
    const resetToken = String(params.get("reset") || "").trim();
    if (resetToken || verificationToken) setAuthOpen(true);
    if (resetToken) setMode("reset");
    if (!verificationToken) return;
    setAccountWorking(true);
    verifyEmail(verificationToken)
      .then(() => {
        setAccountMessage("Email verified. You can sign in now.");
        setMode("login");
        window.history.replaceState({}, "", window.location.pathname);
      })
      .catch((error) => setAccountMessage(error?.message || "Verification failed."))
      .finally(() => setAccountWorking(false));
  }, []);

  useEffect(() => {
    if (!turnstileSiteKey || mode !== "register" || !turnstileRef.current) return undefined;
    const container = turnstileRef.current;
    let widgetId;
    updateRegistration("botToken", "");
    const render = () => {
      if (!window.turnstile || !container.isConnected || widgetId != null) return;
      widgetId = window.turnstile.render(container, {
        sitekey: turnstileSiteKey,
        callback: (token) => updateRegistration("botToken", token),
        "expired-callback": () => updateRegistration("botToken", ""),
      });
    };
    const existing = document.querySelector('script[data-property-takeoff-turnstile="1"]');
    const script = existing || document.createElement("script");
    script.addEventListener("load", render);
    if (existing) render();
    else {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.propertyTakeoffTurnstile = "1";
      document.head.appendChild(script);
    }
    return () => {
      script.removeEventListener("load", render);
      if (widgetId != null) window.turnstile?.remove(widgetId);
    };
  }, [mode, intent, checking, turnstileSiteKey, compact, authOpen]);

  const updateRegistration = (key, value) => {
    setRegistration((previous) => ({ ...previous, [key]: value }));
  };

  if (checking) {
    return (
      <main className="account-access account-access-loading">
        <div className="account-access-mark"><img src="/logo.png" alt="" /><span /></div>
        <strong>Opening your workspace...</strong>
      </main>
    );
  }

  const accountPanel = (
      <section className="account-access-panel">
        {intent && <div className="signup-path"><span>{intent === "measure" ? "1. Account / 2. Secure checkout / 3. Measure" : "1. Free account / 2. Submit your site"}</span></div>}
        <div className="account-access-tabs" role="tablist">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create account</button>
        </div>

        {accountMessage ? <div className="account-access-message" role="status">{accountMessage}</div> : null}

        {mode === "login" ? (
          <form className="account-access-form" onSubmit={(event) => submitAuth(event, onLogin, { mfaCode })}>
            <div><span>Welcome back</span><h2>Open your project workspace.</h2><p>Your projects, folders, billing, and measurement requests stay together.</p></div>
            <label>Email or username<input value={loginUsername} onChange={(event) => onLoginUsernameChange(event.target.value)} autoComplete="username" placeholder="you@company.com" /></label>
            <label>Password<input type="password" value={loginPassword} onChange={(event) => onLoginPasswordChange(event.target.value)} autoComplete="current-password" placeholder="Your password" /></label>
            <label>Authenticator code <small>Staff or accounts with MFA</small><input inputMode="numeric" value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" placeholder="6-digit code" /></label>
            <button type="submit" disabled={loginSubmitting}>{loginSubmitting ? "Signing in..." : "Sign in to Property Takeoff"}</button>
            <button type="button" className="account-access-link" onClick={() => setMode("forgot")}>Forgot your password?</button>
            <small>McKenna staff can continue using the existing shared-login credentials.</small>
          </form>
        ) : mode === "register" ? (
          <form className="account-access-form account-registration" onSubmit={(event) => submitAuth(event, onRegister, registration)}>
            <div><h2>{intent === "measure" ? "Get started with Basic." : intent === "quote" ? "Start your quote request." : "Create your company workspace."}</h2><p>{intent === "quote" ? "Next, outline your site for a quote. No subscription needed." : intent === "measure" ? "Next: secure checkout for Basic at $9.99/month. Membership unlocks measuring." : "Start free. Add Basic for $9.99/month when you want to measure."}</p></div>
            <label>Your name<input value={registration.displayName} onChange={(event) => updateRegistration("displayName", event.target.value)} autoComplete="name" placeholder="Alex Smith" /></label>
            <label>Company name<input value={registration.organizationName} onChange={(event) => updateRegistration("organizationName", event.target.value)} autoComplete="organization" placeholder="Evergreen Services" /></label>
            <label>Work email<input type="email" value={registration.email} onChange={(event) => updateRegistration("email", event.target.value)} autoComplete="email" placeholder="alex@company.com" /></label>
            <label>Password<input type="password" value={registration.password} onChange={(event) => updateRegistration("password", event.target.value)} autoComplete="new-password" placeholder="10+ characters with a number" /></label>
            {turnstileSiteKey ? <div ref={turnstileRef} className="account-access-turnstile" /> : null}
            <label className="account-access-consent"><input type="checkbox" checked={registration.acceptedTerms} onChange={(event) => updateRegistration("acceptedTerms", event.target.checked)} required /><span>I agree to the <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a>, <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy Policy</a>, and <a href="/acceptable-use.html" target="_blank" rel="noreferrer">Acceptable Use Policy</a>.</span></label>
            <button type="submit" disabled={registerSubmitting || !registration.acceptedTerms || (turnstileSiteKey && !registration.botToken)}>{registerSubmitting ? "Creating workspace..." : intent === "measure" ? "Create account & continue to checkout" : intent === "quote" ? "Create account & request quote" : "Create free account"}</button>
            <small>{intent === "measure" ? "You will not be charged until you confirm payment in Stripe." : "No card is required to create an account or request a managed takeoff quote."}</small>
          </form>
        ) : mode === "forgot" ? (
          <form className="account-access-form" onSubmit={async (event) => {
            event.preventDefault();
            setAccountWorking(true);
            try {
              await requestPasswordReset(recoveryEmail);
              setAccountMessage("If that account exists, a password-reset email is on its way.");
            } catch (error) {
              setAccountMessage(error?.message || "Password reset could not be requested.");
            } finally {
              setAccountWorking(false);
            }
          }}>
            <div><span>Account recovery</span><h2>Reset your password.</h2><p>We will send a short-lived recovery link to your work email.</p></div>
            <label>Work email<input type="email" value={recoveryEmail} onChange={(event) => setRecoveryEmail(event.target.value)} autoComplete="email" required /></label>
            <button type="submit" disabled={accountWorking}>{accountWorking ? "Sending..." : "Send reset link"}</button>
            <button type="button" className="account-access-link" onClick={() => setMode("login")}>Back to sign in</button>
          </form>
        ) : (
          <form className="account-access-form" onSubmit={async (event) => {
            event.preventDefault();
            setAccountWorking(true);
            try {
              const token = new URLSearchParams(window.location.search).get("reset");
              await resetPassword(token, newPassword);
              setAccountMessage("Password updated. Sign in with your new password.");
              setMode("login");
              window.history.replaceState({}, "", window.location.pathname);
            } catch (error) {
              setAccountMessage(error?.message || "Password reset failed.");
            } finally {
              setAccountWorking(false);
            }
          }}>
            <div><span>Choose a password</span><h2>Secure your account.</h2><p>Use at least 10 characters with a letter and a number.</p></div>
            <label>New password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required minLength={10} /></label>
            <button type="submit" disabled={accountWorking}>{accountWorking ? "Updating..." : "Update password"}</button>
          </form>
        )}
      </section>
  );

  return (
    <main className="account-access">
      <section className="account-access-story">
        <div className="account-access-brand">
          <img src="/logo.png" alt="McKenna Site Management" />
          <div><strong>Property Takeoff</strong><span>by McKenna Site Management</span></div>
          {compact && <nav aria-label="Account access">{[["login","Sign in"],["register","Create account"]].map(([tab,label]) =>
            <button key={tab} type="button" onClick={() => {
              setAccountMessage(""); setMode(tab); setAuthOpen(true);
            }}>{label}</button>)}</nav>}
        </div>
        <div className="account-access-copy">
          <div className="account-access-intro">
          <span className="account-access-kicker">Snow and landscape estimating</span>
          <h1>Measure confidently.<br /><em>Win the work.</em></h1>
          <p>Measure a map or plan yourself, or send a site to our takeoff team.</p>
          <button type="button" className="account-tour-trigger" onClick={() => window.location.assign("?tour=1")}>Take a tour <span aria-hidden="true">&rarr;</span></button>
          </div>
          <div className="account-access-example">
          <SiteComparison onStart={start} />
          <small className="field-study-terms">Self-service: $9.99/month. Managed: quoted per site, delivered within 24 hours of approval.</small>
          </div>
        </div>
      </section>

      {intent || (compact && authOpen) ? <PublicDialog title={intent === "measure" ? "Measure it myself" : intent === "quote" ? "Request a measured takeoff" : "Account access"}
        label={intent === "measure" ? "Measuring membership signup" : intent === "quote" ? "Takeoff quote signup" : "Account access"}
        busy={loginSubmitting || registerSubmitting} onClose={closeSignup}>{accountPanel}</PublicDialog> : !compact && accountPanel}
    </main>
  );
}

export default AccountAccess;
