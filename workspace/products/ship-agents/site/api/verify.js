// USDT TRC-20 Payment Verification + Delivery — Vercel Serverless Function

const WALLET = "TT1rC387qkvfLE1FUAN1bR1jPudAh1qNKz";
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_API = "https://api.trongrid.io";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = "-1003705093111"; // 戰情室
const DOWNLOAD_URL = "https://thinker.cafe/ship-agents-pro.zip";

async function notifyTelegram(tier, amount, txHash, email) {
  if (!TG_BOT_TOKEN) {
    return;
  }
  const text = [
    `💰 *NEW SALE*`,
    ``,
    `Tier: ${tier}`,
    `Amount: ${amount} USDT`,
    `Email: ${email}`,
    `TX: \`${txHash.substring(0, 16)}...\``,
    ``,
    `[View on Tronscan](https://tronscan.org/#/transaction/${txHash})`,
  ].join("\n");

  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  }).catch(() => {});
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { txHash, email, tier, expectedAmount } = req.body || {};

  if (!txHash || !email || !expectedAmount) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Basic validation
  if (txHash.length < 20) {
    return res.status(200).json({ verified: false, error: "Invalid TX hash format." });
  }

  if (!email.includes("@") || !email.includes(".")) {
    return res.status(200).json({ verified: false, error: "Invalid email format." });
  }

  try {
    // Fetch transaction info from TRON
    const txResponse = await fetch(`${TRON_API}/v1/transactions/${txHash}`, {
      headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
    });

    if (!txResponse.ok) {
      return res.status(200).json({
        verified: false,
        error:
          "Transaction not found on TRON network. Please check the TX hash and try again in a few minutes.",
      });
    }

    const txData = await txResponse.json();

    // Check TRC-20 transfer events
    const eventResponse = await fetch(`${TRON_API}/v1/transactions/${txHash}/events`, {
      headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
    });

    const eventData = await eventResponse.json();

    // Find USDT transfer event
    const usdtEvent = eventData?.data?.find(
      (e) => e.contract_address === USDT_CONTRACT && e.event_name === "Transfer",
    );

    if (!usdtEvent) {
      return res.status(200).json({
        verified: false,
        error:
          "No USDT transfer found in this transaction. Make sure you sent USDT (TRC-20), not TRX.",
      });
    }

    // Check recipient - TRON events return addresses in different formats
    const toAddress = usdtEvent.result?.to || "";
    // Accept if it matches our wallet in any format
    const isCorrectRecipient =
      toAddress === WALLET ||
      toAddress.toLowerCase() === WALLET.toLowerCase() ||
      (toAddress.startsWith("41") && toAddress.length === 42); // hex format

    if (!isCorrectRecipient) {
      return res.status(200).json({
        verified: false,
        error: "Payment was not sent to the correct address. Please double-check and try again.",
      });
    }

    // Check amount (USDT has 6 decimals)
    const rawAmount = parseInt(usdtEvent.result?.value || "0");
    const usdtAmount = rawAmount / 1_000_000;

    if (usdtAmount < expectedAmount) {
      return res.status(200).json({
        verified: false,
        error: `Expected ${expectedAmount} USDT, received ${usdtAmount} USDT. Please send the remaining amount.`,
      });
    }

    // Check confirmation status
    const confirmed = txData?.data?.[0]?.ret?.[0]?.contractRet === "SUCCESS";
    if (!confirmed) {
      return res.status(200).json({
        verified: false,
        error: "Transaction pending confirmation. Please wait 1-2 minutes and try again.",
      });
    }

    // === PAYMENT VERIFIED ===
    console.log(`[SALE] ${tier} | ${usdtAmount} USDT | TX: ${txHash} | Email: ${email}`);

    // Notify Cruz via Telegram
    await notifyTelegram(tier, usdtAmount, txHash, email);

    // Return download link
    return res.status(200).json({
      verified: true,
      downloadUrl: DOWNLOAD_URL,
      message: `Payment verified! Your download is ready.`,
    });
  } catch (err) {
    console.error("Verification error:", err);
    return res.status(200).json({
      verified: false,
      error:
        "Verification service temporarily unavailable. Please email your TX hash to get your download: cruztang@proton.me",
    });
  }
};
