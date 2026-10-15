import { useState } from "react";

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
  const [registration, setRegistration] = useState({
    displayName: "",
    organizationName: "",
    email: "",
    password: "",
  });

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

        {mode === "login" ? (
          <form className="account-access-form" onSubmit={onLogin}>
            <div><span>Welcome back</span><h2>Open your project workspace.</h2><p>Your projects, folders, billing, and measurement requests stay together.</p></div>
            <label>Email or username<input value={loginUsername} onChange={(event) => onLoginUsernameChange(event.target.value)} autoComplete="username" placeholder="you@company.com" /></label>
            <label>Password<input type="password" value={loginPassword} onChange={(event) => onLoginPasswordChange(event.target.value)} autoComplete="current-password" placeholder="Your password" /></label>
            <button type="submit" disabled={loginSubmitting}>{loginSubmitting ? "Signing in..." : "Sign in to Property Takeoff"}</button>
            <small>McKenna staff can continue using the existing shared-login credentials.</small>
          </form>
        ) : (
          <form className="account-access-form" onSubmit={(event) => onRegister(event, registration)}>
            <div><span>Start measuring</span><h2>Create your company workspace.</h2><p>Registration is free. Choose the $9.99 Basic plan when you are ready to use the measuring tools.</p></div>
            <label>Your name<input value={registration.displayName} onChange={(event) => updateRegistration("displayName", event.target.value)} autoComplete="name" placeholder="Alex Smith" /></label>
            <label>Company name<input value={registration.organizationName} onChange={(event) => updateRegistration("organizationName", event.target.value)} autoComplete="organization" placeholder="Evergreen Services" /></label>
            <label>Work email<input type="email" value={registration.email} onChange={(event) => updateRegistration("email", event.target.value)} autoComplete="email" placeholder="alex@company.com" /></label>
            <label>Password<input type="password" value={registration.password} onChange={(event) => updateRegistration("password", event.target.value)} autoComplete="new-password" placeholder="10+ characters with a number" /></label>
            <button type="submit" disabled={registerSubmitting}>{registerSubmitting ? "Creating workspace..." : "Create free account"}</button>
            <small>No card is required to create an account or request a managed takeoff quote.</small>
          </form>
        )}
      </section>
    </main>
  );
}

export default AccountAccess;
