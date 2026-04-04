import twilio from "twilio";

const accountSid = "ACd497847cca9a8d2f9d7e21815a43a7d9";
const authToken  = "384aafe5736f75b87607331e087480c4";

const client = twilio(accountSid, authToken);

// il tuo numero italiano (verificato su Twilio Trial)
const TO   = "+393534043794";

// il tuo numero Twilio (quello USA)
const FROM = "+15109013321";

// URL del tuo webhook IVR (quello del tunnel Cloudflare/ngrok)
const URL  = "https://emma-workforce-withdrawal-floppy.trycloudflare.com/voice/answer";

const call = await client.calls.create({
  to: TO,
  from: FROM,
  url: URL,        // Twilio chiederà TwiML a questo endpoint
  method: "POST"
});

console.log("Call SID:", call.sid);
