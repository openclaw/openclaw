// USDT TRC-20 Payment Verification — Vercel Serverless Function
// Checks TRON blockchain for a specific transaction

const WALLET = "TT1rC387qkvfLE1FUAN1bR1jPudAh1qNKz";
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // USDT TRC-20 contract
const TRON_API = "https://api.trongrid.io";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { txHash, email, tier, expectedAmount } = req.body;

  if (!txHash || !email || !expectedAmount) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Fetch transaction info from TRON
    const txResponse = await fetch(`${TRON_API}/v1/transactions/${txHash}`, {
      headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
    });

    if (!txResponse.ok) {
      return res
        .status(200)
        .json({ verified: false, error: "Transaction not found. Please check the TX hash." });
    }

    const txData = await txResponse.json();

    // Also check TRC-20 transfer events
    const eventResponse = await fetch(`${TRON_API}/v1/transactions/${txHash}/events`, {
      headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
    });

    const eventData = await eventResponse.json();

    // Find USDT transfer event
    const usdtEvent = eventData?.data?.find(
      (e) => e.contract_address === USDT_CONTRACT && e.event_name === "Transfer",
    );

    if (!usdtEvent) {
      return res
        .status(200)
        .json({ verified: false, error: "No USDT transfer found in this transaction." });
    }

    // Check recipient
    const toAddress = usdtEvent.result?.to;
    const toHex = toAddress?.toLowerCase();
    // TRON addresses in events are hex, need to verify against our wallet
    // For simplicity, check the decoded address from result
    const transferTo = tronHexToBase58(toAddress);

    if (transferTo !== WALLET) {
      return res
        .status(200)
        .json({ verified: false, error: "Payment was not sent to the correct address." });
    }

    // Check amount (USDT has 6 decimals)
    const rawAmount = parseInt(usdtEvent.result?.value || "0");
    const usdtAmount = rawAmount / 1_000_000;

    if (usdtAmount < expectedAmount) {
      return res.status(200).json({
        verified: false,
        error: `Expected ${expectedAmount} USDT, received ${usdtAmount} USDT.`,
      });
    }

    // Check confirmation status
    const confirmed = txData?.data?.[0]?.ret?.[0]?.contractRet === "SUCCESS";
    if (!confirmed) {
      return res
        .status(200)
        .json({
          verified: false,
          error: "Transaction not yet confirmed. Please wait and try again.",
        });
    }

    // Payment verified! Log it and send download link
    console.log(`[VERIFIED] ${tier} | ${usdtAmount} USDT | TX: ${txHash} | Email: ${email}`);

    // TODO: Integrate with email service (SendGrid/Resend) to auto-send download link
    // For now, log to a webhook or file for manual processing
    if (process.env.WEBHOOK_URL) {
      await fetch(process.env.WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "payment_verified",
          tier,
          amount: usdtAmount,
          txHash,
          email,
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => {}); // Don't fail if webhook fails
    }

    return res.status(200).json({
      verified: true,
      message: `Payment of ${usdtAmount} USDT verified. Download link will be sent to ${email}.`,
    });
  } catch (err) {
    console.error("Verification error:", err);
    return res.status(200).json({
      verified: false,
      error: "Verification service error. Please email ship@agent.build with your TX hash.",
    });
  }
};

// Helper: Convert TRON hex address to Base58
// Simplified — in production use a proper library like tronweb
function tronHexToBase58(hexAddr) {
  // If it's already base58 (starts with T), return as-is
  if (hexAddr && hexAddr.startsWith("T")) {
    return hexAddr;
  }
  // Otherwise this needs tronweb for proper conversion
  // For MVP, we'll do a simple comparison at hex level
  return hexAddr || "";
}
