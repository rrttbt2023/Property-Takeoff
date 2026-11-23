import { useEffect, useRef, useState } from "react";

import {
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from "../api";

import "./account-access.css";

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
  const [mode, setMode] = useState("login");
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
    const render = () => {
      if (!window.turnstile || !turnstileRef.current || turnstileRef.current.dataset.widgetId) return;
      const widgetId = window.turnstile.render(turnstileRef.current, {
        sitekey: turnstileSiteKey,
        callback: (token) => updateRegistration("botToken", token),
        "expired-callback": () => updateRegistration("botToken", ""),
      });
      turnstileRef.current.dataset.widgetId = String(widgetId);
    };
    const existing = document.querySelector('script[data-property-takeoff-turnstile="1"]');
    if (existing) {
      render();
      existing.addEventListener("load", render);
      return () => existing.removeEventListener("load", render);
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.propertyTakeoffTurnstile = "1";
    script.addEventListener("load", render);
    document.head.appendChild(script);
    return () => script.removeEventListener("load", render);
  }, [mode, turnstileSiteKey]);

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

  return (
    <main className="account-access">
      <section className="account-access-story">
        <div className="account-access-brand">
          <img src="/logo.png" alt="McKenna Site Management" />
          <div><strong>Property Takeoff</strong><span>by McKenna Site Management</span></div>
        </div>
        <div className="account-access-copy">
          <span className="account-access-kicker">Snow and landscape estimating</span>
          <h1>Measure confidently.<br />Quote the property.<br /><em>Win the work.</em></h1>
          <p>Build accurate map and plan takeoffs yourself, or send a site to our measurement team for delivery within 24 hours.</p>
          <div className="account-access-offers">
            <span><strong>$9.99</strong><small>per month for the measuring workspace</small></span>
            <span><strong>24 hr</strong><small>managed takeoff turnaround after quote approval</small></span>
          </div>
        </div>
      </section>

      <section className="account-access-panel">
        <div className="account-access-tabs" role="tablist">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create account</button>
        </div>

        {accountMessage ? <div className="account-access-message" role="status">{accountMessage}</div> : null}

        {mode === "login" ? (
          <form className="account-access-form" onSubmit={(event) => onLogin(event, { mfaCode })}>
            <div><span>Welcome back</span><h2>Open your project workspace.</h2><p>Your projects, folders, billing, and measurement requests stay together.</p></div>
            <label>Email or username<input value={loginUsername} onChange={(event) => onLoginUsernameChange(event.target.value)} autoComplete="username" placeholder="you@company.com" /></label>
            <label>Password<input type="password" value={loginPassword} onChange={(event) => onLoginPasswordChange(event.target.value)} autoComplete="current-password" placeholder="Your password" /></label>
            <label>Authenticator code <small>Staff or accounts with MFA</small><input inputMode="numeric" value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" placeholder="6-digit code" /></label>
            <button type="submit" disabled={loginSubmitting}>{loginSubmitting ? "Signing in..." : "Sign in to Property Takeoff"}</button>
            <button type="button" className="account-access-link" onClick={() => setMode("forgot")}>Forgot your password?</button>
            <small>McKenna staff can continue using the existing shared-login credentials.</small>
          </form>
        ) : mode === "register" ? (
          <form className="account-access-form" onSubmit={(event) => onRegister(event, registration)}>
            <div><span>Start measuring</span><h2>Create your company workspace.</h2><p>Registration is free. Choose the $9.99 Basic plan when you are ready to use the measuring tools.</p></div>
            <label>Your name<input value={registration.displayName} onChange={(event) => updateRegistration("displayName", event.target.value)} autoComplete="name" placeholder="Alex Smith" /></label>
            <label>Company name<input value={registration.organizationName} onChange={(event) => updateRegistration("organizationName", event.target.value)} autoComplete="organization" placeholder="Evergreen Services" /></label>
            <label>Work email<input type="email" value={registration.email} onChange={(event) => updateRegistration("email", event.target.value)} autoComplete="email" placeholder="alex@company.com" /></label>
            <label>Password<input type="password" value={registration.password} onChange={(event) => updateRegistration("password", event.target.value)} autoComplete="new-password" placeholder="10+ characters with a number" /></label>
            {turnstileSiteKey ? <div ref={turnstileRef} className="account-access-turnstile" /> : null}
            <label className="account-access-consent"><input type="checkbox" checked={registration.acceptedTerms} onChange={(event) => updateRegistration("acceptedTerms", event.target.checked)} required /><span>I agree to the <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a>, <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy Policy</a>, and <a href="/acceptable-use.html" target="_blank" rel="noreferrer">Acceptable Use Policy</a>.</span></label>
            <button type="submit" disabled={registerSubmitting || !registration.acceptedTerms || (turnstileSiteKey && !registration.botToken)}>{registerSubmitting ? "Creating workspace..." : "Create free account"}</button>
            <small>No card is required to create an account or request a managed takeoff quote.</small>
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
    </main>
  );
}

export default AccountAccess;
