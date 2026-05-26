"use client";

import { useEffect, useState } from "react";

type ResultState = {
  data: unknown | null;
  error: string | null;
  loading: boolean;
};

const defaultState: ResultState = { data: null, error: null, loading: false };

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export default function ApmtPage() {
  const [identity, setIdentity] = useState("Assistant");
  const [facilityCode, setFacilityCode] = useState("");
  const [assetId, setAssetId] = useState("");
  const [emptyState, setEmptyState] = useState<ResultState>(defaultState);
  const [bookingState, setBookingState] = useState<ResultState>(defaultState);

  useEffect(() => {
    fetch("/api/chat/identity", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("identity unavailable"))))
      .then((data) => typeof data?.name === "string" && setIdentity(data.name))
      .catch(() => setIdentity("Assistant"));
  }, []);

  async function runLookup(endpoint: string, setState: (s: ResultState) => void) {
    setState({ data: null, error: null, loading: true });
    try {
      const params = new URLSearchParams({ facilityCode, assetId });
      const res = await fetch(`/api/apmt/${endpoint}?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Request failed");
      setState({ data, error: null, loading: false });
    } catch (err) {
      setState({ data: null, error: err instanceof Error ? err.message : "Request failed", loading: false });
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto flex h-screen max-w-5xl flex-col px-4 py-8 md:px-8">
        <header className="mb-6 flex flex-col gap-1 border-b border-white/10 pb-4">
          <p className="text-sm uppercase tracking-[0.3em] text-emerald-300">{identity} · APMT Console</p>
          <h1 className="text-3xl font-semibold text-white">APMT Track & Trace</h1>
          <p className="text-sm text-slate-400">Lookup empty returns and booking enquiries.</p>
        </header>

        <div className="rounded-3xl border border-white/5 bg-white/5 p-4 backdrop-blur">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-slate-200">
              Facility Code
              <input
                className="rounded-xl border border-white/10 bg-slate-950/60 px-4 py-2 text-white"
                placeholder="USLAX"
                value={facilityCode}
                onChange={(e) => setFacilityCode(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-200">
              Asset ID(s)
              <input
                className="rounded-xl border border-white/10 bg-slate-950/60 px-4 py-2 text-white"
                placeholder="MRKU7137914"
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950"
              onClick={() => runLookup("empty-returns", setEmptyState)}
              disabled={!facilityCode || !assetId || emptyState.loading}
            >
              {emptyState.loading ? "Loading…" : "Empty Returns"}
            </button>
            <button
              className="rounded-full border border-emerald-400 px-4 py-2 text-sm font-semibold text-emerald-300"
              onClick={() => runLookup("booking-enquiry", setBookingState)}
              disabled={!facilityCode || !assetId || bookingState.loading}
            >
              {bookingState.loading ? "Loading…" : "Booking Enquiry"}
            </button>
            <a className="text-xs text-slate-400 underline" href="/">
              Back to chat
            </a>
          </div>
        </div>

        <div className="mt-6 grid flex-1 gap-4 overflow-y-auto md:grid-cols-2">
          <section className="rounded-3xl border border-white/5 bg-slate-900/60 p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-200">Empty Returns</h2>
            {emptyState.error && <p className="text-sm text-rose-300">{emptyState.error}</p>}
            {emptyState.data !== null && (
              <pre className="whitespace-pre-wrap text-xs text-white/90">{pretty(emptyState.data)}</pre>
            )}
          </section>
          <section className="rounded-3xl border border-white/5 bg-slate-900/60 p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-200">Booking Enquiry</h2>
            {bookingState.error && <p className="text-sm text-rose-300">{bookingState.error}</p>}
            {bookingState.data !== null && (
              <pre className="whitespace-pre-wrap text-xs text-white/90">{pretty(bookingState.data)}</pre>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
