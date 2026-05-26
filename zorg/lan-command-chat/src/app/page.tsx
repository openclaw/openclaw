"use client";

import { FormEvent, useEffect, useState } from "react";

type IdentityPayload = { name?: string };

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export default function LoginPage() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [identity, setIdentity] = useState("Assistant");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const savedTheme = localStorage.getItem("lan-chat:theme");
    setTheme(savedTheme === "dark" ? "dark" : "light");
    fetch("/api/chat/identity", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("identity unavailable"))))
      .then((data: IdentityPayload) => setIdentity(data.name || "Assistant"))
      .catch(() => setIdentity("Assistant"));
  }, []);

  useEffect(() => {
    localStorage.setItem("lan-chat:theme", theme);
  }, [theme]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Login failed");
      }
      window.location.href = "/chat";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={cx("console-shell", "login-shell", `theme-${theme}`)}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <section className="panel gauge-panel login-card" aria-label="LAN command chat login">
        <div className="login-head">
          <p className="eyebrow">LAN command chat</p>
          <h1>{identity}</h1>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="lan-chat-password">Password</label>
          <input
            id="lan-chat-password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter password"
            type="password"
          />
          {error ? <p className="login-error">{error}</p> : null}
          <button className="primary" disabled={busy || !password.trim()} type="submit">{busy ? "Checking…" : "Login"}</button>
        </form>
        <button className="ghost login-theme" onClick={() => setTheme((value) => (value === "light" ? "dark" : "light"))} type="button">
          {theme === "light" ? "Dark" : "Light"} mode
        </button>
      </section>
    </main>
  );
}
